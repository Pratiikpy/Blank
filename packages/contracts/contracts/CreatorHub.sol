// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title CreatorHub — Encrypted creator tipping with tier badges
/// @notice Support creators with encrypted amounts. Supporters earn tier badges
///         (Bronze/Silver/Gold) based on encrypted threshold checks.
///
/// @dev Tier thresholds are plaintext (public knowledge). Cumulative contributions
///      are encrypted. Tier check returns ebool that only the supporter can unseal.
///      Totals are kept per vault so tips in different tokens are never summed.
///      The pre-upgrade mixed-token totals (totalEarnings, _contributions) are
///      frozen and no longer read.
///
///      Privacy: no handle granted to the creator carries a single tip. The
///      creator can decrypt only the running per-vault total (getMyEarningsIn).
///      Residual: the vault credits the creator's own balance on every tip, so
///      a creator who decrypts that balance after each tip can still infer the
///      individual amount. The tipper's address is public by design.
///
///      Funding gate: the vault moves 0 (no revert) when the tipper is short,
///      so a tip is only counted once it is proven non-zero. support() records
///      a Pending tip with a public ebool; confirmFunding() publishes its
///      decryption and then either counts the supporter (supporterCount,
///      supporter list, tier access, Supported events) or voids the tip.
///      The encrypted totals update immediately because adding 0 is harmless.
contract CreatorHub is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ──────────────────────────────────────────────────────────

    struct CreatorProfile {
        string name;
        string bio;
        uint64 tier1Threshold;   // Bronze — plaintext (public tier levels)
        uint64 tier2Threshold;   // Silver
        uint64 tier3Threshold;   // Gold
        euint64 totalEarnings;   // Encrypted total — only creator sees
        uint256 supporterCount;  // Public count
        bool active;
    }

    enum TipStatus { None, Pending, Confirmed, Voided }

    struct PendingTip {
        address supporter;
        address creator;
        address vault;
        TipStatus status;
        ebool funded;
        euint64 moved;
        string message;
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;

    mapping(address => CreatorProfile) private _profiles;
    mapping(address => bool) public hasProfile;

    /// @dev creator → supporter → encrypted cumulative contribution
    mapping(address => mapping(address => euint64)) private _contributions;
    /// @dev creator → supporter → whether they've ever contributed (for counting)
    mapping(address => mapping(address => bool)) private _hasContributed;

    /// @dev Reverse lookup: supporter → list of creators they support
    mapping(address => address[]) private _supportedCreators;

    // ─── Events ─────────────────────────────────────────────────────────

    event ProfileCreated(address indexed creator, string name, uint256 timestamp);
    event ProfileUpdated(address indexed creator, uint256 timestamp);
    event Supported(address indexed supporter, address indexed creator, string message, uint256 timestamp);
    event SupportedIn(address indexed supporter, address indexed creator, address indexed vault, euint64 moved);
    event TokenRegistrySet(address indexed registry);
    /// @notice A tip is waiting for confirmFunding. Decrypt `funded` (public)
    ///         off-chain and pass the result and signature to confirmFunding.
    event TipPending(uint256 indexed tipId, address indexed supporter, address indexed creator, address vault, ebool funded);
    /// @notice The vault moved nothing for this tip; it was not counted.
    event TipVoided(uint256 indexed tipId, address indexed supporter, address indexed creator);

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Creator Profile ────────────────────────────────────────────────

    /// @notice Create or update a creator profile.
    /// @param name Display name
    /// @param bio Short bio
    /// @param tier1 Bronze threshold (in token smallest units, e.g., 10_000_000 = 10 USDC)
    /// @param tier2 Silver threshold
    /// @param tier3 Gold threshold
    function setProfile(
        string calldata name,
        string calldata bio,
        uint64 tier1,
        uint64 tier2,
        uint64 tier3
    ) external nonReentrant {
        require(bytes(name).length > 0, "CreatorHub: empty name");
        require(tier1 < tier2 && tier2 < tier3, "CreatorHub: tiers must be ascending");

        bool isNew = !hasProfile[msg.sender];

        if (isNew) {
            _profiles[msg.sender].totalEarnings = FHE.asEuint64(0);
            FHE.allowThis(_profiles[msg.sender].totalEarnings);
            FHE.allowSender(_profiles[msg.sender].totalEarnings);
            hasProfile[msg.sender] = true;
        }

        _profiles[msg.sender].name = name;
        _profiles[msg.sender].bio = bio;
        _profiles[msg.sender].tier1Threshold = tier1;
        _profiles[msg.sender].tier2Threshold = tier2;
        _profiles[msg.sender].tier3Threshold = tier3;
        _profiles[msg.sender].active = true;

        if (isNew) {
            emit ProfileCreated(msg.sender, name, block.timestamp);
        } else {
            emit ProfileUpdated(msg.sender, block.timestamp);
        }
    }

    // ─── Support a Creator ──────────────────────────────────────────────

    /// @notice Support a creator with an encrypted amount. The amount is
    ///         hidden from everyone but the tipper; the creator can read only
    ///         the running total. The tip does not count (supporter list,
    ///         supporterCount, tier access, Supported event) until
    ///         confirmFunding proves the vault actually moved funds.
    /// @param creator Creator's address
    /// @param vault FHERC20Vault for the token
    /// @param encAmount Encrypted tip amount
    /// @param message Public support message
    /// @return tipId Id to pass to confirmFunding
    function support(
        address creator,
        address vault,
        externalEuint64 encAmount, bytes calldata proof,
        string calldata message
    ) external nonReentrant returns (uint256 tipId) {
        require(hasProfile[creator], "CreatorHub: no profile");
        require(_profiles[creator].active, "CreatorHub: inactive");
        require(creator != msg.sender, "CreatorHub: cannot self-tip");
        _requireAllowedVault(vault);

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 amount = FHE.asEuint64(encAmount, proof);

        // Credit what the vault moved, not what was requested: the vault
        // moves 0 on a short balance.
        euint64 moved = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vault).transferFromVerified(msg.sender, creator, FHE.shareEuint64(amount, vault)),
            vault
        );
        FHE.allowThis(moved);
        FHE.allowSender(moved);

        euint64 earned = _addNoWrap(_earningsByVault[creator][vault], moved);
        _earningsByVault[creator][vault] = earned;
        FHE.allowThis(earned);
        FHE.allow(earned, creator);

        euint64 given = _addNoWrap(_contributionsByVault[creator][msg.sender][vault], moved);
        _contributionsByVault[creator][msg.sender][vault] = given;
        FHE.allowThis(given);
        FHE.allowSender(given);

        ebool funded = FHE.gt(moved, FHE.asEuint64(0));
        FHE.allowThis(funded);
        FHE.allowPublic(funded);

        tipId = nextTipId++;
        PendingTip storage t = _tips[tipId];
        t.supporter = msg.sender;
        t.creator = creator;
        t.vault = vault;
        t.funded = funded;
        t.moved = moved;
        t.message = message;
        t.status = TipStatus.Pending;

        emit TipPending(tipId, msg.sender, creator, vault, funded);
    }

    /// @notice Settle a pending tip (step 2 of 2). Anyone may call with the
    ///         Threshold Network decryption of getTipFundedHandle(tipId).
    ///         true: the supporter is counted and Supported fires.
    ///         false: nothing moved, the tip is voided.
    function confirmFunding(uint256 tipId, bool fundedPlaintext, bytes calldata signature) external nonReentrant {
        PendingTip storage t = _tips[tipId];
        require(t.status == TipStatus.Pending, "CreatorHub: tip not pending");

        // Publish only if nobody has yet, so a second publish cannot revert.
        (bool funded, bool ready) = FHE.getDecryptResultSafe(t.funded);
        if (!ready) {
            FHE.publishDecryptResult(t.funded, fundedPlaintext, signature);
            (funded, ready) = FHE.getDecryptResultSafe(t.funded);
        }
        require(ready, "CreatorHub: decryption not ready");

        address supporter = t.supporter;
        address creator = t.creator;
        string memory message = t.message;
        delete t.message;

        if (!funded) {
            t.status = TipStatus.Voided;
            emit TipVoided(tipId, supporter, creator);
            return;
        }

        t.status = TipStatus.Confirmed;
        if (!_hasContributed[creator][supporter]) {
            _hasContributed[creator][supporter] = true;
            _profiles[creator].supporterCount++;
            _supportedCreators[supporter].push(creator);
        }

        emit Supported(supporter, creator, message, block.timestamp);
        emit SupportedIn(supporter, creator, t.vault, t.moved);
        try eventHub.emitActivity(supporter, creator, "tip", message, 0) {} catch {}
    }

    /// @notice The public ebool "the vault moved a non-zero amount" for a tip.
    function getTipFundedHandle(uint256 tipId) external view returns (ebool) {
        return _tips[tipId].funded;
    }

    /// @notice Public state of a tip (no amounts, no message).
    function getTip(uint256 tipId) external view returns (
        address supporter,
        address creator,
        address vault,
        TipStatus status
    ) {
        PendingTip storage t = _tips[tipId];
        return (t.supporter, t.creator, t.vault, t.status);
    }

    // ─── Tier Checks ────────────────────────────────────────────────────

    /// @notice Check your tier for a creator in one token. Computes encrypted
    ///         comparisons against your total given through `vault`.
    ///         Returns 3 encrypted booleans; unseal with a permit.
    ///         NOT a view function because FHE operations submit CoFHE tasks.
    ///         Open only to supporters whose first tip was confirmed.
    /// @return bronze Whether contribution >= tier1
    /// @return silver Whether contribution >= tier2
    /// @return gold Whether contribution >= tier3
    function checkMyTierIn(address creator, address vault) external returns (
        ebool bronze,
        ebool silver,
        ebool gold
    ) {
        require(_hasContributed[creator][msg.sender], "CreatorHub: not a supporter");

        CreatorProfile storage p = _profiles[creator];
        euint64 contrib = _contributionsByVault[creator][msg.sender][vault];

        euint64 t1 = FHE.asEuint64(p.tier1Threshold);
        euint64 t2 = FHE.asEuint64(p.tier2Threshold);
        euint64 t3 = FHE.asEuint64(p.tier3Threshold);

        bronze = FHE.gte(contrib, t1);
        silver = FHE.gte(contrib, t2);
        gold = FHE.gte(contrib, t3);

        // Allow supporter to unseal results
        FHE.allowSender(bronze);
        FHE.allowSender(silver);
        FHE.allowSender(gold);
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get creator's public profile info
    function getProfile(address creator) external view returns (
        string memory name,
        string memory bio,
        uint64 tier1,
        uint64 tier2,
        uint64 tier3,
        uint256 supporterCount,
        bool active
    ) {
        CreatorProfile storage p = _profiles[creator];
        return (p.name, p.bio, p.tier1Threshold, p.tier2Threshold, p.tier3Threshold, p.supporterCount, p.active);
    }

    /// @notice Your encrypted total given to a creator through one vault.
    function getMyContributionIn(address creator, address vault) external view returns (euint64) {
        require(_hasContributed[creator][msg.sender], "CreatorHub: not a supporter");
        return _contributionsByVault[creator][msg.sender][vault];
    }

    /// @notice Creator's encrypted earnings through one vault (only creator can unseal).
    function getMyEarningsIn(address vault) external view returns (euint64) {
        require(hasProfile[msg.sender], "CreatorHub: no profile");
        return _earningsByVault[msg.sender][vault];
    }

    /// @notice Get all creators a supporter has contributed to
    function getSupportedCreators(address supporter) external view returns (address[] memory) {
        return _supportedCreators[supporter];
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        require(_eventHub.code.length > 0, "CreatorHub: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "CreatorHub: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    function _requireAllowedVault(address vault) internal view {
        require(
            address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault),
            "CreatorHub: vault not allowed"
        );
    }

    /// @dev a + b, or a unchanged if the sum would wrap.
    function _addNoWrap(euint64 a, euint64 b) internal returns (euint64) {
        euint64 sum = FHE.add(a, b);
        return FHE.select(FHE.gte(sum, a), sum, a);
    }

    // ─── Appended storage (UUPS) ────────────────────────────────────────

    /// @dev creator => vault => encrypted earnings in that token.
    mapping(address => mapping(address => euint64)) private _earningsByVault;
    /// @dev creator => supporter => vault => encrypted cumulative contribution.
    mapping(address => mapping(address => mapping(address => euint64))) private _contributionsByVault;
    ITokenRegistry public tokenRegistry;
    /// @dev Next id for support() records. Appended.
    uint256 public nextTipId;
    /// @dev tipId => tip awaiting or past confirmFunding. Appended.
    mapping(uint256 => PendingTip) private _tips;

    /// @dev Reserved storage. Shrink by 1 for each slot appended above.
    uint256[45] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
