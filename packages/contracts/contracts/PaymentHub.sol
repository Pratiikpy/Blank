// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
    function transfer(address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
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

interface IPaymentReceipts {
    function bumpGlobalVolume(sharedEuint64 shared) external;
    function bumpUserReceived(address user, sharedEuint64 shared) external;
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

    /// @dev Settling (appended) = funds attempted, waiting for the public
    ///      decrypt of "moved == requested" via finalizeRequest.
    enum RequestStatus { Pending, Fulfilled, Cancelled, Settling }

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

    // ─── Optional aggregator wiring (v0.1.4, append-only storage) ───────
    // When set, sendPayment / batchSend / fulfillRequest / sendPaymentAsAgent
    // fire paymentReceipts.bumpGlobalVolume(actual) AND
    // paymentReceipts.bumpUserReceived(recipient, actual). The first feeds
    // the landing-page counter; the second (added in #207) lets recipients
    // who only ever receive via PaymentHub call proveIncomeAbove. Zero-address
    // = feature off (back-compat).
    address public paymentReceipts;

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

    event RequestFulfilled(uint256 indexed requestId, address indexed vault, uint256 timestamp);
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
    event ReceiptsBumpFailed(string kind, bytes reason);
    event PaymentReceiptsSet(address indexed previous, address indexed current);
    event TokenRegistrySet(address indexed registry);
    /// @notice Payment attempted; finalizeRequest settles the status.
    event RequestSettling(uint256 indexed requestId, uint256 timestamp);
    /// @notice The attempt moved nothing; the request is Pending again.
    event RequestFulfillFailed(uint256 indexed requestId, uint256 timestamp);

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
        externalEuint64 encAmount, bytes calldata proof,
        string calldata note
    ) external nonReentrant {
        require(to != address(0) && to != msg.sender, "PaymentHub: invalid recipient");
        _requireVault(vault);

        // Verify the encrypted input in THIS contract's context where msg.sender
        // is the user's wallet address. This is critical because FHE.asEuint64()
        // calls Impl.verifyInput(input, msg.sender), and the ZK proof signature
        // is bound to the user's address. If we let the vault call asEuint64(),
        // msg.sender would be this contract's address, causing InvalidSigner.
        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);

        euint64 actual = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vault).transferFromVerified(msg.sender, to, FHE.shareEuint64(verifiedAmount, vault)),
            vault
        );
        FHE.allowSender(actual);  // Sender can verify transfer succeeded
        FHE.allowThis(actual);    // Required so we can pass to PaymentReceipts
        _bumpAggregate(to, actual);

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
        externalEuint64 encAmount, bytes calldata proof,
        string calldata note
    ) external nonReentrant returns (uint256) {
        require(from != address(0) && from != msg.sender, "PaymentHub: invalid payer");
        _requireVault(vault);

        euint64 amount = FHE.asEuint64(encAmount, proof);
        FHE.allowThis(amount);
        FHE.allow(amount, from);      // Payer can see the amount
        FHE.allowSender(amount); // Creator can see the amount

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

    /// @notice Pay a payment request (step 1 of 2). Only the designated payer
    ///         can call this. The payer must have approved this contract on
    ///         the FHERC20Vault.
    /// @dev    Only the exact requested amount, or nothing, is ever sent:
    ///         a mismatched input is replaced by zero before the transfer, and
    ///         the vault itself moves zero on a short balance. The request
    ///         goes to Settling with a public ebool `moved == requested`;
    ///         finalizeRequest publishes its decryption and only then marks
    ///         the request Fulfilled (or returns it to Pending if nothing
    ///         moved). A request can therefore never read Fulfilled unpaid.
    /// @param requestId The request to pay
    /// @param encAmount Encrypted amount to pay (must equal the request)
    function fulfillRequest(
        uint256 requestId,
        externalEuint64 encAmount, bytes calldata proof
    ) external nonReentrant {
        PaymentRequest storage req = _requests[requestId];
        require(req.status == RequestStatus.Pending, "PaymentHub: not pending");
        require(msg.sender == req.from, "PaymentHub: not the payer");
        // Requests created before the allowlist may name any vault; a fake
        // one would forge the creator's income via the receipt bump.
        _requireVault(req.vault);

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);
        euint64 toSend = FHE.select(FHE.eq(verifiedAmount, req.amount), req.amount, FHE.asEuint64(0));

        euint64 actual = FHE.receiveEuint64FromCall(
            IFHERC20Vault(req.vault).transferFromVerified(msg.sender, req.to, FHE.shareEuint64(toSend, req.vault)),
            req.vault
        );
        FHE.allowSender(actual);  // Payer can verify transfer succeeded
        FHE.allow(actual, req.to);
        FHE.allowThis(actual);    // Needed for the bump in finalizeRequest

        ebool paid = FHE.eq(actual, req.amount);
        FHE.allowThis(paid);
        FHE.allowPublic(paid);
        _fulfillCheck[requestId] = paid;
        _fulfillMoved[requestId] = actual;
        req.status = RequestStatus.Settling;

        emit RequestSettling(requestId, block.timestamp);
    }

    /// @notice Settle a paid request (step 2 of 2). Anyone may call with the
    ///         Threshold Network decryption of getFulfillCheck(requestId).
    ///         true: Fulfilled. false: nothing moved, back to Pending so the
    ///         payer can retry or the creator can cancel.
    function finalizeRequest(uint256 requestId, bool paidPlaintext, bytes calldata signature) external nonReentrant {
        PaymentRequest storage req = _requests[requestId];
        require(req.status == RequestStatus.Settling, "PaymentHub: not settling");
        ebool check = _fulfillCheck[requestId];
        FHE.publishDecryptResult(check, paidPlaintext, signature);
        (bool paid, bool ready) = FHE.getDecryptResultSafe(check);
        require(ready, "PaymentHub: decryption not ready");

        if (paid) {
            req.status = RequestStatus.Fulfilled;
            // Receipts only count a settled payment; failed attempts would
            // otherwise inflate the tx counters without limit.
            euint64 moved = _fulfillMoved[requestId];
            if (FHE.isInitialized(moved)) _bumpAggregate(req.to, moved);
            emit RequestFulfilled(requestId, req.vault, block.timestamp);
            try eventHub.emitActivity(req.from, req.to, "request_fulfilled", req.note, requestId) {} catch {}
        } else {
            req.status = RequestStatus.Pending;
            emit RequestFulfillFailed(requestId, block.timestamp);
        }
    }

    /// @notice The public ebool "moved == requested" for a Settling request.
    function getFulfillCheck(uint256 requestId) external view returns (ebool) {
        return _fulfillCheck[requestId];
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
        externalEuint64[] calldata amounts,
        bytes calldata proof,
        string[] calldata notes
    ) external nonReentrant {
        uint256 count = recipients.length;
        require(count > 0, "PaymentHub: empty batch");
        require(count <= MAX_BATCH_SIZE, "PaymentHub: max 30 recipients");
        require(count == amounts.length, "PaymentHub: length mismatch");
        require(count == notes.length, "PaymentHub: notes length mismatch");
        _requireVault(vault);

        IFHERC20Vault vaultContract = IFHERC20Vault(vault);

        // One batch signature covers every amount in the batch.
        euint64[] memory verifiedAmounts = FHE.asEuint64s(amounts, proof);

        for (uint256 i = 0; i < count; i++) {
            require(recipients[i] != address(0) && recipients[i] != msg.sender, "PaymentHub: invalid recipient");
            euint64 actual = FHE.receiveEuint64FromCall(
                vaultContract.transferFromVerified(
                    msg.sender,
                    recipients[i],
                    FHE.shareEuint64(verifiedAmounts[i], vault)
                ),
                vault
            );
            FHE.allowSender(actual);
            FHE.allow(actual, recipients[i]);
            FHE.allowThis(actual);
            // #207: per-recipient bump (each amount is encrypted independently,
            // so this can't be batched into a single global call — the per-user
            // counter genuinely needs the per-recipient `actual`).
            _bumpAggregate(recipients[i], actual);
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
        externalEuint64 encAmount, bytes calldata proof,
        string calldata note,
        address agent,
        bytes32 nonce,
        uint256 expiry,
        bytes calldata agentSignature
    ) external nonReentrant {
        require(to != address(0) && to != msg.sender, "PaymentHub: invalid recipient");
        _requireVault(vault);
        require(agent != address(0), "PaymentHub: agent zero");
        // #245 — Tighten from <= to <. The attestation's `expiry` is the first
        // block.timestamp at which the signature is considered invalid, not the
        // last valid second. Previously a submission landing at exactly `expiry`
        // squeaked through. Strict inequality closes that boundary.
        require(block.timestamp < expiry, "PaymentHub: agent attestation expired");
        require(!_usedAgentNonces[nonce], "PaymentHub: agent nonce already used");

        // Verify ECDSA attestation BEFORE consuming the nonce — keeps reverts
        // cheap for replay attempts and lets the recovered != expected case
        // surface a clear error.
        bytes32 digest = agentDigest(msg.sender, nonce, expiry);
        address recovered = ECDSA.recover(digest, agentSignature);
        require(recovered == agent, "PaymentHub: invalid agent signature");

        _usedAgentNonces[nonce] = true;

        // Identical settlement path to sendPayment — verify in caller context
        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);
        euint64 actual = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vault).transferFromVerified(msg.sender, to, FHE.shareEuint64(verifiedAmount, vault)),
            vault
        );
        FHE.allowSender(actual);
        FHE.allowThis(actual);
        _bumpAggregate(to, actual);

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
        require(_eventHub.code.length > 0, "PaymentHub: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "PaymentHub: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    /// @dev Fails closed: no registry means no vault is trusted.
    function _requireVault(address vault) internal view {
        require(
            address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault),
            "PaymentHub: vault not allowed"
        );
    }

    /// @notice Set the PaymentReceipts contract address. When non-zero,
    ///         sendPayment / batchSend / sendPaymentAsAgent forward the
    ///         transferred amount to paymentReceipts.bumpGlobalVolume so
    ///         the landing-page counter increments.
    ///         Zero turns the bump off; anything else must be a contract.
    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        require(
            _paymentReceipts == address(0) || _paymentReceipts.code.length > 0,
            "PaymentHub: bad receipts"
        );
        address previous = paymentReceipts;
        paymentReceipts = _paymentReceipts;
        emit PaymentReceiptsSet(previous, _paymentReceipts);
    }

    /// @dev Internal: forward an already-verified euint64 to PaymentReceipts.
    ///      Bumps both the global aggregate AND the recipient's per-user
    ///      `_totalReceived` counter so anyone receiving payments via PaymentHub
    ///      can later call proveIncomeAbove. Each external call is wrapped in
    ///      try/catch — never blocks the payment if the receipts contract
    ///      reverts (e.g. if PaymentHub isn't authorized yet).
    ///
    ///      Note: allowTransient is scoped to a single external call frame, so
    ///      we must re-authorize the amount handle before each cross-contract
    ///      call. Mirrors BusinessHub._bumpReceipts.
    ///
    ///      The per-user counter records gross inflow. Money a user sends out
    ///      and gets sent back counts twice, so PaymentReceipts.proveIncomeAbove
    ///      proves gross received volume, not net income or a balance.
    function _bumpAggregate(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        // Global aggregate (landing-page counter).
        try IPaymentReceipts(paymentReceipts).bumpGlobalVolume(FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
        // Per-recipient income counter — enables proveIncomeAbove for anyone
        // who only ever receives via PaymentHub (sendPayment / batchSend /
        // fulfillRequest / sendPaymentAsAgent). Per #207.
        if (recipient == address(0)) return;
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
    }

    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @notice Vault allowlist. Unset = every payment entry point reverts.
    ITokenRegistry public tokenRegistry;

    /// @dev requestId => public ebool "moved == requested" for finalizeRequest.
    mapping(uint256 => ebool) private _fulfillCheck;

    /// @dev requestId => handle moved by the last fulfillRequest attempt.
    mapping(uint256 => euint64) private _fulfillMoved;

    /// @dev Used: 11. Gap: 47.
    uint256[47] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
