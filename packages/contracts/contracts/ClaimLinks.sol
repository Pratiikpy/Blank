// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./utils/ReentrancyGuard.sol";
import "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
    function transferVerified(address to, sharedEuint64 shared) external returns (sharedEuint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, sharedEuint64 shared) external;
    function bumpGlobal(sharedEuint64 shared) external;
}

/// @title ClaimLinks: encrypted send-by-link with three security modes
/// @notice Sender locks an encrypted amount and registers a one-time claim
///         key address derived from the link secret. The recipient claims by
///         signing (linkId, claimer, chainId, this contract) with that key,
///         so the secret never appears in calldata and a mempool observer
///         cannot replay the claim for themselves.
///
/// @dev Three modes:
///      1. Bearer       - anyone holding the secret can claim.
///      2. EmailBound   - secret plus email; the email hash is mixed into the key.
///      3. AddressBound - secret plus caller must equal boundAddress.
///
///      Claim key derivation (client side, v2):
///        Bearer, AddressBound: priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(mode), secret))
///        EmailBound:           priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(1), secret, emailHash))
///        claimKey = address of priv (regenerate the secret if priv is 0 or >= secp256k1 n).
///      Claim signature: EIP-191 personal_sign over the 32 raw bytes of
///        keccak256(abi.encode(CLAIM_TYPEHASH, linkId, claimer, block.chainid, address(this))).
///
///      Links created before v2 only stored a secret hash. Their Bearer and
///      EmailBound claim paths were front-runnable and are removed; such links
///      stay refundable by the sender after expiry. Legacy AddressBound links
///      remain claimable through claimAddressBound because only the bound
///      address can call it.
///
///      Sender must `approvePlaintext(ClaimLinks, type(uint64).max)` on the
///      vault before creating links.
///
///      One-shot: claimed/refunded links cannot be reused.
contract ClaimLinks is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Domain separator (versioned hash scheme) ─────────────────────────

    bytes32 public constant DOMAIN = keccak256("BLANK_CLAIM_v1");
    bytes32 public constant CLAIM_TYPEHASH = keccak256("BLANK_CLAIM_v2");

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
    event PaymentReceiptsSet(address indexed previous, address indexed current);

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
    /// @param claimKey         One-time claim key address, derived client side
    ///                         from the secret (see contract NatSpec).
    /// @param mode             Bearer / EmailBound / AddressBound.
    /// @param boundAddress     Required for AddressBound; ignored otherwise.
    /// @param expirySeconds    0 = use defaultExpirySeconds. Otherwise seconds-from-now.
    /// @param note             Public note attached to the link.
    /// @return linkId          Stored ID.
    function createLink(
        address vault,
        externalEuint64 encAmount, bytes calldata proof,
        address claimKey,
        LinkMode mode,
        address boundAddress,
        uint256 expirySeconds,
        string calldata note
    ) external nonReentrant returns (uint256 linkId) {
        require(claimKey != address(0), "ClaimLinks: empty claim key");
        // A forged vault could return any handle and inflate receipt counters.
        require(address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault), "ClaimLinks: vault not allowed");
        if (mode == LinkMode.AddressBound) {
            require(boundAddress != address(0), "ClaimLinks: bound address required");
        }
        require(
            expirySeconds == 0 || expirySeconds <= MAX_EXPIRY_SECONDS,
            "ClaimLinks: expiry too long (max 365 days)"
        );

        uint256 expiry = block.timestamp + (expirySeconds == 0 ? defaultExpirySeconds : expirySeconds);

        // Verify input here (msg.sender = sender) before cross-contract call
        euint64 verified = FHE.asEuint64(encAmount, proof);

        // Move funds from sender into this contract's vault balance
        euint64 locked = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vault).transferFromVerified(msg.sender, address(this), FHE.shareEuint64(verified, vault)),
            vault
        );

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
            secretHash: bytes32(0),
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

        claimKeyOf[linkId] = claimKey;
        _sentLinks[msg.sender].push(linkId);

        emit LinkCreated(linkId, msg.sender, vault, mode, boundAddress, expiry, note);
        try eventHub.emitActivity(msg.sender, address(0), "claim_link_created", note, linkId) {} catch {}
    }

    // ─── Claim ────────────────────────────────────────────────────────────

    /// @notice Claim a link created with a claim key (any mode). `signature`
    ///         is the claim key's EIP-191 signature over claimDigest(linkId,
    ///         msg.sender). Binding the claimer makes a copied signature useless.
    function claim(uint256 linkId, bytes calldata signature) external nonReentrant {
        ClaimLink storage link = _claimable(linkId);
        address key = claimKeyOf[linkId];
        require(key != address(0), "ClaimLinks: legacy link, refund only");
        if (link.mode == LinkMode.AddressBound) {
            require(msg.sender == link.boundAddress, "ClaimLinks: not bound address");
        }
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(claimDigest(linkId, msg.sender));
        // OZ ECDSA rejects malleable (high-s) signatures.
        require(ECDSA.recover(digest, signature) == key, "ClaimLinks: bad claim signature");
        _release(linkId, link, msg.sender);
    }

    /// @notice The 32-byte message the claim key signs for `claimer`.
    function claimDigest(uint256 linkId, address claimer) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, linkId, claimer, block.chainid, address(this)));
    }

    /// @notice Claim a legacy (pre-claim-key) AddressBound link. msg.sender
    ///         must equal boundAddress AND `secret` must hash correctly. Not
    ///         front-runnable because only the bound address can call.
    function claimAddressBound(uint256 linkId, bytes32 secret) external nonReentrant {
        ClaimLink storage link = _claimable(linkId);
        require(link.mode == LinkMode.AddressBound, "ClaimLinks: wrong mode");
        require(claimKeyOf[linkId] == address(0), "ClaimLinks: use claim");
        require(msg.sender == link.boundAddress, "ClaimLinks: not bound address");
        bytes32 expected = keccak256(abi.encodePacked(DOMAIN, uint8(LinkMode.AddressBound), secret));
        require(expected == link.secretHash, "ClaimLinks: bad secret");
        _release(linkId, link, msg.sender);
    }

    function _claimable(uint256 linkId) internal view returns (ClaimLink storage link) {
        link = _links[linkId];
        require(link.sender != address(0), "ClaimLinks: no such link");
        require(!link.claimed, "ClaimLinks: already claimed");
        require(!link.refunded, "ClaimLinks: refunded");
        require(block.timestamp < link.expiryTimestamp, "ClaimLinks: expired");
        // Reject self-claim. A sender claiming their own link is a
        // no-op net for the vault (transferFrom self → contract +
        // transferVerified contract → self), but _release calls
        // _bumpReceiptsAndGlobal(claimer, transferred) which inflates
        // the claimer's per-user "received" counter inside
        // PaymentReceipts. That counter is what proveIncomeAbove
        // reads, so a self-claim lets a user fake income they didn't
        // actually receive. The sender already has refundLink for
        // the legitimate "I want my funds back" case.
        require(msg.sender != link.sender, "ClaimLinks: sender cannot self-claim");
    }

    function _release(uint256 linkId, ClaimLink storage link, address claimer) internal {
        link.claimed = true;
        link.claimer = claimer;
        link.claimedAt = block.timestamp;

        // Move funds: this contract -> claimer, encrypted the whole way.
        // Use transferVerified (not transferFromVerified) since this contract
        // is the source — no self-allowance needed.
        euint64 transferred = FHE.receiveEuint64FromCall(
            IFHERC20Vault(link.vault).transferVerified(claimer, FHE.shareEuint64(link.encAmount, link.vault)),
            link.vault
        );

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

        euint64 returned = FHE.receiveEuint64FromCall(
            IFHERC20Vault(link.vault).transferVerified(msg.sender, FHE.shareEuint64(link.encAmount, link.vault)),
            link.vault
        );
        // Let the sender verify what actually came back.
        FHE.allowThis(returned);
        FHE.allow(returned, msg.sender);

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
        address previous = paymentReceipts;
        paymentReceipts = _paymentReceipts;
        emit PaymentReceiptsSet(previous, _paymentReceipts);
    }

    function setDefaultExpiry(uint256 newDefault) external onlyOwner {
        require(newDefault >= 1 hours && newDefault <= 30 days, "ClaimLinks: out of range");
        defaultExpirySeconds = newDefault;
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _bumpReceiptsAndGlobal(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        // §2.6 of BEST_VERSION_FULL_PLAN: surface receipt-bump failures so an
        // indexer can detect + replay the missing bump. The previous silent
        // catch left lifetime-received counters drifting silently (audit A9).
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        try IPaymentReceipts(paymentReceipts).bumpGlobal(FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Append-only storage. Original 8 slots, then tokenRegistry and claimKeyOf.
    /// Decrement gap by 1 when adding a new state variable; total slots
    /// (used + gap) must stay constant across UUPS upgrades.
    ITokenRegistry public tokenRegistry;
    /// @dev linkId => one-time claim key. Zero for links created before v2.
    mapping(uint256 => address) public claimKeyOf;
    uint256[48] private __gap;

    event TokenRegistrySet(address indexed registry);

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "ClaimLinks: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }
}
