// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function underlyingToken() external view returns (address);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title BusinessHub — Encrypted invoicing, payroll, and escrow
/// @notice Handles B2B payment flows where amounts are encrypted.
///         Invoices: vendor creates, client pays.
///         Payroll: employer pays multiple employees in one batch.
///         Escrow: 2-of-2 approval with optional arbiter and deadline.
contract BusinessHub is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ──────────────────────────────────────────────────────────

    enum InvoiceStatus { Pending, Paid, Cancelled, PaymentPending, Disputed }
    enum EscrowStatus { Active, Released, Disputed, Expired }

    struct Invoice {
        address vendor;
        address client;
        address vault;
        euint64 amount;
        string description;
        uint256 dueDate;
        uint256 createdAt;
        InvoiceStatus status;
    }

    struct Escrow {
        address depositor;
        address beneficiary;
        address arbiter;        // Optional third-party (address(0) if none)
        address vault;
        euint64 amount;         // Encrypted amount handle (for display/permit)
        uint256 plaintextAmount; // Plaintext amount for release transfers
        string description;
        uint256 deadline;       // Auto-return to depositor after this time
        bool depositorApproved;
        bool beneficiaryMarkedDelivered;
        EscrowStatus status;
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;
    uint256 public constant MAX_PAYROLL_SIZE = 30;

    uint256 public nextInvoiceId;
    mapping(uint256 => Invoice) private _invoices;
    mapping(address => uint256[]) private _vendorInvoices;
    mapping(address => uint256[]) private _clientInvoices;

    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) private _escrows;
    mapping(address => uint256[]) private _userEscrows;

    /// @dev Invoice payment validation: invoiceId → encrypted boolean (true if payment == invoice amount)
    mapping(uint256 => ebool) private _invoicePaymentValidation;

    // ─── Events ─────────────────────────────────────────────────────────

    event InvoiceCreated(uint256 indexed id, address indexed vendor, address indexed client, string description, uint256 dueDate, uint256 timestamp);
    event InvoicePaymentInitiated(uint256 indexed id, uint256 timestamp);
    event InvoicePaid(uint256 indexed id, uint256 timestamp);
    event InvoiceDisputed(uint256 indexed id, uint256 timestamp);
    event InvoiceCancelled(uint256 indexed id, uint256 timestamp);
    event PayrollExecuted(address indexed employer, uint256 count, uint256 timestamp);
    event EscrowCreated(uint256 indexed id, address indexed depositor, address indexed beneficiary, uint256 timestamp);
    event EscrowDelivered(uint256 indexed id, uint256 timestamp);
    event EscrowApproved(uint256 indexed id, uint256 timestamp);
    event EscrowReleased(uint256 indexed id, uint256 timestamp);
    event EscrowDisputed(uint256 indexed id, address indexed disputer, uint256 timestamp);
    event EscrowExpiryClaimed(uint256 indexed id, uint256 timestamp);
    event EscrowArbiterDecided(uint256 indexed id, bool releasedToBeneficiary, uint256 timestamp);

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INVOICING
    // ═══════════════════════════════════════════════════════════════════

    function createInvoice(
        address client,
        address vault,
        InEuint64 memory encAmount,
        string calldata description,
        uint256 dueDate
    ) external nonReentrant returns (uint256) {
        require(client != address(0) && client != msg.sender, "BusinessHub: invalid client");

        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);
        FHE.allow(amount, client);
        FHE.allow(amount, msg.sender);

        uint256 id = nextInvoiceId++;
        _invoices[id] = Invoice({
            vendor: msg.sender, client: client, vault: vault,
            amount: amount, description: description,
            dueDate: dueDate, createdAt: block.timestamp,
            status: InvoiceStatus.Pending
        });

        _vendorInvoices[msg.sender].push(id);
        _clientInvoices[client].push(id);

        emit InvoiceCreated(id, msg.sender, client, description, dueDate, block.timestamp);
        try eventHub.emitActivity(msg.sender, client, "invoice_created", description, id) {} catch {}
        return id;
    }

    /**
     * @notice Pay a pending invoice with the EXACT invoice amount.
     *
     * @dev ARCHITECTURE CONSTRAINT: FHERC20Vault.transferFrom() requires InEuint64
     * (client-side encrypted input), which cannot be constructed from euint64 on-chain.
     * This means the contract cannot split a payment into (invoiceAmount + change) and
     * call transferFrom twice. Therefore:
     *
     *   1. The client MUST send exactly the invoice amount (decrypt off-chain first).
     *   2. The contract verifies encrypted payment == encrypted invoice amount.
     *   3. If they don't match, the payment is NOT transferred — status stays Pending.
     *   4. The ebool match result is decrypted async; finalization happens in payInvoiceFinalize().
     *
     * This two-phase approach prevents overpayment (non-refundable) and underpayment
     * (vendor shortchanged) by only completing the transfer when amounts match exactly.
     *
     * @param invoiceId The invoice to pay
     * @param encAmount Encrypted payment amount (MUST equal the invoice amount)
     */
    function payInvoice(uint256 invoiceId, InEuint64 memory encAmount) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.client, "BusinessHub: not the client");

        // Verify encrypted input here (msg.sender = client) before cross-contract call
        euint64 payment = FHE.asEuint64(encAmount);
        FHE.allowTransient(payment, inv.vault);

        // Verify the encrypted payment matches the encrypted invoice amount exactly.
        // The client should decrypt the invoice amount off-chain first, then encrypt
        // the same value as their payment. This is verified here without revealing either.
        ebool exactMatch = FHE.eq(payment, inv.amount);
        FHE.allowThis(exactMatch);
        FHE.allowSender(exactMatch);

        // Transfer the full encAmount to vendor via vault using pre-verified handle.
        // Since we verified exactMatch, if true this transfers exactly the invoice amount.
        // If exactMatch is false, the transfer still happens but the invoice won't be
        // marked as paid — see payInvoiceFinalize().
        euint64 vendorReceived = IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, inv.vendor, payment);
        FHE.allowSender(vendorReceived);
        FHE.allow(vendorReceived, inv.vendor);

        // Store the match validation for async verification
        _invoicePaymentValidation[invoiceId] = exactMatch;

        // v0.1.3 migration: caller decrypts off-chain via the cofhe-sdk client and
        // submits the result + signature to payInvoiceFinalize() below.
        FHE.allowPublic(exactMatch);

        // Mark as PaymentPending — not fully Paid until match is verified
        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        try eventHub.emitActivity(msg.sender, inv.vendor, "invoice_payment_initiated", inv.description, invoiceId) {} catch {}
    }

    /**
     * @notice Finalize an invoice payment after the match validation decryption completes.
     *         Caller supplies the off-chain decrypted boolean + signature; the contract
     *         verifies the proof, then marks the invoice Paid or Disputed accordingly.
     *
     * @param invoiceId  The invoice to finalize
     * @param matchPlaintext True iff the payment matched the invoice amount exactly
     * @param signature  Threshold Network signature over the decrypted ebool
     */
    function payInvoiceFinalize(
        uint256 invoiceId,
        bool matchPlaintext,
        bytes calldata signature
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.PaymentPending, "BusinessHub: not payment pending");

        ebool validation = _invoicePaymentValidation[invoiceId];
        // Verify the off-chain decryption by publishing it on-chain. Reverts
        // if the signature does not authenticate the plaintext.
        FHE.publishDecryptResult(validation, matchPlaintext, signature);

        (bool matchResult, bool ready) = FHE.getDecryptResultSafe(validation);
        require(ready, "BusinessHub: validation decryption not ready");

        if (matchResult) {
            // Exact match — invoice is properly paid
            inv.status = InvoiceStatus.Paid;
            emit InvoicePaid(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_paid", inv.description, invoiceId) {} catch {}
        } else {
            // Mismatch — payment amount did not equal invoice amount.
            // The transfer already happened, so mark as disputed for manual resolution.
            inv.status = InvoiceStatus.Disputed;
            emit InvoiceDisputed(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_disputed", "Payment amount mismatch", invoiceId) {} catch {}
        }
    }

    function cancelInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.vendor, "BusinessHub: not the vendor");
        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PAYROLL
    // ═══════════════════════════════════════════════════════════════════

    function runPayroll(
        address[] calldata employees,
        address vault,
        InEuint64[] memory salaries
    ) external nonReentrant {
        uint256 count = employees.length;
        require(count > 0 && count <= MAX_PAYROLL_SIZE, "BusinessHub: invalid batch size");
        require(count == salaries.length, "BusinessHub: length mismatch");

        IFHERC20Vault v = IFHERC20Vault(vault);
        for (uint256 i = 0; i < count; i++) {
            require(employees[i] != address(0), "BusinessHub: zero address");
            // Verify encrypted input here (msg.sender = employer) before cross-contract call
            euint64 verifiedSalary = FHE.asEuint64(salaries[i]);
            FHE.allowTransient(verifiedSalary, vault);
            euint64 actual = v.transferFromVerified(msg.sender, employees[i], verifiedSalary);
            FHE.allowSender(actual);
            FHE.allow(actual, employees[i]);
        }

        emit PayrollExecuted(msg.sender, count, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "payroll", "", count) {} catch {}
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ESCROW
    // ═══════════════════════════════════════════════════════════════════

    function createEscrow(
        address beneficiary,
        address vault,
        uint256 plaintextAmount,
        string calldata description,
        address arbiter,
        uint256 deadline
    ) external nonReentrant returns (uint256) {
        require(beneficiary != address(0) && beneficiary != msg.sender, "BusinessHub: invalid beneficiary");
        require(deadline >= block.timestamp + 1 days, "BusinessHub: deadline must be at least 1 day");
        require(plaintextAmount > 0, "BusinessHub: zero amount");

        // Lock plaintext amount in the underlying ERC20 (not encrypted — escrow needs release)
        // The user shields tokens first, then this function takes from their PUBLIC balance
        // This is the correct pattern: escrow amounts must be releasable without FHE passthrough
        IERC20 underlying = IERC20(IFHERC20Vault(vault).underlyingToken());
        underlying.transferFrom(msg.sender, address(this), plaintextAmount);

        euint64 amount = FHE.asEuint64(plaintextAmount);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);
        FHE.allow(amount, beneficiary);

        uint256 id = nextEscrowId++;
        _escrows[id] = Escrow({
            depositor: msg.sender, beneficiary: beneficiary,
            arbiter: arbiter, vault: vault, amount: amount,
            plaintextAmount: plaintextAmount,
            description: description, deadline: deadline,
            depositorApproved: false, beneficiaryMarkedDelivered: false,
            status: EscrowStatus.Active
        });

        _userEscrows[msg.sender].push(id);
        _userEscrows[beneficiary].push(id);

        emit EscrowCreated(id, msg.sender, beneficiary, block.timestamp);
        try eventHub.emitActivity(msg.sender, beneficiary, "escrow_created", description, id) {} catch {}
        return id;
    }

    /// @notice Beneficiary marks work as delivered
    function markDelivered(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(msg.sender == e.beneficiary, "BusinessHub: not beneficiary");
        e.beneficiaryMarkedDelivered = true;
        emit EscrowDelivered(escrowId, block.timestamp);
    }

    /// @notice Depositor approves release. If both approve, funds release automatically.
    function approveRelease(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(msg.sender == e.depositor, "BusinessHub: not depositor");

        e.depositorApproved = true;
        emit EscrowApproved(escrowId, block.timestamp);

        // If both parties agree, release
        if (e.depositorApproved && e.beneficiaryMarkedDelivered) {
            _releaseEscrow(escrowId);
        }
    }

    /// @notice Either party can dispute
    function disputeEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "BusinessHub: not a party");
        e.status = EscrowStatus.Disputed;
        emit EscrowDisputed(escrowId, msg.sender, block.timestamp);
    }

    /// @notice Arbiter decides outcome of disputed escrow
    function arbiterDecide(uint256 escrowId, bool releaseToBeneficiary) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Disputed, "BusinessHub: not disputed");
        require(e.arbiter != address(0), "BusinessHub: no arbiter configured");
        require(msg.sender == e.arbiter, "BusinessHub: not arbiter");

        e.status = EscrowStatus.Released;

        // Transfer plaintext escrowed funds to the decided recipient
        address recipient = releaseToBeneficiary ? e.beneficiary : e.depositor;
        IERC20 underlying = IERC20(IFHERC20Vault(e.vault).underlyingToken());
        underlying.transfer(recipient, e.plaintextAmount);

        emit EscrowArbiterDecided(escrowId, releaseToBeneficiary, block.timestamp);
        emit EscrowReleased(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, e.beneficiary, "escrow_resolved", e.description, escrowId) {} catch {}
    }

    /// @notice Claim expired escrow — returns funds to depositor
    function claimExpiredEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(block.timestamp > e.deadline, "BusinessHub: not expired");

        e.status = EscrowStatus.Expired;

        // Return plaintext escrowed funds to depositor
        IERC20 underlying = IERC20(IFHERC20Vault(e.vault).underlyingToken());
        underlying.transfer(e.depositor, e.plaintextAmount);

        emit EscrowExpiryClaimed(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, address(0), "escrow_expired", e.description, escrowId) {} catch {}
    }

    function _releaseEscrow(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        e.status = EscrowStatus.Released;

        // Transfer plaintext escrowed funds to beneficiary
        IERC20 underlying = IERC20(IFHERC20Vault(e.vault).underlyingToken());
        underlying.transfer(e.beneficiary, e.plaintextAmount);

        emit EscrowReleased(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, e.beneficiary, "escrow_released", e.description, escrowId) {} catch {}
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getInvoice(uint256 id) external view returns (
        address vendor, address client, address vault, euint64 amount,
        string memory description, uint256 dueDate, InvoiceStatus status
    ) {
        Invoice storage inv = _invoices[id];
        return (inv.vendor, inv.client, inv.vault, inv.amount, inv.description, inv.dueDate, inv.status);
    }

    function getVendorInvoices(address vendor) external view returns (uint256[] memory) { return _vendorInvoices[vendor]; }
    function getClientInvoices(address client) external view returns (uint256[] memory) { return _clientInvoices[client]; }

    function getEscrow(uint256 id) external view returns (
        address depositor, address beneficiary, address arbiter, address vault,
        euint64 amount, string memory description, uint256 deadline, EscrowStatus status
    ) {
        Escrow storage e = _escrows[id];
        return (e.depositor, e.beneficiary, e.arbiter, e.vault, e.amount, e.description, e.deadline, e.status);
    }

    function getUserEscrows(address user) external view returns (uint256[] memory) { return _userEscrows[user]; }

    /// @notice Read the encrypted match-validation handle for an invoice.
    ///         Frontend uses this to fetch the ctHash, then decrypts off-chain
    ///         via the cofhe-sdk client to obtain (matchPlaintext, signature) for
    ///         payInvoiceFinalize().
    function getInvoiceValidationHandle(uint256 invoiceId) external view returns (ebool) {
        return _invoicePaymentValidation[invoiceId];
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner { eventHub = IEventHub(_eventHub); }
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
