// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title CreatorHub — Encrypted creator tipping with tier badges
/// @notice Support creators with encrypted amounts. Nobody sees how much you gave —
///         not even the creator. Supporters earn tier badges (Bronze/Silver/Gold)
///         based on encrypted threshold checks.
///
/// @dev Tier thresholds are plaintext (public knowledge). Cumulative contributions
///      are encrypted. Tier check returns ebool that only the supporter can unseal.
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
            FHE.allow(_profiles[msg.sender].totalEarnings, msg.sender);
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

    /// @notice Support a creator with an encrypted amount.
    ///         Amount is hidden from everyone — even the creator doesn't see individual contributions.
    /// @param creator Creator's address
    /// @param vault FHERC20Vault for the token
    /// @param encAmount Encrypted tip amount
    /// @param message Public support message
    function support(
        address creator,
        address vault,
        InEuint64 memory encAmount,
        string calldata message
    ) external nonReentrant {
        require(hasProfile[creator], "CreatorHub: no profile");
        require(_profiles[creator].active, "CreatorHub: inactive");
        require(creator != msg.sender, "CreatorHub: cannot self-tip");

        // Transfer tokens from supporter to creator
        IFHERC20Vault(vault).transferFrom(msg.sender, creator, encAmount);

        euint64 amount = FHE.asEuint64(encAmount);

        // Update creator's encrypted total earnings
        _profiles[creator].totalEarnings = FHE.add(_profiles[creator].totalEarnings, amount);
        FHE.allowThis(_profiles[creator].totalEarnings);
        FHE.allow(_profiles[creator].totalEarnings, creator);

        // Initialize contribution if first time
        if (!_hasContributed[creator][msg.sender]) {
            _contributions[creator][msg.sender] = FHE.asEuint64(0);
            FHE.allowThis(_contributions[creator][msg.sender]);
            _hasContributed[creator][msg.sender] = true;
            _profiles[creator].supporterCount++;
            _supportedCreators[msg.sender].push(creator);
        }

        // Update supporter's encrypted cumulative contribution
        _contributions[creator][msg.sender] = FHE.add(_contributions[creator][msg.sender], amount);
        FHE.allowThis(_contributions[creator][msg.sender]);
        FHE.allow(_contributions[creator][msg.sender], msg.sender);

        emit Supported(msg.sender, creator, message, block.timestamp);
        try eventHub.emitActivity(msg.sender, creator, "tip", message, 0) {} catch {}
    }

    // ─── Tier Checks ────────────────────────────────────────────────────

    /// @notice Check your tier for a creator. Computes encrypted comparisons.
    ///         Returns 3 encrypted booleans — unseal with permit to see which tiers you've reached.
    ///         NOT a view function because FHE operations submit CoFHE tasks.
    /// @return bronze Whether contribution >= tier1
    /// @return silver Whether contribution >= tier2
    /// @return gold Whether contribution >= tier3
    function checkMyTier(address creator) external returns (
        ebool bronze,
        ebool silver,
        ebool gold
    ) {
        require(_hasContributed[creator][msg.sender], "CreatorHub: not a supporter");

        CreatorProfile storage p = _profiles[creator];
        euint64 contrib = _contributions[creator][msg.sender];

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

    /// @notice Get your encrypted total contribution to a creator (unseal with permit)
    function getMyContribution(address creator) external view returns (euint64) {
        require(_hasContributed[creator][msg.sender], "CreatorHub: not a supporter");
        return _contributions[creator][msg.sender];
    }

    /// @notice Get creator's encrypted total earnings (only creator can unseal)
    function getMyEarnings() external view returns (euint64) {
        require(hasProfile[msg.sender], "CreatorHub: no profile");
        return _profiles[msg.sender].totalEarnings;
    }

    /// @notice Get all creators a supporter has contributed to
    function getSupportedCreators(address supporter) external view returns (address[] memory) {
        return _supportedCreators[supporter];
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
