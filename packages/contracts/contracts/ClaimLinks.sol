// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transferVerified(address to, euint64 amount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, euint64 amount) external;
    function bumpGlobal(euint64 amount) external;
}

/// @title ClaimLinks — encrypted send-by-link with three security modes
/// @notice Sender locks an encrypted amount + a secret hash. Recipient claims
///         by presenting the secret in the URL fragment. Funds stay encrypted
///         the whole time. The euint64 handle stays parked in this contract
///         until claim succeeds, then FHE.allow grants decrypt rights to the
///         claimer only.
///
/// @dev Three modes:
///      1. Bearer       — anyone with the URL can claim. Lowest friction.
///      2. EmailBound   — URL + email second factor. Default.
///      3. AddressBound — URL + caller must equal a fixed ENS/address.
///
///      Hash construction uses a versioned domain separator
///      ("BLANK_CLAIM_v1") so leaked secrets cannot be replayed across
///      contexts and rainbow-tables on email hashes are scoped.
///
///      Sender must `approvePlaintext(ClaimLinks, type(uint64).max)` on the
///      vault before creating links.
///
///      One-shot: claimed/refunded links cannot be reused.
contract ClaimLinks is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Domain separator (versioned hash scheme) ─────────────────────────

    bytes32 public constant DOMAIN = keccak256("BLANK_CLAIM_v1");

    // ─── Types ────────────────────────────────────────────────────────────

    enum LinkMode { Bearer, EmailBound, AddressBound }

    /// @dev Upper bound on per-link expiry. Prevents `type(uint256).max` shenanigans
    /// and makes "infinite" links impossible. Senders pass a value <= this OR pass
    /// 0 to use defaultExpirySeconds. Constant (no storage slot).
    uint256 public constant MAX_EXPIRY_SECONDS = 365 days;

    struct ClaimLink {
        address sender;
        address vault;
        euint64 encAmount;
        bytes32 secretHash;       // keccak256(DOMAIN, mode, secret, [emailHash])
        address boundAddress;     // 0x0 unless AddressBound
        LinkMode mode;
        uint256 createdAt;
        uint256 expiryTimestamp;  // sender can refund after this
        bool claimed;
        bool refunded;
        string note;
        address claimer;          // 0x0 until claimed
        uint256 claimedAt;
    }

    // ─── State ────────────────────────────────────────────────────────────

    IEventHub public eventHub;
    address public paymentReceipts;

    uint256 public nextLinkId;
    mapping(uint256 => ClaimLink) private _links;

    /// @dev Reverse lookups
    mapping(address => uint256[]) private _sentLinks;
    mapping(address => uint256[]) private _receivedLinks;

    /// @dev Default refund grace period if sender passes 0 for expiry.
    ///      Sender can override per-link. Owner can change the default.
    uint256 public defaultExpirySeconds;

    // ─── Events ───────────────────────────────────────────────────────────

    event LinkCreated(
        uint256 indexed linkId,
        address indexed sender,
        address vault,
        LinkMode mode,
        address indexed boundAddress,
        uint256 expiryTimestamp,
        string note
    );

    event LinkClaimed(
        uint256 indexed linkId,
        address indexed claimer,
        uint256 timestamp
    );

    event LinkRefunded(
        uint256 indexed linkId,
        address indexed sender,
        uint256 timestamp
    );

    /// @notice §2.6 of BEST_VERSION_FULL_PLAN: emitted when paymentReceipts
    /// bump call reverts. kind is "user" or "global". Indexer can detect +
    /// replay the missing bump.
    event ReceiptsBumpFailed(string kind, bytes reason);

    // ─── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
        defaultExpirySeconds = 7 days;
    }

    // ─── Create Link ──────────────────────────────────────────────────────

    /// @notice Create a claim link.
    ///
    /// @param vault            FHERC20Vault address for the token.
    /// @param encAmount        Encrypted amount, locked into this contract.
    /// @param secretHash       Pre-computed off-chain:
    ///                         - Bearer:       keccak256(DOMAIN, 0x00, secret)
    ///                         - EmailBound:   keccak256(DOMAIN, 0x01, secret, keccak256(email))
    ///                         - AddressBound: keccak256(DOMAIN, 0x02, secret)
    /// @param mode             Bearer / EmailBound / AddressBound.
    /// @param boundAddress     Required for AddressBound; ignored otherwise.
    /// @param expirySeconds    0 = use defaultExpirySeconds. Otherwise seconds-from-now.
    /// @param note             Public note attached to the link.
    /// @return linkId          Stored ID.
    function createLink(
        address vault,
        InEuint64 calldata encAmount,
        bytes32 secretHash,
        LinkMode mode,
        address boundAddress,
        uint256 expirySeconds,
        string calldata note
    ) external nonReentrant returns (uint256 linkId) {
        require(secretHash != bytes32(0), "ClaimLinks: empty secret hash");
        if (mode == LinkMode.AddressBound) {
            require(boundAddress != address(0), "ClaimLinks: bound address required");
        }
        require(
            expirySeconds == 0 || expirySeconds <= MAX_EXPIRY_SECONDS,
            "ClaimLinks: expiry too long (max 365 days)"
        );

        uint256 expiry = block.timestamp + (expirySeconds == 0 ? defaultExpirySeconds : expirySeconds);

        // Verify input here (msg.sender = sender) before cross-contract call
        euint64 verified = FHE.asEuint64(encAmount);
        FHE.allowTransient(verified, vault);

        // Move funds from sender into this contract's vault balance
        euint64 locked = IFHERC20Vault(vault).transferFromVerified(msg.sender, address(this), verified);

        // §2.1 privacy posture: only this contract retains decrypt rights
        // on the locked handle. Sender does NOT get allowSender(locked).
        // Rationale: CoFHE has no revoke primitive, so granting at create
        // would leave the sender able to publish a decrypt proof of the
        // claim amount permanently after the recipient claims. The sender
        // already knows the plaintext at create (they encrypted it), so
        // dropping the on-chain allowance costs them nothing they can't
        // reconstruct from local state. At refund, the vault's
        // transferVerified produces a fresh handle that the sender (now
        // the recipient of the refund) is allowed on by the vault.
        FHE.allowThis(locked);

        linkId = nextLinkId++;
        _links[linkId] = ClaimLink({
            sender: msg.sender,
            vault: vault,
            encAmount: locked,
            secretHash: secretHash,
            boundAddress: boundAddress,
            mode: mode,
            createdAt: block.timestamp,
            expiryTimestamp: expiry,
            claimed: false,
            refunded: false,
            note: note,
            claimer: address(0),
            claimedAt: 0
        });

        _sentLinks[msg.sender].push(linkId);

        emit LinkCreated(linkId, msg.sender, vault, mode, boundAddress, expiry, note);
        try eventHub.emitActivity(msg.sender, address(0), "claim_link_created", note, linkId) {} catch {}
    }

    // ─── Claim ────────────────────────────────────────────────────────────

    /// @notice Claim a Bearer link. Anyone with `secret` can call.
    function claimBearer(uint256 linkId, bytes32 secret) external nonReentrant {
        ClaimLink storage link = _claimable(linkId, LinkMode.Bearer);
        bytes32 expected = keccak256(abi.encodePacked(DOMAIN, uint8(LinkMode.Bearer), secret));
        require(expected == link.secretHash, "ClaimLinks: bad secret");
        _release(linkId, link, msg.sender);
    }

    /// @notice Claim an EmailBound link. Caller must present `secret` and `emailHash`.
    ///         emailHash is computed CLIENT-SIDE as keccak256(lowercase(email)).
    ///         The server never sees the email or its hash unmodified — it's hashed
    ///         locally before being sent to the chain.
    function claimEmailBound(uint256 linkId, bytes32 secret, bytes32 emailHash) external nonReentrant {
        ClaimLink storage link = _claimable(linkId, LinkMode.EmailBound);
        bytes32 expected = keccak256(abi.encodePacked(DOMAIN, uint8(LinkMode.EmailBound), secret, emailHash));
        require(expected == link.secretHash, "ClaimLinks: bad secret/email");
        _release(linkId, link, msg.sender);
    }

    /// @notice Claim an AddressBound link. msg.sender must equal boundAddress
    ///         AND `secret` must hash correctly.
    function claimAddressBound(uint256 linkId, bytes32 secret) external nonReentrant {
        ClaimLink storage link = _claimable(linkId, LinkMode.AddressBound);
        require(msg.sender == link.boundAddress, "ClaimLinks: not bound address");
        bytes32 expected = keccak256(abi.encodePacked(DOMAIN, uint8(LinkMode.AddressBound), secret));
        require(expected == link.secretHash, "ClaimLinks: bad secret");
        _release(linkId, link, msg.sender);
    }

    function _claimable(uint256 linkId, LinkMode expectedMode) internal view returns (ClaimLink storage link) {
        link = _links[linkId];
        require(link.sender != address(0), "ClaimLinks: no such link");
        require(!link.claimed, "ClaimLinks: already claimed");
        require(!link.refunded, "ClaimLinks: refunded");
        require(block.timestamp < link.expiryTimestamp, "ClaimLinks: expired");
        require(link.mode == expectedMode, "ClaimLinks: wrong mode");
    }

    function _release(uint256 linkId, ClaimLink storage link, address claimer) internal {
        link.claimed = true;
        link.claimer = claimer;
        link.claimedAt = block.timestamp;

        // Move funds: this contract -> claimer, encrypted the whole way.
        // Use transferVerified (not transferFromVerified) since this contract
        // is the source — no self-allowance needed.
        FHE.allowTransient(link.encAmount, link.vault);
        euint64 transferred = IFHERC20Vault(link.vault).transferVerified(claimer, link.encAmount);

        // Claimer can decrypt the amount; this contract keeps a handle for receipts.
        FHE.allowThis(transferred);
        FHE.allow(transferred, claimer);

        _bumpReceiptsAndGlobal(claimer, transferred);

        _receivedLinks[claimer].push(linkId);

        emit LinkClaimed(linkId, claimer, block.timestamp);
        try eventHub.emitActivity(link.sender, claimer, "claim_link_claimed", link.note, linkId) {} catch {}
    }

    // ─── Refund (sender, post-expiry) ─────────────────────────────────────

    /// @notice Sender can pull funds back after expiry if no one claimed.
    function refundLink(uint256 linkId) external nonReentrant {
        ClaimLink storage link = _links[linkId];
        require(link.sender == msg.sender, "ClaimLinks: not sender");
        require(!link.claimed, "ClaimLinks: already claimed");
        require(!link.refunded, "ClaimLinks: already refunded");
        require(block.timestamp >= link.expiryTimestamp, "ClaimLinks: not yet expired");

        link.refunded = true;

        FHE.allowTransient(link.encAmount, link.vault);
        IFHERC20Vault(link.vault).transferVerified(msg.sender, link.encAmount);

        emit LinkRefunded(linkId, msg.sender, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "claim_link_refunded", link.note, linkId) {} catch {}
    }

    // ─── Views ────────────────────────────────────────────────────────────

    function getLink(uint256 linkId) external view returns (
        address sender,
        address vault,
        LinkMode mode,
        address boundAddress,
        uint256 createdAt,
        uint256 expiryTimestamp,
        bool claimed,
        bool refunded,
        string memory note,
        address claimer,
        uint256 claimedAt
    ) {
        ClaimLink storage link = _links[linkId];
        return (
            link.sender,
            link.vault,
            link.mode,
            link.boundAddress,
            link.createdAt,
            link.expiryTimestamp,
            link.claimed,
            link.refunded,
            link.note,
            link.claimer,
            link.claimedAt
        );
    }

    function getEncryptedAmount(uint256 linkId) external view returns (euint64) {
        return _links[linkId].encAmount;
    }

    function getSentLinks(address user) external view returns (uint256[] memory) {
        return _sentLinks[user];
    }

    function getReceivedLinks(address user) external view returns (uint256[] memory) {
        return _receivedLinks[user];
    }

    // ─── Admin ────────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        paymentReceipts = _paymentReceipts;
    }

    function setDefaultExpiry(uint256 newDefault) external onlyOwner {
        require(newDefault >= 1 hours && newDefault <= 30 days, "ClaimLinks: out of range");
        defaultExpirySeconds = newDefault;
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _bumpReceiptsAndGlobal(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        FHE.allowTransient(amount, paymentReceipts);
        // §2.6 of BEST_VERSION_FULL_PLAN: surface receipt-bump failures so an
        // indexer can detect + replay the missing bump. The previous silent
        // catch left lifetime-received counters drifting silently (audit A9).
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, amount) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        FHE.allowTransient(amount, paymentReceipts);
        try IPaymentReceipts(paymentReceipts).bumpGlobal(amount) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Append-only storage. Used: 8. Gap: 50.
    /// Decrement gap by 1 when adding a new state variable; total slots
    /// (used + gap) must stay constant across UUPS upgrades.
    uint256[50] private __gap;
}
