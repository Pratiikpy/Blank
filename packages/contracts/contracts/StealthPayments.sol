// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function underlyingToken() external view returns (address);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title StealthPayments — Privacy-preserving stealth payment system
/// @notice Enables payments where the recipient address is encrypted using FHE.
///         Social context (sender, claim code hash, note, timestamp) is public.
///         Recipient identity is encrypted — nobody can see who the payment is for
///         until the intended recipient claims it with the correct claim code.
///
/// @dev Flow:
///      1. Sender calls sendStealth() depositing underlying ERC20 tokens + providing
///         an encrypted recipient address and a hashed claim code.
///      2. Claimer calls claimStealth() with the secret claim code. The contract
///         verifies keccak256(claimCode) == claimCodeHash AND uses FHE.eq() to verify
///         msg.sender matches the encrypted recipient. The conditional amount is
///         computed via FHE.select() and async-decrypted.
///      3. Claimer calls finalizeClaim() after decryption resolves. If they were the
///         correct recipient, they receive the full amount. Wrong claimers get 0.
///
///      Privacy model:
///      - Deposit/withdrawal amounts are plaintext (same as shield/unshield — public)
///      - Recipient identity is encrypted (private until claimed)
///      - Wrong claimers get 0 tokens instead of a revert (privacy preserved)
///      - Uses FHE.select() for balance checks, never reverts on identity mismatch
///
///      Follows the same escrow pattern as BusinessHub (ERC20 custody, not vault custody)
///      because FHERC20Vault.transferFrom requires InEuint64 (client-encrypted input),
///      which cannot be constructed on-chain from euint64 handles.
contract StealthPayments is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────

    struct StealthTransfer {
        address sender;
        eaddress encryptedRecipient;    // Encrypted recipient address — only sender can unseal
        euint64 encryptedAmount;        // Encrypted amount — for FHE conditional check
        address vault;                  // Which FHERC20Vault (used to find underlying token)
        address underlyingToken;        // Underlying ERC20 held in custody
        uint256 plaintextAmount;        // Plaintext deposit amount (public, like shield/unshield)
        bytes32 claimCodeHash;          // keccak256 of the secret claim code
        string note;                    // Public context note
        uint256 timestamp;
        bool claimed;                   // Whether claim has been initiated
        bool finalized;                 // Whether funds have been released
    }

    /// @dev Pending claim data: stores the conditional amount awaiting decryption
    struct PendingClaim {
        address claimer;
        euint64 conditionalAmount;      // FHE.select result — zero if wrong claimer
        bool pending;
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;

    uint256 public nextTransferId;
    mapping(uint256 => StealthTransfer) private _transfers;
    mapping(uint256 => PendingClaim) private _pendingClaims;

    /// @dev Reverse lookup: sender → list of transfer IDs
    mapping(address => uint256[]) private _senderTransfers;

    /// @dev Claim code hash → transfer ID (+1 offset; 0 means not found)
    mapping(bytes32 => uint256) private _claimCodeToTransferId;

    /// @dev Encrypted zero constant (initialized once, reused to save gas)
    euint64 private ZERO;

    // ─── Events ─────────────────────────────────────────────────────────

    event StealthSent(
        uint256 indexed transferId,
        address indexed sender,
        bytes32 claimCodeHash,
        address vault,
        string note,
        uint256 timestamp
    );

    event StealthClaimStarted(
        uint256 indexed transferId,
        address indexed claimer,
        uint256 timestamp
    );

    event StealthFinalized(
        uint256 indexed transferId,
        address indexed claimer,
        uint256 plaintextAmount,
        uint256 timestamp
    );

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);

        // Initialize encrypted zero constant — reused to save gas
        ZERO = FHE.asEuint64(0);
        FHE.allowThis(ZERO);
    }

    // ─── Send Stealth Payment ───────────────────────────────────────────

    /// @notice Send a stealth payment. Deposits underlying ERC20 tokens and stores
    ///         an encrypted recipient address. The deposit amount is public (like shielding),
    ///         but the recipient identity is hidden behind FHE encryption.
    ///
    ///         The sender shares the claim code with the intended recipient off-chain
    ///         (e.g., via encrypted DM, QR code, payment link).
    ///
    ///         IMPORTANT: claimCodeHash MUST be computed as:
    ///           keccak256(abi.encodePacked(claimCode, recipientAddress))
    ///         This binds the claim code to the intended recipient, preventing front-running.
    ///         Even if an attacker sees the claimCode in the mempool, they cannot use it
    ///         because the hash is bound to the recipient's address.
    ///
    /// @param plaintextAmount Amount of underlying tokens to deposit (public)
    /// @param encRecipient Encrypted recipient address (FHE-encrypted)
    /// @param claimCodeHash keccak256(abi.encodePacked(claimCode, recipientAddress))
    /// @param vault FHERC20Vault address (used to identify the token)
    /// @param note Public context note (e.g., "birthday gift")
    /// @return transferId The ID of the created stealth transfer
    function sendStealth(
        uint256 plaintextAmount,
        InEaddress memory encRecipient,
        bytes32 claimCodeHash,
        address vault,
        string calldata note
    ) external nonReentrant returns (uint256) {
        require(plaintextAmount > 0, "StealthPayments: zero amount");
        require(claimCodeHash != bytes32(0), "StealthPayments: empty claim code hash");
        require(vault != address(0), "StealthPayments: invalid vault");
        require(_claimCodeToTransferId[claimCodeHash] == 0, "StealthPayments: claim code already used");

        // Get the underlying ERC20 token from the vault
        address underlying = IFHERC20Vault(vault).underlyingToken();

        // Transfer underlying tokens from sender to this contract (escrow custody)
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), plaintextAmount);

        // Encrypt the amount on-chain for later FHE conditional check
        euint64 encAmount = FHE.asEuint64(plaintextAmount);
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, msg.sender);

        // Process the encrypted recipient address
        eaddress recipient = FHE.asEaddress(encRecipient);
        FHE.allowThis(recipient);
        FHE.allow(recipient, msg.sender);

        uint256 id = nextTransferId++;
        _transfers[id] = StealthTransfer({
            sender: msg.sender,
            encryptedRecipient: recipient,
            encryptedAmount: encAmount,
            vault: vault,
            underlyingToken: underlying,
            plaintextAmount: plaintextAmount,
            claimCodeHash: claimCodeHash,
            note: note,
            timestamp: block.timestamp,
            claimed: false,
            finalized: false
        });

        _senderTransfers[msg.sender].push(id);
        _claimCodeToTransferId[claimCodeHash] = id + 1; // +1 because 0 means "not found"

        emit StealthSent(id, msg.sender, claimCodeHash, vault, note, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "stealth_sent", note, id) {} catch {}

        return id;
    }

    // ─── Claim Stealth Payment (Phase 1: Verify + Decrypt) ──────────────

    /// @notice Initiate a claim on a stealth payment by revealing the claim code.
    ///         The contract verifies keccak256(abi.encodePacked(claimCode, msg.sender)) == claimCodeHash,
    ///         binding the claim code to the caller's address to prevent front-running.
    ///         Then uses FHE.eq() to check if msg.sender matches the encrypted recipient.
    ///
    ///         The conditional amount (full if correct recipient, zero if wrong) is
    ///         sent to async decryption. Call finalizeClaim() after decryption resolves.
    ///
    ///         Privacy-preserving: wrong claimers get 0 instead of a revert.
    ///         Front-running resistant: claim code is bound to recipient address.
    ///
    /// @param transferId The stealth transfer to claim
    /// @param claimCode The secret claim code (plaintext — contract hashes to verify)
    function claimStealth(
        uint256 transferId,
        bytes32 claimCode
    ) external nonReentrant {
        require(transferId < nextTransferId, "StealthPayments: invalid transfer ID");

        StealthTransfer storage st = _transfers[transferId];
        require(!st.claimed, "StealthPayments: already claimed");

        // Verify claim code hash bound to msg.sender's address (prevents front-running).
        // The sender computed claimCodeHash = keccak256(abi.encodePacked(claimCode, recipientAddress))
        // so only the intended recipient can produce a matching hash with their address.
        require(
            keccak256(abi.encodePacked(claimCode, msg.sender)) == st.claimCodeHash,
            "StealthPayments: invalid claim code"
        );

        // Mark as claimed BEFORE any state changes (checks-effects-interactions)
        st.claimed = true;

        // Encrypted identity verification:
        // Convert msg.sender to encrypted address and compare with stored recipient
        eaddress claimerEncrypted = FHE.asEaddress(msg.sender);
        ebool isCorrectRecipient = FHE.eq(st.encryptedRecipient, claimerEncrypted);

        // Privacy-preserving conditional amount:
        // Correct recipient → full encrypted amount
        // Wrong claimer → encrypted zero
        // No revert — a revert would leak "you're not the recipient"
        euint64 conditionalAmount = FHE.select(isCorrectRecipient, st.encryptedAmount, ZERO);

        // Store pending claim
        FHE.allowThis(conditionalAmount);
        FHE.allow(conditionalAmount, msg.sender);

        _pendingClaims[transferId] = PendingClaim({
            claimer: msg.sender,
            conditionalAmount: conditionalAmount,
            pending: true
        });

        FHE.decrypt(conditionalAmount);

        emit StealthClaimStarted(transferId, msg.sender, block.timestamp);
    }

    // ─── Finalize Claim (Phase 2: After Decryption) ─────────────────────

    /// @notice Finalize a stealth claim after decryption resolves.
    ///         If the claimer was the correct recipient, they receive the full amount
    ///         in underlying ERC20 tokens. If wrong, they receive 0.
    ///
    /// @param transferId The stealth transfer to finalize
    function finalizeClaim(uint256 transferId) external nonReentrant {
        require(transferId < nextTransferId, "StealthPayments: invalid transfer ID");

        StealthTransfer storage st = _transfers[transferId];
        require(st.claimed, "StealthPayments: not yet claimed");
        require(!st.finalized, "StealthPayments: already finalized");

        PendingClaim storage pending = _pendingClaims[transferId];
        require(pending.pending, "StealthPayments: no pending claim");
        require(msg.sender == pending.claimer, "StealthPayments: not the claimer");

        // Get the decrypted conditional amount
        (uint256 decryptedAmount, bool ready) = FHE.getDecryptResultSafe(pending.conditionalAmount);
        require(ready, "StealthPayments: decryption not ready yet");

        // Mark as finalized
        st.finalized = true;
        pending.pending = false;

        // Transfer underlying ERC20 tokens to the claimer
        // If wrong claimer, decryptedAmount == 0 and nothing transfers
        if (decryptedAmount > 0) {
            IERC20(st.underlyingToken).safeTransfer(msg.sender, decryptedAmount);
        }

        emit StealthFinalized(transferId, msg.sender, decryptedAmount, block.timestamp);
        try eventHub.emitActivity(st.sender, msg.sender, "stealth_claimed", st.note, transferId) {} catch {}
    }

    // ─── Refund (sender can reclaim if unclaimed after timeout) ──────────

    /// @notice Sender can refund an unclaimed stealth payment after 30 days.
    ///         Prevents funds from being locked forever if the recipient never claims.
    /// @param transferId The stealth transfer to refund
    function refund(uint256 transferId) external nonReentrant {
        require(transferId < nextTransferId, "StealthPayments: invalid transfer ID");

        StealthTransfer storage st = _transfers[transferId];
        require(msg.sender == st.sender, "StealthPayments: not the sender");
        require(!st.claimed, "StealthPayments: already claimed");
        require(!st.finalized, "StealthPayments: already finalized");
        require(block.timestamp > st.timestamp + 30 days, "StealthPayments: too early to refund");

        // Mark as finalized to prevent double-refund
        st.finalized = true;

        // Return the escrowed tokens to the sender
        IERC20(st.underlyingToken).safeTransfer(msg.sender, st.plaintextAmount);

        try eventHub.emitActivity(msg.sender, address(0), "stealth_refunded", st.note, transferId) {} catch {}
    }

    // ─── Lookup Pending Claims ──────────────────────────────────────────

    /// @notice Find transfer IDs matching given claim code hashes.
    ///         Used by the frontend to discover which stealth payments
    ///         a user can claim (they know their claim codes off-chain).
    /// @param claimCodeHashes Array of keccak256(abi.encodePacked(claimCode, callerAddress)) values to look up
    /// @return transferIds Array of matching transfer IDs (0 if no match)
    /// @return found Array of booleans indicating if a claimable match was found
    function getMyPendingClaims(
        bytes32[] calldata claimCodeHashes
    ) external view returns (uint256[] memory transferIds, bool[] memory found) {
        uint256 len = claimCodeHashes.length;
        transferIds = new uint256[](len);
        found = new bool[](len);

        for (uint256 i = 0; i < len; i++) {
            uint256 stored = _claimCodeToTransferId[claimCodeHashes[i]];
            if (stored > 0) {
                uint256 id = stored - 1; // Undo the +1 offset
                if (!_transfers[id].claimed) {
                    transferIds[i] = id;
                    found[i] = true;
                }
            }
        }
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get public metadata of a stealth transfer (no encrypted data)
    function getTransferInfo(uint256 transferId) external view returns (
        address sender,
        address vault,
        address underlyingToken,
        uint256 plaintextAmount,
        bytes32 claimCodeHash,
        string memory note,
        uint256 timestamp,
        bool claimed,
        bool finalized
    ) {
        require(transferId < nextTransferId, "StealthPayments: invalid ID");
        StealthTransfer storage st = _transfers[transferId];
        return (
            st.sender, st.vault, st.underlyingToken,
            st.plaintextAmount, st.claimCodeHash,
            st.note, st.timestamp, st.claimed, st.finalized
        );
    }

    /// @notice Get the encrypted amount handle for a stealth transfer.
    ///         Only the sender can unseal (they have FHE.allow access from sendStealth).
    function getTransferEncryptedAmount(uint256 transferId) external view returns (euint64) {
        require(transferId < nextTransferId, "StealthPayments: invalid ID");
        return _transfers[transferId].encryptedAmount;
    }

    /// @notice Get the encrypted recipient handle for a stealth transfer.
    ///         Only the sender can unseal (they have FHE.allow access from sendStealth).
    function getTransferEncryptedRecipient(uint256 transferId) external view returns (eaddress) {
        require(transferId < nextTransferId, "StealthPayments: invalid ID");
        return _transfers[transferId].encryptedRecipient;
    }

    /// @notice Get all transfer IDs created by a sender
    function getSenderTransfers(address sender) external view returns (uint256[] memory) {
        return _senderTransfers[sender];
    }

    /// @notice Get the total number of stealth transfers
    function totalTransfers() external view returns (uint256) {
        return nextTransferId;
    }

    /// @notice Check the status of a pending claim's decryption
    function getClaimStatus(uint256 transferId) external view returns (
        address claimer,
        bool isPending,
        bool isFinalized
    ) {
        PendingClaim storage pc = _pendingClaims[transferId];
        return (pc.claimer, pc.pending, _transfers[transferId].finalized);
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
