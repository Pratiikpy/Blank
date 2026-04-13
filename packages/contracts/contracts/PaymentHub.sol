// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transfer(address to, InEuint64 memory encAmount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(
        address user1,
        address user2,
        string calldata activityType,
        string calldata note,
        uint256 refId
    ) external;
}

/// @title PaymentHub — Core encrypted payment operations
/// @notice Handles P2P payments with notes, payment requests, and batch sends.
///         All amounts are FHE-encrypted. Social context (who, when, note) is public.
///
/// @dev Design decisions:
///      - Uses FHERC20Vault.transferFrom (requires user approval of this contract)
///      - Payment requests store encrypted amounts on-chain
///      - Batch sends capped at 30 recipients (gas limit protection)
///      - Events emit public context only — never amounts
contract PaymentHub is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ──────────────────────────────────────────────────────────

    enum RequestStatus { Pending, Fulfilled, Cancelled }

    struct PaymentRequest {
        address from;           // Who should pay
        address to;             // Who gets paid (request creator)
        address vault;          // Which FHERC20Vault token
        euint64 amount;         // Encrypted requested amount
        string note;            // Public note ("dinner split", "rent")
        RequestStatus status;
        uint256 createdAt;
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;

    uint256 public nextRequestId;
    mapping(uint256 => PaymentRequest) private _requests;

    /// @dev Reverse lookups so users can discover their requests
    mapping(address => uint256[]) private _incomingRequests;  // requests TO pay
    mapping(address => uint256[]) private _outgoingRequests;  // requests I created

    uint256 public constant MAX_BATCH_SIZE = 30;

    // ─── Agent attestations (v0.1.3, append-only storage) ───────────────
    // Replay guard for nonces signed by AI agents. The agent signs an
    // attestation tuple (user, nonce, expiry, chainId) which the contract
    // verifies via ECDSA. Each nonce can only be consumed once per chain.
    mapping(bytes32 => bool) private _usedAgentNonces;

    // ─── Events ─────────────────────────────────────────────────────────

    event PaymentSent(
        address indexed from,
        address indexed to,
        address vault,
        string note,
        uint256 timestamp
    );

    event RequestCreated(
        uint256 indexed requestId,
        address indexed from,
        address indexed to,
        address vault,
        string note,
        uint256 timestamp
    );

    event RequestFulfilled(uint256 indexed requestId, uint256 timestamp);
    event RequestCancelled(uint256 indexed requestId, uint256 timestamp);

    event BatchPaymentSent(
        address indexed from,
        address vault,
        uint256 recipientCount,
        uint256 timestamp
    );

    /// @notice Emitted when a payment was processed via an AI agent. The
    ///         agent address is cryptographically attested via ECDSA — any
    ///         observer can verify the agent signed (user, nonce, expiry,
    ///         chainId), proving the user genuinely engaged that agent.
    event AgentPaymentSubmission(
        address indexed user,
        address indexed agent,
        bytes32 indexed nonce,
        uint256 expiry,
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
    }

    // ─── P2P Payment with Note ──────────────────────────────────────────

    /// @notice Send an encrypted payment to someone with an optional note.
    ///         Caller must have approved this contract on the FHERC20Vault.
    /// @param to Recipient address
    /// @param vault FHERC20Vault address for the token
    /// @param encAmount Encrypted payment amount
    /// @param note Public note (e.g., "Pizza 🍕") — visible to everyone
    function sendPayment(
        address to,
        address vault,
        InEuint64 memory encAmount,
        string calldata note
    ) external nonReentrant {
        require(to != address(0) && to != msg.sender, "PaymentHub: invalid recipient");

        // Verify the encrypted input in THIS contract's context where msg.sender
        // is the user's wallet address. This is critical because FHE.asEuint64()
        // calls Impl.verifyInput(input, msg.sender), and the ZK proof signature
        // is bound to the user's address. If we let the vault call asEuint64(),
        // msg.sender would be this contract's address, causing InvalidSigner.
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, vault);

        euint64 actual = IFHERC20Vault(vault).transferFromVerified(msg.sender, to, verifiedAmount);
        FHE.allowSender(actual);  // Sender can verify transfer succeeded

        emit PaymentSent(msg.sender, to, vault, note, block.timestamp);
        try eventHub.emitActivity(msg.sender, to, "payment", note, 0) {} catch {}
    }

    // ─── Payment Requests ───────────────────────────────────────────────

    /// @notice Create a payment request. The `from` address will see this
    ///         in their incoming requests and can choose to pay.
    /// @param from Who should pay (the person you're requesting from)
    /// @param vault FHERC20Vault address
    /// @param encAmount Encrypted amount you're requesting
    /// @param note Public reason for the request
    /// @return requestId The ID of the created request
    function createRequest(
        address from,
        address vault,
        InEuint64 memory encAmount,
        string calldata note
    ) external nonReentrant returns (uint256) {
        require(from != address(0) && from != msg.sender, "PaymentHub: invalid payer");

        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);
        FHE.allow(amount, from);      // Payer can see the amount
        FHE.allow(amount, msg.sender); // Creator can see the amount

        uint256 id = nextRequestId++;
        _requests[id] = PaymentRequest({
            from: from,
            to: msg.sender,
            vault: vault,
            amount: amount,
            note: note,
            status: RequestStatus.Pending,
            createdAt: block.timestamp
        });

        _incomingRequests[from].push(id);
        _outgoingRequests[msg.sender].push(id);

        emit RequestCreated(id, from, msg.sender, vault, note, block.timestamp);
        try eventHub.emitActivity(msg.sender, from, "request", note, id) {} catch {}

        return id;
    }

    /// @notice Fulfill a payment request. Only the designated payer can call this.
    ///         The payer must have approved this contract on the FHERC20Vault.
    /// @param requestId The request to fulfill
    /// @param encAmount Encrypted amount to pay (should match the request)
    function fulfillRequest(
        uint256 requestId,
        InEuint64 memory encAmount
    ) external nonReentrant {
        PaymentRequest storage req = _requests[requestId];
        require(req.status == RequestStatus.Pending, "PaymentHub: not pending");
        require(msg.sender == req.from, "PaymentHub: not the payer");

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, req.vault);

        euint64 actual = IFHERC20Vault(req.vault).transferFromVerified(msg.sender, req.to, verifiedAmount);
        FHE.allowSender(actual);  // Payer can verify transfer succeeded
        req.status = RequestStatus.Fulfilled;

        emit RequestFulfilled(requestId, block.timestamp);
        try eventHub.emitActivity(msg.sender, req.to, "request_fulfilled", req.note, requestId) {} catch {}
    }

    /// @notice Cancel a payment request. Only the creator can cancel.
    /// @param requestId The request to cancel
    function cancelRequest(uint256 requestId) external nonReentrant {
        PaymentRequest storage req = _requests[requestId];
        require(req.status == RequestStatus.Pending, "PaymentHub: not pending");
        require(msg.sender == req.to, "PaymentHub: not the creator");

        req.status = RequestStatus.Cancelled;

        emit RequestCancelled(requestId, block.timestamp);
        try eventHub.emitActivity(msg.sender, req.from, "request_cancelled", "", requestId) {} catch {}
    }

    // ─── Batch Payments ─────────────────────────────────────────────────

    /// @notice Send encrypted payments to multiple recipients in one transaction.
    ///         Max 30 recipients per batch (gas limit protection).
    /// @param recipients Array of recipient addresses
    /// @param vault FHERC20Vault address
    /// @param amounts Array of encrypted amounts (one per recipient)
    /// @param notes Array of notes (one per recipient, can be empty strings)
    function batchSend(
        address[] calldata recipients,
        address vault,
        InEuint64[] memory amounts,
        string[] calldata notes
    ) external nonReentrant {
        uint256 count = recipients.length;
        require(count > 0, "PaymentHub: empty batch");
        require(count <= MAX_BATCH_SIZE, "PaymentHub: max 30 recipients");
        require(count == amounts.length, "PaymentHub: length mismatch");
        require(count == notes.length, "PaymentHub: notes length mismatch");

        IFHERC20Vault vaultContract = IFHERC20Vault(vault);

        for (uint256 i = 0; i < count; i++) {
            require(recipients[i] != address(0) && recipients[i] != msg.sender, "PaymentHub: invalid recipient");
            // Verify encrypted input here (msg.sender = user) before cross-contract call
            euint64 verifiedAmount = FHE.asEuint64(amounts[i]);
            FHE.allowTransient(verifiedAmount, vault);
            euint64 actual = vaultContract.transferFromVerified(msg.sender, recipients[i], verifiedAmount);
            FHE.allowSender(actual);
            FHE.allow(actual, recipients[i]);
            emit PaymentSent(msg.sender, recipients[i], vault, notes[i], block.timestamp);
        }

        emit BatchPaymentSent(msg.sender, vault, count, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "batch_payment", "", count) {} catch {}
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get a payment request by ID
    function getRequest(uint256 requestId) external view returns (
        address from,
        address to,
        address vault,
        euint64 amount,
        string memory note,
        RequestStatus status,
        uint256 createdAt
    ) {
        PaymentRequest storage req = _requests[requestId];
        return (req.from, req.to, req.vault, req.amount, req.note, req.status, req.createdAt);
    }

    /// @notice Get all request IDs where this address is asked to pay
    function getIncomingRequests(address user) external view returns (uint256[] memory) {
        return _incomingRequests[user];
    }

    /// @notice Get all request IDs created by this address
    function getOutgoingRequests(address user) external view returns (uint256[] memory) {
        return _outgoingRequests[user];
    }

    /// @notice Get the count of pending incoming requests for a user
    function getPendingIncomingCount(address user) external view returns (uint256) {
        uint256 count = 0;
        uint256[] storage ids = _incomingRequests[user];
        for (uint256 i = 0; i < ids.length; i++) {
            if (_requests[ids[i]].status == RequestStatus.Pending) count++;
        }
        return count;
    }

    // ─── Agent payments (v0.1.3) ───────────────────────────────────────

    /// @notice The EIP-191 personal_sign digest the agent must sign.
    ///         Hashing this off-chain and signing with the agent wallet's
    ///         private key produces the `agentSignature` argument below.
    function agentDigest(address user, bytes32 nonce, uint256 expiry) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(user, nonce, expiry, block.chainid, address(this)));
        return MessageHashUtils.toEthSignedMessageHash(inner);
    }

    /// @notice Send an encrypted payment with cryptographic agent provenance.
    ///         Identical to sendPayment, plus an ECDSA-verified attestation
    ///         that the named agent signed off on this submission. The agent
    ///         signs (user, nonce, expiry, chainId, contract) — that signature
    ///         must recover to `agent`. Each nonce is single-use per chain.
    /// @param to Recipient
    /// @param vault FHERC20Vault address
    /// @param encAmount Encrypted payment amount
    /// @param note Public note
    /// @param agent The wallet address of the AI agent that derived this submission
    /// @param nonce Random 32-byte value the agent included when signing
    /// @param expiry Unix timestamp after which the attestation is invalid
    /// @param agentSignature 65-byte ECDSA signature from `agent`
    function sendPaymentAsAgent(
        address to,
        address vault,
        InEuint64 memory encAmount,
        string calldata note,
        address agent,
        bytes32 nonce,
        uint256 expiry,
        bytes calldata agentSignature
    ) external nonReentrant {
        require(to != address(0) && to != msg.sender, "PaymentHub: invalid recipient");
        require(agent != address(0), "PaymentHub: agent zero");
        require(block.timestamp <= expiry, "PaymentHub: agent attestation expired");
        require(!_usedAgentNonces[nonce], "PaymentHub: agent nonce already used");

        // Verify ECDSA attestation BEFORE consuming the nonce — keeps reverts
        // cheap for replay attempts and lets the recovered != expected case
        // surface a clear error.
        bytes32 digest = agentDigest(msg.sender, nonce, expiry);
        address recovered = ECDSA.recover(digest, agentSignature);
        require(recovered == agent, "PaymentHub: invalid agent signature");

        _usedAgentNonces[nonce] = true;

        // Identical settlement path to sendPayment — verify in caller context
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, vault);
        euint64 actual = IFHERC20Vault(vault).transferFromVerified(msg.sender, to, verifiedAmount);
        FHE.allowSender(actual);

        emit PaymentSent(msg.sender, to, vault, note, block.timestamp);
        emit AgentPaymentSubmission(msg.sender, agent, nonce, expiry, block.timestamp);
        try eventHub.emitActivity(msg.sender, to, "agent_payment", note, 0) {} catch {}
    }

    /// @notice Whether a given nonce has already been consumed by sendPaymentAsAgent.
    function isAgentNonceUsed(bytes32 nonce) external view returns (bool) {
        return _usedAgentNonces[nonce];
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
