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
///
///      Funding gate: the vault moves zero, rather than reverting, when the
///      sender's balance is short. A new link therefore starts PendingFunding
///      and only becomes claimable once the single "locked the requested
///      amount" bit has been decrypted and published (confirmFunding). A short
///      sender ends Void with nothing locked. Links created before the gate
///      read as Active and are unaffected.
contract ClaimLinks is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Domain separator (versioned hash scheme) ─────────────────────────

    bytes32 public constant DOMAIN = keccak256("BLANK_CLAIM_v1");
    bytes32 public constant CLAIM_TYPEHASH = keccak256("BLANK_CLAIM_v2");

    // ─── Types ────────────────────────────────────────────────────────────

    enum LinkMode { Bearer, EmailBound, AddressBound }

    /// @dev Active is zero so every link created before the funding gate reads
    ///      as Active without a migration.
    enum FundingStatus { Active, PendingFunding, Void }

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

    /// @notice The funded bit decrypted true: the link is claimable.
    event LinkFunded(uint256 indexed linkId, address indexed sender);
    /// @notice The link never became claimable (unfunded, or cancelled while
    ///         pending). Anything locked went back to the sender.
    event LinkVoided(uint256 indexed linkId, address indexed sender);

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

    /// @notice Create a claim link. It starts PendingFunding: decrypt
    ///         getFundingCheck(linkId) and pass it to confirmFunding to make it
    ///         claimable (or Void when the sender's balance was short).
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
        // The vault moves all or nothing, so `locked` is the requested amount
        // or zero. The equality term keeps "funded" exact if that ever changes.
        ebool funded = FHE.and(FHE.gt(locked, FHE.asEuint64(0)), FHE.eq(locked, verified));
        FHE.allowThis(funded);
        FHE.allowPublic(funded);
        _fundedCheck[linkId] = funded;
        fundingStatus[linkId] = FundingStatus.PendingFunding;

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
        _requireFunded(linkId);
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
        // Pending links use cancelPendingLink; Void links hold nothing.
        _requireFunded(linkId);

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

    // ─── Funding gate ─────────────────────────────────────────────────────

    /// @notice Settle a PendingFunding link. Anyone may call with the
    ///         Threshold Network decryption of getFundingCheck(linkId).
    ///         true: the link becomes claimable. false: nothing was locked and
    ///         the link is Void. The published value, not the argument, decides
    ///         the outcome.
    function confirmFunding(uint256 linkId, bool funded, bytes calldata signature) external nonReentrant {
        ClaimLink storage link = _links[linkId];
        require(fundingStatus[linkId] == FundingStatus.PendingFunding, "ClaimLinks: not pending funding");
        ebool check = _fundedCheck[linkId];
        (, bool published) = FHE.getDecryptResultSafe(check);
        if (!published) FHE.publishDecryptResult(check, funded, signature);
        (bool ok, bool ready) = FHE.getDecryptResultSafe(check);
        require(ready, "ClaimLinks: decryption not ready");

        if (ok) {
            fundingStatus[linkId] = FundingStatus.Active;
            emit LinkFunded(linkId, link.sender);
        } else {
            _voidLink(linkId, link);
        }
    }

    /// @notice The sender abandons a link that is still PendingFunding, for
    ///         example when the funding decryption is slow. Whatever was locked
    ///         (nothing, when the balance was short) goes back.
    function cancelPendingLink(uint256 linkId) external nonReentrant {
        ClaimLink storage link = _links[linkId];
        require(fundingStatus[linkId] == FundingStatus.PendingFunding, "ClaimLinks: not pending funding");
        require(link.sender == msg.sender, "ClaimLinks: not sender");
        _voidLink(linkId, link);
    }

    /// @notice The public ebool "locked == requested and > 0" for a link created
    ///         under the funding gate. Uninitialized for older links.
    function getFundingCheck(uint256 linkId) external view returns (ebool) {
        return _fundedCheck[linkId];
    }

    function _requireFunded(uint256 linkId) internal view {
        FundingStatus status = fundingStatus[linkId];
        require(status != FundingStatus.PendingFunding, "ClaimLinks: funding pending");
        require(status != FundingStatus.Void, "ClaimLinks: link unfunded");
    }

    /// @dev Returns whatever the link holds to the sender. That is zero for an
    ///      unfunded link, so the transfer is a no-op in practice and only
    ///      matters if the vault ever moved a partial amount.
    function _voidLink(uint256 linkId, ClaimLink storage link) internal {
        fundingStatus[linkId] = FundingStatus.Void;
        euint64 returned = FHE.receiveEuint64FromCall(
            IFHERC20Vault(link.vault).transferVerified(link.sender, FHE.shareEuint64(link.encAmount, link.vault)),
            link.vault
        );
        FHE.allowThis(returned);
        FHE.allow(returned, link.sender);
        emit LinkVoided(linkId, link.sender);
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
        require(_eventHub.code.length > 0, "ClaimLinks: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    /// @dev Zero turns the receipts bump off; anything else must be a contract.
    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        require(
            _paymentReceipts == address(0) || _paymentReceipts.code.length > 0,
            "ClaimLinks: bad receipts"
        );
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

    /// @dev Append-only storage. Original 8 slots, then tokenRegistry, claimKeyOf,
    /// fundingStatus and _fundedCheck.
    /// Decrement gap by 1 when adding a new state variable; total slots
    /// (used + gap) must stay constant across UUPS upgrades.
    ITokenRegistry public tokenRegistry;
    /// @dev linkId => one-time claim key. Zero for links created before v2.
    mapping(uint256 => address) public claimKeyOf;
    /// @dev linkId => funding gate state. Active (zero) for pre-gate links.
    mapping(uint256 => FundingStatus) public fundingStatus;
    /// @dev linkId => public "funded" bit decrypted by confirmFunding.
    mapping(uint256 => ebool) private _fundedCheck;
    uint256[46] private __gap;

    event TokenRegistrySet(address indexed registry);

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "ClaimLinks: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }
}
