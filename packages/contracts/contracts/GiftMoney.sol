// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title GiftMoney — "Red Envelope" encrypted random splits
/// @notice Sender distributes encrypted FHERC20 tokens across N recipients.
///         Each recipient gets a pre-computed share (computed off-chain to avoid
///         euint64 division). Nobody knows who got what until they unseal their share.
///
/// @dev Key design decisions:
///      - Shares are pre-computed OFF-CHAIN (euint64 division not supported on-chain)
///      - Sender encrypts each recipient's share individually, submits as InEuint64[]
///      - Funds are transferred directly to each recipient's vault balance during creation
///        (vault.transferFrom sender -> recipient for each share)
///      - "Claim" is a social action: marks the envelope as "opened" for the activity feed,
///        but funds are already in the recipient's encrypted balance
///      - The surprise element is preserved because amounts are encrypted —
///        recipients must unseal (with permit) to see their share amount
///      - Only the recipient can unseal their own share via FHE.allow
///      - Social context (who, when, note) is public; financial details are private
///      - UUPS upgradeable, ReentrancyGuard on all mutating functions
///      - Security zone 0 enforced everywhere
contract GiftMoney is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ──────────────────────────────────────────────────────────

    struct GiftEnvelope {
        address sender;
        address vault;
        uint256 recipientCount;
        uint256 claimedCount;
        string note;
        uint256 timestamp;
        bool active;
        uint256 expiryTimestamp; // 0 = no expiry; >0 = UX-only expiry (funds already transferred)
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;

    uint256 public nextEnvelopeId;
    mapping(uint256 => GiftEnvelope) private _envelopes;

    /// @dev Per-envelope recipient list
    mapping(uint256 => address[]) private _recipients;

    /// @dev Per-envelope per-recipient encrypted share handle (for unsealing)
    mapping(uint256 => mapping(address => euint64)) private _shares;

    /// @dev Per-envelope per-recipient "opened" status
    mapping(uint256 => mapping(address => bool)) public opened;

    /// @dev Per-envelope per-recipient membership
    mapping(uint256 => mapping(address => bool)) public isRecipient;

    /// @dev Reverse lookup: address -> envelope IDs they received
    mapping(address => uint256[]) private _receivedEnvelopes;

    /// @dev Reverse lookup: address -> envelope IDs they created
    mapping(address => uint256[]) private _sentEnvelopes;

    uint256 public constant MAX_RECIPIENTS = 30;

    // ─── Events ─────────────────────────────────────────────────────────

    event EnvelopeCreated(
        uint256 indexed envelopeId,
        address indexed sender,
        address vault,
        uint256 recipientCount,
        string note,
        uint256 timestamp
    );

    event GiftOpened(
        uint256 indexed envelopeId,
        address indexed recipient,
        uint256 timestamp
    );

    event EnvelopeDeactivated(
        uint256 indexed envelopeId,
        address indexed sender,
        uint256 timestamp
    );

    event EnvelopeExpirySet(
        uint256 indexed envelopeId,
        uint256 expiryTimestamp
    );

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Create Gift Envelope ───────────────────────────────────────────

    /// @notice Create a gift envelope with pre-computed encrypted shares.
    ///
    ///         The sender provides encrypted share amounts for each recipient.
    ///         Shares MUST be computed off-chain (random split, equal split, weighted, etc.)
    ///         because euint64 division is not supported on-chain.
    ///
    ///         Funds are transferred directly from sender to each recipient's encrypted
    ///         vault balance. The "surprise" is preserved because amounts are FHE-encrypted;
    ///         recipients must unseal with a permit to see how much they received.
    ///
    ///         Sender must have approved this contract on the vault beforehand
    ///         (lazy approval pattern: approvePlaintext(GiftMoney, type(uint64).max)).
    ///
    /// @param vault FHERC20Vault address for the token being gifted
    /// @param recipients Array of recipient addresses
    /// @param shares Array of encrypted share amounts (one per recipient)
    /// @param note Public note/message (e.g., "Happy New Year!")
    /// @param expiryTimestamp UX-only expiry (0 = no expiry). Must be in the future if set.
    ///        Since funds transfer immediately, this is for display/social tracking only.
    /// @return envelopeId The ID of the created envelope
    function createEnvelope(
        address vault,
        address[] calldata recipients,
        InEuint64[] memory shares,
        string calldata note,
        uint256 expiryTimestamp
    ) external nonReentrant returns (uint256) {
        require(expiryTimestamp == 0 || expiryTimestamp > block.timestamp, "GiftMoney: expiry must be future");
        uint256 count = recipients.length;
        require(count > 0, "GiftMoney: no recipients");
        require(count <= MAX_RECIPIENTS, "GiftMoney: max 30 recipients");
        require(count == shares.length, "GiftMoney: length mismatch");

        uint256 envelopeId = nextEnvelopeId++;

        // Store envelope metadata
        _envelopes[envelopeId] = GiftEnvelope({
            sender: msg.sender,
            vault: vault,
            recipientCount: count,
            claimedCount: 0,
            note: note,
            timestamp: block.timestamp,
            active: true,
            expiryTimestamp: expiryTimestamp
        });

        IFHERC20Vault vaultContract = IFHERC20Vault(vault);

        for (uint256 i = 0; i < count; i++) {
            address recipient = recipients[i];
            require(recipient != address(0), "GiftMoney: zero address recipient");
            require(recipient != msg.sender, "GiftMoney: sender cannot be recipient");
            require(!isRecipient[envelopeId][recipient], "GiftMoney: duplicate recipient");

            // Verify encrypted input here (msg.sender = user) before cross-contract call
            euint64 verifiedShare = FHE.asEuint64(shares[i]);
            FHE.allowTransient(verifiedShare, vault);

            // Transfer encrypted share directly from sender to recipient
            // Funds land in recipient's encrypted vault balance immediately
            // Store the actual transfer result (not a re-encrypted input) so the
            // handle tracks the real on-chain value post-transfer
            euint64 transferred = vaultContract.transferFromVerified(msg.sender, recipient, verifiedShare);
            _shares[envelopeId][recipient] = transferred;

            // Grant permissions: contract can reference it, recipient can unseal it, creator can verify
            FHE.allowThis(transferred);
            FHE.allow(transferred, recipient);
            FHE.allow(transferred, msg.sender);

            // Track membership and reverse lookups
            isRecipient[envelopeId][recipient] = true;
            _recipients[envelopeId].push(recipient);
            _receivedEnvelopes[recipient].push(envelopeId);
        }

        _sentEnvelopes[msg.sender].push(envelopeId);

        emit EnvelopeCreated(envelopeId, msg.sender, vault, count, note, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "gift_created", note, envelopeId) {} catch {}

        return envelopeId;
    }

    // ─── Open Gift (Claim) ──────────────────────────────────────────────

    /// @notice "Open" your gift envelope. This is a social action that:
    ///         1. Marks your envelope as opened (visible on activity feed)
    ///         2. Emits a gift_claimed event for notifications
    ///
    ///         Funds are already in your encrypted vault balance from createEnvelope.
    ///         The amount remains encrypted until you unseal it with a permit.
    ///         This function is the "open the red envelope" moment.
    ///
    /// @param envelopeId The envelope to open
    function claimGift(uint256 envelopeId) external nonReentrant {
        GiftEnvelope storage env = _envelopes[envelopeId];
        require(env.active, "GiftMoney: envelope not active");
        require(isRecipient[envelopeId][msg.sender], "GiftMoney: not a recipient");
        require(!opened[envelopeId][msg.sender], "GiftMoney: already opened");

        // Mark as opened
        opened[envelopeId][msg.sender] = true;
        env.claimedCount++;

        emit GiftOpened(envelopeId, msg.sender, block.timestamp);
        try eventHub.emitActivity(env.sender, msg.sender, "gift_claimed", env.note, envelopeId) {} catch {}
    }

    // ─── Expiry & Deactivation ──────────────────────────────────────────

    /// @notice Set or update the expiry timestamp on an envelope.
    ///         UX-only: funds are already in recipients' vault balances.
    ///         Useful for reminding recipients to "open" before a date.
    /// @param envelopeId The envelope to update
    /// @param expiryTimestamp Must be in the future (or 0 to clear)
    function setExpiry(uint256 envelopeId, uint256 expiryTimestamp) external {
        GiftEnvelope storage env = _envelopes[envelopeId];
        require(msg.sender == env.sender, "GiftMoney: not sender");
        require(env.active, "GiftMoney: envelope not active");
        require(expiryTimestamp == 0 || expiryTimestamp > block.timestamp, "GiftMoney: expiry must be future");

        env.expiryTimestamp = expiryTimestamp;

        emit EnvelopeExpirySet(envelopeId, expiryTimestamp);
    }

    /// @notice Check whether an envelope has passed its expiry timestamp.
    ///         Returns false if no expiry is set.
    /// @param envelopeId The envelope to check
    /// @return True if an expiry is set and the current time is past it
    function isExpired(uint256 envelopeId) external view returns (bool) {
        GiftEnvelope storage env = _envelopes[envelopeId];
        return env.expiryTimestamp > 0 && block.timestamp > env.expiryTimestamp;
    }

    /// @notice Deactivate an envelope. Only the sender can call this.
    ///         Marks the envelope as inactive so recipients see it as closed.
    ///         Funds are NOT moved — they remain in recipients' vault balances.
    /// @param envelopeId The envelope to deactivate
    function deactivateEnvelope(uint256 envelopeId) external {
        GiftEnvelope storage env = _envelopes[envelopeId];
        require(msg.sender == env.sender, "GiftMoney: not sender");
        require(env.active, "GiftMoney: already inactive");

        env.active = false;

        emit EnvelopeDeactivated(envelopeId, msg.sender, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "gift_deactivated", env.note, envelopeId) {} catch {}
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get your encrypted gift share from an envelope.
    ///         Unseal with a valid permit to see the amount.
    /// @param envelopeId The envelope to query
    /// @return The encrypted share handle
    function getMyGift(uint256 envelopeId) external view returns (euint64) {
        require(isRecipient[envelopeId][msg.sender], "GiftMoney: not a recipient");
        return _shares[envelopeId][msg.sender];
    }

    /// @notice Get envelope metadata (public info only, no amounts)
    function getEnvelope(uint256 envelopeId) external view returns (
        address sender,
        address vault,
        uint256 recipientCount,
        uint256 claimedCount,
        string memory note,
        uint256 timestamp,
        bool active,
        uint256 expiryTimestamp
    ) {
        GiftEnvelope storage env = _envelopes[envelopeId];
        return (
            env.sender,
            env.vault,
            env.recipientCount,
            env.claimedCount,
            env.note,
            env.timestamp,
            env.active,
            env.expiryTimestamp
        );
    }

    /// @notice Get the list of recipients for an envelope
    function getRecipients(uint256 envelopeId) external view returns (address[] memory) {
        return _recipients[envelopeId];
    }

    /// @notice Get all envelope IDs where user is a recipient
    function getReceivedEnvelopes(address user) external view returns (uint256[] memory) {
        return _receivedEnvelopes[user];
    }

    /// @notice Get all envelope IDs created by user
    function getSentEnvelopes(address user) external view returns (uint256[] memory) {
        return _sentEnvelopes[user];
    }

    /// @notice Check if all recipients have opened their gifts
    function isFullyOpened(uint256 envelopeId) external view returns (bool) {
        GiftEnvelope storage env = _envelopes[envelopeId];
        return env.claimedCount == env.recipientCount;
    }

    /// @notice Check if a specific recipient has opened their gift
    function hasOpened(uint256 envelopeId, address recipient) external view returns (bool) {
        return opened[envelopeId][recipient];
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
