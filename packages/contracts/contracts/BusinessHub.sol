// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
    function transferVerified(address to, sharedEuint64 shared) external returns (sharedEuint64);
    function underlyingToken() external view returns (address);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, sharedEuint64 shared) external;
    function bumpGlobal(sharedEuint64 shared) external;
}

/// @title BusinessHub — Encrypted invoicing, payroll, and escrow
/// @notice Invoices and payroll move encrypted vault balances.
///         Escrow here is a PLAINTEXT ERC20 deposit: the amount is public in
///         calldata and in the token transfer. The euint64 copy stored on the
///         record is a convenience handle, not a privacy guarantee. Use
///         EncryptedEscrow when the amount must stay private.
contract BusinessHub is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────

    enum InvoiceStatus { Pending, Paid, Cancelled, PaymentPending, Disputed }
    enum EscrowStatus { Active, Released, Disputed, Expired }
    /// @dev Legacy = paid before modes were recorded (or not paid at all).
    enum PaymentMode { Legacy, Direct, Escrow }

    /// @dev Anyone may route a funded escrowed invoice once this long has
    ///      passed since payment, so a silent client cannot strand the vendor.
    uint256 public constant INVOICE_ESCROW_RELEASE_DELAY = 7 days;
    /// @dev A disputed escrow the arbiter never decides returns to the
    ///      depositor after this long. Mirrors EncryptedEscrow.
    uint256 public constant ESCROW_DISPUTE_TIMEOUT = 30 days;

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

    // ─── #92: PaymentReceipts wiring (v0.1.4, append-only storage) ──────
    // When non-zero, runPayroll forwards each per-recipient transferred
    // amount to paymentReceipts.bumpUserReceived(recipient, actual) and
    // increments the global aggregate via paymentReceipts.bumpGlobal. This
    // lets payroll employees prove their income via proveIncomeAbove —
    // previously their _totalReceived counter never bumped because
    // runPayroll bypassed issueReceipt entirely.
    //
    // Must be appended after all prior state (UUPS storage-layout rule).
    // Zero-address = feature off (back-compat with pre-#92 deployments).
    address public paymentReceipts;

    // ─── #214: Invoice payment race-prevention (v0.1.7, append-only storage) ──
    // Tracks which address first started paying an invoice. Once set, only
    // that address may continue paying or finalizing — preventing two clients
    // from simultaneously transferring funds and only one being able to
    // finalize. Stored as a separate mapping (NOT appended to the Invoice
    // struct) because modifying struct shape in storage is forbidden under
    // UUPS storage-layout rules.
    //
    // Reset to address(0) by cancelInvoice so a fresh payment attempt is
    // possible after vendor cancels. Same caller may retry payInvoice
    // (the require check is idempotent for the original payer).
    mapping(uint256 => address) public invoicePaymentStartedBy;

    // ─── #225: On-chain CID anchoring (v0.1.8, append-only storage) ─────
    // Phase 3.5 — keccak256 of the IPFS CID for invoice PDFs and escrow
    // attachments. The actual CID strings live off-chain in Supabase; the
    // hash on-chain lets a third party verify the off-chain file hasn't
    // been swapped post-hoc. Side mappings (NOT struct fields) to keep the
    // Invoice / Escrow struct shapes locked — UUPS storage-layout rule.
    //
    // Mutability: writable by the legitimate party (vendor for invoices,
    // either party for escrows) only while the record is still open
    // (Pending/PaymentPending for invoices, Active for escrows). Once the
    // record finalizes, the hash freezes — settlement evidence cannot be
    // back-dated.
    mapping(uint256 => bytes32) public invoicePdfCidHash;
    mapping(uint256 => bytes32) public escrowAttachmentCidHash;

    // ─── Phase 5.7 — signed-oracle fallback (v0.2.0, append-only) ───────
    //
    // For token pairs Uniswap doesn't cover (exotic ERC-20s, stable-stable
    // pairs without testnet pools), the payer can submit an off-chain
    // ECDSA-signed price quote from a known oracle address. This contract
    // verifies the signature + sanity-bounds the rate, then settles the
    // invoice using the quoted conversion factor.
    //
    // Slot 14 (next free after slot 13 = escrowAttachmentCidHash). Owner
    // sets the oracle address via `setOracleAttestationAddress` post-deploy
    // — typically the same wallet that derives from `ORACLE_PRIVATE_KEY`
    // env in the backend `/api/oracle/quote` endpoint.
    //
    // Why not hard-code: rotating a compromised oracle key requires
    // changing this address. A constant would force a contract redeploy.
    /// @dev Unused since the oracle path was retired. Slot kept for layout.
    address public oracleAttestationAddress;

    /// @dev Per-payer nonce tracker for `payInvoiceWithOracleQuote`.
    ///      Prevents replay of a single signed quote. Keyed by
    ///      (msg.sender, nonce) so a payer can't pollute another
    ///      payer's nonce slot. Slot 15 (append-only).
    mapping(address payer => mapping(bytes32 nonce => bool used)) private _oracleQuoteUsed;

    /// @dev Private invoice escrow (PR-C). Holds the verified handle of the
    ///      client's payment until `releaseInvoiceEscrow` reveals whether
    ///      the encrypted amount matches the invoice — at which point the
    ///      handle is released to the vendor (match) or refunded to the
    ///      client (mismatch). Cleared on release/refund. Append-only
    ///      slot — must remain last under UUPS storage rules.
    mapping(uint256 => euint64) private _invoiceEscrowHeld;

    // ─── Events ─────────────────────────────────────────────────────────

    event InvoiceCreated(uint256 indexed id, address indexed vendor, address indexed client, string description, uint256 dueDate, uint256 timestamp);
    event InvoicePaymentInitiated(uint256 indexed id, uint256 timestamp);
    /// @dev Phase 5.6 — emitted when a token-agnostic swap-then-pay flow runs.
    ///      `payToken` is the original token spent by the payer, `amountIn`
    ///      is what was actually consumed (may be less than max if the swap
    ///      undershoots), `amountOut` is the USDC delivered to the vendor.
    event InvoicePaymentSwapped(
        uint256 indexed id,
        address indexed payToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 timestamp
    );
    /// @dev Phase 5.7 — emitted on `payInvoiceWithOracleQuote`. `ratePpm`
    ///      is the quote's tokenOut-per-tokenIn rate scaled by 1e6 (parts-
    ///      per-million); `amountIn` is what was pulled from the payer.
    event InvoicePaymentOracleSettled(
        uint256 indexed id,
        address indexed payToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 ratePpm,
        uint256 timestamp
    );
    /// @dev Phase 5.7 — owner-fired when the oracle attestation address
    ///      rotates (e.g. key rotation post-incident). Pre-rotation
    ///      signatures stop verifying immediately.
    event OracleAddressUpdated(address indexed previous, address indexed current);
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
    event InvoicePdfCidSet(uint256 indexed id, bytes32 cidHash, uint256 timestamp);
    event EscrowAttachmentCidSet(uint256 indexed id, bytes32 cidHash, uint256 timestamp);
    event ReceiptsBumpFailed(string kind, bytes reason);
    event PaymentReceiptsSet(address indexed previous, address indexed current);
    event TokenRegistrySet(address indexed registry);
    event InvoiceRefundInitiated(uint256 indexed id, uint256 timestamp);
    event InvoiceRefundFailed(uint256 indexed id, uint256 timestamp);
    event InvoiceEscrowRevalidated(uint256 indexed id, uint256 timestamp);
    event EscrowDisputeTimedOut(uint256 indexed id, uint256 timestamp);
    event LegacyEscrowUnresolved(uint256 indexed id);

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
        externalEuint64 encAmount, bytes calldata proof,
        string calldata description,
        uint256 dueDate
    ) external nonReentrant returns (uint256) {
        require(client != address(0) && client != msg.sender, "BusinessHub: invalid client");
        // Audit P2.15: cap description bytes so an attacker can't grief
        // the contract with multi-KB on-chain strings (cheap storage-bloat
        // griefing). 512 bytes is generous for any real invoice memo.
        require(bytes(description).length <= 512, "BusinessHub: description too long");
        _requireAllowedVault(vault);

        euint64 amount = FHE.asEuint64(encAmount, proof);
        FHE.allowThis(amount);
        FHE.allow(amount, client);
        FHE.allowSender(amount);

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
     * @notice Pay a pending invoice straight to the vendor.
     *
     * @dev The vault moves either the full requested amount or 0 (short
     *      balance or allowance). The match check therefore runs on the
     *      amount the vault reports as MOVED, never on the client's request,
     *      so Paid always means the vendor received exactly inv.amount.
     *      The ebool is decrypted off-chain and settled by payInvoiceFinalize.
     *
     * @param invoiceId The invoice to pay
     * @param encAmount Encrypted payment amount (should equal the invoice amount)
     */
    function payInvoice(uint256 invoiceId, externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.client, "BusinessHub: not the client");
        _requireAllowedVault(inv.vault);

        // #214: lock first payer in. Same caller may retry (idempotent).
        if (invoicePaymentStartedBy[invoiceId] != address(0)) {
            require(invoicePaymentStartedBy[invoiceId] == msg.sender, "BusinessHub: payment already started by another address");
        }
        invoicePaymentStartedBy[invoiceId] = msg.sender;

        // Verify encrypted input here (msg.sender = client) before cross-contract call
        euint64 payment = FHE.asEuint64(encAmount, proof);

        euint64 vendorReceived = FHE.receiveEuint64FromCall(
            IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, inv.vendor, FHE.shareEuint64(payment, inv.vault)),
            inv.vault
        );
        FHE.allowThis(vendorReceived);
        FHE.allowSender(vendorReceived);
        FHE.allow(vendorReceived, inv.vendor);
        _invoicePaidAmount[invoiceId] = vendorReceived;

        ebool exactMatch = _verifyEncryptedMatch(vendorReceived, inv.amount);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;

        invoicePaymentMode[invoiceId] = PaymentMode.Direct;
        invoicePaidAt[invoiceId] = block.timestamp;
        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        try eventHub.emitActivity(msg.sender, inv.vendor, "invoice_payment_initiated", inv.description, invoiceId) {} catch {}
    }

    /**
     * @notice Settle a direct (payInvoice) payment once its match ebool is
     *         decrypted: Paid on match, Disputed otherwise.
     *
     * @dev Escrowed payments are rejected here; they settle through
     *      releaseInvoiceEscrow, which also routes the held funds.
     *      Legacy records (paid before payment modes were recorded, including
     *      the retired swap and oracle paths) matched the client's REQUEST,
     *      not what the vendor got, so only the vendor may finalize them.
     *
     * @param invoiceId  The invoice to finalize
     * @param matchPlaintext True iff the moved amount equals the invoice amount
     * @param signature  Threshold Network signature over the decrypted ebool
     */
    function payInvoiceFinalize(
        uint256 invoiceId,
        bool matchPlaintext,
        bytes calldata signature
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.PaymentPending, "BusinessHub: not payment pending");
        require(!_isEscrowPayment(invoiceId), "BusinessHub: escrow payment, use releaseInvoiceEscrow");

        if (invoicePaymentMode[invoiceId] == PaymentMode.Direct) {
            // The signed decrypt fixes the outcome, so the vendor may finalize
            // too; otherwise a silent client could stall the invoice forever.
            require(msg.sender == inv.client || msg.sender == inv.vendor, "BusinessHub: only client or vendor can finalize");
        } else {
            require(msg.sender == inv.vendor, "BusinessHub: legacy payment, vendor must finalize");
        }

        ebool validation = _invoicePaymentValidation[invoiceId];
        // Reverts if the signature does not authenticate the plaintext.
        FHE.publishDecryptResult(validation, matchPlaintext, signature);

        (bool matchResult, bool ready) = FHE.getDecryptResultSafe(validation);
        require(ready, "BusinessHub: validation decryption not ready");

        if (matchResult) {
            inv.status = InvoiceStatus.Paid;
            emit InvoicePaid(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_paid", inv.description, invoiceId) {} catch {}
        } else {
            // Funds already moved; refundDisputedInvoice returns them.
            inv.status = InvoiceStatus.Disputed;
            emit InvoiceDisputed(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_disputed", "Payment amount mismatch", invoiceId) {} catch {}
        }
        // _invoicePaymentValidation persists; the status field gates re-entry.
    }

    function cancelInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.vendor, "BusinessHub: not the vendor");
        inv.status = InvoiceStatus.Cancelled;
        invoicePaymentStartedBy[invoiceId] = address(0);
        emit InvoiceCancelled(invoiceId, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────
    //  PRIVATE INVOICE ESCROW (PR-C)
    //
    //  Holds the client's encrypted payment in this contract until the
    //  match is verified, then releases it to the vendor (match) or refunds
    //  the payer (mismatch). No vendor cooperation required.
    // ─────────────────────────────────────────────────────────────────

    /// @notice Escrow-flavoured payInvoice. Funds sit in BusinessHub's vault
    ///         balance until releaseInvoiceEscrow finalizes the match check.
    /// @param invoiceId Invoice id (must be Pending).
    /// @param encAmount Client's encrypted payment.
    function payInvoiceEscrow(uint256 invoiceId, externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.client, "BusinessHub: not the client");
        require(invoicePaymentStartedBy[invoiceId] == address(0), "BusinessHub: already paying");
        _requireAllowedVault(inv.vault);
        invoicePaymentStartedBy[invoiceId] = msg.sender;

        euint64 payment = FHE.asEuint64(encAmount, proof);

        // The returned handle is what actually landed here (0 on short
        // balance). It is both what we hold and what we match.
        euint64 held = FHE.receiveEuint64FromCall(
            IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, address(this), FHE.shareEuint64(payment, inv.vault)),
            inv.vault
        );
        FHE.allowThis(held);
        FHE.allowSender(held);
        _invoiceEscrowHeld[invoiceId] = held;

        ebool exactMatch = _verifyEncryptedMatch(held, inv.amount);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;

        invoicePaymentMode[invoiceId] = PaymentMode.Escrow;
        invoicePaidAt[invoiceId] = block.timestamp;
        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        try eventHub.emitActivity(msg.sender, inv.vendor, "invoice_escrow_funded", inv.description, invoiceId) {} catch {}
    }

    /// @notice Escrowed invoices funded before this upgrade matched the
    ///         client's REQUEST, which can be true while 0 was held. This
    ///         recomputes the check on the held handle. Anyone may call;
    ///         the result must then be decrypted and passed to
    ///         releaseInvoiceEscrow.
    function revalidateLegacyInvoiceEscrow(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.PaymentPending, "BusinessHub: not payment pending");
        require(
            invoicePaymentMode[invoiceId] == PaymentMode.Legacy && _isEscrowPayment(invoiceId),
            "BusinessHub: not a legacy escrow payment"
        );
        ebool exactMatch = _verifyEncryptedMatch(_invoiceEscrowHeld[invoiceId], inv.amount);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;
        invoicePaymentMode[invoiceId] = PaymentMode.Escrow;
        if (invoicePaidAt[invoiceId] == 0) invoicePaidAt[invoiceId] = block.timestamp;
        emit InvoiceEscrowRevalidated(invoiceId, block.timestamp);
    }

    /// @notice Settle an escrowed invoice payment. The caller supplies the
    ///         decrypted match result + signature; it is verified on-chain,
    ///         then the held funds go to the vendor (match) or back to the
    ///         payer (mismatch).
    /// @dev    The outcome is fixed by the verified decrypt, so the caller
    ///         only controls timing. The client may settle at any time; after
    ///         INVOICE_ESCROW_RELEASE_DELAY anyone may, so a silent client
    ///         cannot strand the vendor.
    function releaseInvoiceEscrow(
        uint256 invoiceId,
        bool matchPlaintext,
        bytes calldata signature
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.PaymentPending, "BusinessHub: not payment pending");
        require(invoicePaymentMode[invoiceId] == PaymentMode.Escrow, "BusinessHub: not an escrow payment");
        if (msg.sender != inv.client) {
            require(
                block.timestamp >= invoicePaidAt[invoiceId] + INVOICE_ESCROW_RELEASE_DELAY,
                "BusinessHub: only client can finalize"
            );
        }

        ebool validation = _invoicePaymentValidation[invoiceId];
        FHE.publishDecryptResult(validation, matchPlaintext, signature);
        (bool matchResult, bool ready) = FHE.getDecryptResultSafe(validation);
        require(ready, "BusinessHub: validation decryption not ready");

        euint64 held = _invoiceEscrowHeld[invoiceId];

        if (matchResult) {
            IFHERC20Vault(inv.vault).transferVerified(inv.vendor, FHE.shareEuint64(held, inv.vault));
            inv.status = InvoiceStatus.Paid;
            emit InvoicePaid(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_paid", inv.description, invoiceId) {} catch {}
        } else {
            // Refund whoever funded the escrow. Since the client check this is
            // always the client; older records may name another payer.
            IFHERC20Vault(inv.vault).transferVerified(invoicePaymentStartedBy[invoiceId], FHE.shareEuint64(held, inv.vault));
            inv.status = InvoiceStatus.Cancelled;
            emit InvoiceCancelled(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_refunded", inv.description, invoiceId) {} catch {}
        }
    }

    /// @notice Vendor returns a Disputed direct payment to the client.
    ///
    ///         The refund is the handle payInvoice recorded as actually moved
    ///         to the vendor, not the invoiced amount. The vault moves all of
    ///         it or 0 (vendor short on balance or allowance), so the status
    ///         does not change here: finalizeDisputedRefund flips it to
    ///         Cancelled only once refunded == paid is verified.
    ///
    ///         The vendor must first grant BusinessHub an encrypted vault
    ///         allowance.
    /// @param invoiceId The invoice in `Disputed` state.
    /// @dev Legacy records (paid before the moved amount was stored) fall
    ///      back to inv.amount, the only figure on record for them.
    function refundDisputedInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Disputed, "BusinessHub: not disputed");
        require(msg.sender == inv.vendor, "BusinessHub: not the vendor");
        require(!invoiceRefundPending[invoiceId], "BusinessHub: refund pending");

        euint64 paid = _invoicePaidAmount[invoiceId];
        if (!FHE.isInitialized(paid)) paid = inv.amount;

        euint64 refunded = FHE.receiveEuint64FromCall(
            IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, inv.client, FHE.shareEuint64(paid, inv.vault)),
            inv.vault
        );
        ebool ok = FHE.eq(refunded, paid);
        FHE.allowThis(ok);
        FHE.allowSender(ok);
        FHE.allowPublic(ok);
        _invoiceRefundCheck[invoiceId] = ok;
        invoiceRefundPending[invoiceId] = true;

        emit InvoiceRefundInitiated(invoiceId, block.timestamp);
    }

    /// @notice Settle a refundDisputedInvoice attempt. Cancelled if the full
    ///         paid amount went back; otherwise the invoice stays Disputed and
    ///         the vendor may try again. Anyone may submit the decrypt.
    function finalizeDisputedRefund(
        uint256 invoiceId,
        bool okPlaintext,
        bytes calldata signature
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Disputed, "BusinessHub: not disputed");
        require(invoiceRefundPending[invoiceId], "BusinessHub: no refund pending");

        ebool check = _invoiceRefundCheck[invoiceId];
        FHE.publishDecryptResult(check, okPlaintext, signature);
        (bool ok, bool ready) = FHE.getDecryptResultSafe(check);
        require(ready, "BusinessHub: refund decryption not ready");

        invoiceRefundPending[invoiceId] = false;
        if (ok) {
            inv.status = InvoiceStatus.Cancelled;
            invoicePaymentStartedBy[invoiceId] = address(0);
            emit InvoiceCancelled(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.vendor, inv.client, "invoice_refunded", inv.description, invoiceId) {} catch {}
        } else {
            emit InvoiceRefundFailed(invoiceId, block.timestamp);
        }
    }

    /// @notice Read the refund-check handle for finalizeDisputedRefund.
    function getInvoiceRefundCheckHandle(uint256 invoiceId) external view returns (ebool) {
        return _invoiceRefundCheck[invoiceId];
    }

    /// @dev Escrowed when recorded as such, or (legacy) when a held handle exists.
    function _isEscrowPayment(uint256 invoiceId) internal view returns (bool) {
        PaymentMode m = invoicePaymentMode[invoiceId];
        if (m != PaymentMode.Legacy) return m == PaymentMode.Escrow;
        return FHE.isInitialized(_invoiceEscrowHeld[invoiceId]);
    }

    /// @notice Retired. The plaintext swap path let the client mark an invoice
    ///         paid while the vendor received an amount the encrypted match
    ///         never covered. Invoices in flight from this path finalize
    ///         through payInvoiceFinalize, which the vendor must call.
    function payInvoiceWithSwap(
        uint256, address, uint256, uint256, uint24, address, externalEuint64, bytes calldata
    ) external pure {
        revert("BusinessHub: retired");
    }

    /// @notice Retired for the same reason as payInvoiceWithSwap, and because
    ///         it paid vendors out of an operator float on an oracle signature.
    function payInvoiceWithOracleQuote(
        uint256, address, uint256, uint256, uint256, uint256, bytes32, bytes calldata, externalEuint64, bytes calldata
    ) external pure {
        revert("BusinessHub: retired");
    }

    /// @notice Owner sweeps plaintext tokens that are not owed to anyone, such
    ///         as payTokens left by the retired oracle path. Escrow deposits
    ///         are liabilities and stay untouchable.
    /// @dev    Escrows created before liability tracking existed must be
    ///         counted first (accountLegacyEscrows), otherwise their deposits
    ///         would look like free balance.
    function withdrawAccumulated(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(token != address(0), "BusinessHub: zero token");
        require(to != address(0), "BusinessHub: zero recipient");
        require(
            escrowAccountingCursor == nextEscrowId && unresolvedLegacyEscrows == 0,
            "BusinessHub: account legacy escrows first"
        );
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 owed = escrowLiabilities[token];
        require(bal >= owed && amount <= bal - owed, "BusinessHub: amount exceeds free balance");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PAYROLL
    // ═══════════════════════════════════════════════════════════════════

    function runPayroll(
        address[] calldata employees,
        address vault,
        externalEuint64[] calldata salaries,
        bytes calldata proof
    ) external nonReentrant {
        uint256 count = employees.length;
        require(count > 0 && count <= MAX_PAYROLL_SIZE, "BusinessHub: invalid batch size");
        require(count == salaries.length, "BusinessHub: length mismatch");
        // A forged vault could report any "moved" handle and inflate the
        // receipts that proveIncomeAbove reads.
        _requireAllowedVault(vault);

        // One batch signature covers every salary in the run.
        euint64[] memory verifiedSalaries = FHE.asEuint64s(salaries, proof);

        IFHERC20Vault v = IFHERC20Vault(vault);
        for (uint256 i = 0; i < count; i++) {
            require(employees[i] != address(0), "BusinessHub: zero address");
            // Reject self-payroll. A self→self transfer is a no-op for
            // the vault balance but _bumpReceipts(self, amount) below
            // still increments the per-user "received" counter. That
            // counter is read by PaymentReceipts.proveIncomeAbove,
            // letting a malicious user inflate their proven income by
            // payrolling themselves. Mirror sendPayment + batchSend
            // which already enforce recipient != msg.sender.
            require(employees[i] != msg.sender, "BusinessHub: cannot payroll self");
            euint64 actual = FHE.receiveEuint64FromCall(
                v.transferFromVerified(
                    msg.sender,
                    employees[i],
                    FHE.shareEuint64(verifiedSalaries[i], vault)
                ),
                vault
            );
            FHE.allowSender(actual);
            FHE.allow(actual, employees[i]);
            FHE.allowThis(actual);
            // #92: bump per-employee received counter so payroll recipients
            // can use proveIncomeAbove. Also bump global aggregate so the
            // landing-page counter reflects payroll volume too.
            _bumpReceipts(employees[i], actual);
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
        // Mirror of the FHERC20Vault.shield cap: the euint64 copy would truncate.
        require(plaintextAmount <= type(uint64).max, "BusinessHub: amount exceeds uint64");
        require(bytes(description).length <= 512, "BusinessHub: description too long");
        // A party acting as arbiter could decide its own dispute.
        require(
            arbiter == address(0) || (arbiter != msg.sender && arbiter != beneficiary),
            "BusinessHub: arbiter must be a third party"
        );
        _requireAllowedVault(vault);

        // The token comes from the registry and is stored, so a vault cannot
        // report one token at deposit and another at payout.
        address token = tokenRegistry.underlyingOf(vault);
        IERC20(token).safeTransferFrom(msg.sender, address(this), plaintextAmount);

        euint64 amount = FHE.asEuint64(plaintextAmount);
        FHE.allowThis(amount);
        FHE.allowSender(amount);
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
        escrowToken[id] = token;
        escrowLiabilities[token] += plaintextAmount;
        _escrowLiabilityCounted[id] = true;
        if (escrowAccountingCursor == id) escrowAccountingCursor = id + 1;

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
        try eventHub.emitActivity(msg.sender, e.depositor, "escrow_delivered", "", escrowId) {} catch {}

        // #212: either ordering of (approveRelease, markDelivered) releases.
        if (e.depositorApproved) {
            _releaseEscrow(escrowId);
        }
    }

    /// @notice Depositor approves release. If both approve, funds release automatically.
    function approveRelease(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(msg.sender == e.depositor, "BusinessHub: not depositor");

        e.depositorApproved = true;
        emit EscrowApproved(escrowId, block.timestamp);

        if (e.depositorApproved && e.beneficiaryMarkedDelivered) {
            _releaseEscrow(escrowId);
        }
    }

    /// @notice Either party can dispute, but only when an arbiter exists to
    ///         decide. Without one a dispute would only freeze the funds;
    ///         the deadline refund covers that case instead.
    function disputeEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "BusinessHub: not a party");
        require(e.arbiter != address(0), "BusinessHub: no arbiter configured");
        e.status = EscrowStatus.Disputed;
        escrowDisputedAt[escrowId] = block.timestamp;
        emit EscrowDisputed(escrowId, msg.sender, block.timestamp);
    }

    /// @notice Arbiter decides outcome of disputed escrow
    function arbiterDecide(uint256 escrowId, bool releaseToBeneficiary) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Disputed, "BusinessHub: not disputed");
        require(e.arbiter != address(0), "BusinessHub: no arbiter configured");
        require(msg.sender == e.arbiter, "BusinessHub: not arbiter");

        e.status = EscrowStatus.Released;
        _payoutEscrow(escrowId, releaseToBeneficiary ? e.beneficiary : e.depositor);

        emit EscrowArbiterDecided(escrowId, releaseToBeneficiary, block.timestamp);
        emit EscrowReleased(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, e.beneficiary, "escrow_resolved", e.description, escrowId) {} catch {}
    }

    /// @notice A dispute the arbiter has not decided within
    ///         ESCROW_DISPUTE_TIMEOUT returns the deposit to the depositor.
    ///         Anyone may trigger it. Disputes opened before the timestamp
    ///         was recorded count from the escrow deadline.
    function claimDisputeTimeout(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Disputed, "BusinessHub: not disputed");
        uint256 start = escrowDisputedAt[escrowId];
        if (start == 0) start = e.deadline;
        require(block.timestamp >= start + ESCROW_DISPUTE_TIMEOUT, "BusinessHub: dispute not timed out");

        e.status = EscrowStatus.Expired;
        _payoutEscrow(escrowId, e.depositor);

        emit EscrowDisputeTimedOut(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, address(0), "escrow_expired", e.description, escrowId) {} catch {}
    }

    /// @notice Claim expired escrow. Returns funds to depositor.
    function claimExpiredEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "BusinessHub: not active");
        require(block.timestamp > e.deadline, "BusinessHub: not expired");

        e.status = EscrowStatus.Expired;
        _payoutEscrow(escrowId, e.depositor);

        emit EscrowExpiryClaimed(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, address(0), "escrow_expired", e.description, escrowId) {} catch {}
    }

    /// @notice Count escrows created before liability tracking, so their
    ///         deposits stop looking like free balance to withdrawAccumulated.
    ///         Permissionless, resumable, bounded by maxCount per call.
    /// @dev    An open legacy escrow whose vault is not an active registry
    ///         vault has no trustworthy token; it is skipped with an event and
    ///         cannot pay out until the owner registers that vault.
    function accountLegacyEscrows(uint256 maxCount) external nonReentrant {
        uint256 i = escrowAccountingCursor;
        uint256 end = nextEscrowId;
        uint256 done;
        while (i < end && done < maxCount) {
            Escrow storage e = _escrows[i];
            if (
                !_escrowLiabilityCounted[i] &&
                (e.status == EscrowStatus.Active || e.status == EscrowStatus.Disputed)
            ) {
                address token = escrowToken[i];
                if (token == address(0) && _isActiveVault(e.vault)) {
                    token = tokenRegistry.underlyingOf(e.vault);
                    escrowToken[i] = token;
                }
                if (token != address(0)) {
                    escrowLiabilities[token] += e.plaintextAmount;
                    _escrowLiabilityCounted[i] = true;
                } else if (!legacyEscrowUnresolved[i]) {
                    // Blocks withdrawAccumulated until accountLegacyEscrow
                    // or a payout settles this escrow.
                    legacyEscrowUnresolved[i] = true;
                    unresolvedLegacyEscrows += 1;
                    emit LegacyEscrowUnresolved(i);
                }
            }
            unchecked { ++i; ++done; }
        }
        escrowAccountingCursor = i;
    }

    /// @notice Count one legacy escrow that accountLegacyEscrows skipped,
    ///         once the owner has registered its vault. Permissionless.
    function accountLegacyEscrow(uint256 escrowId) external nonReentrant {
        require(legacyEscrowUnresolved[escrowId], "BusinessHub: not unresolved");
        Escrow storage e = _escrows[escrowId];
        _clearUnresolved(escrowId);
        if (e.status != EscrowStatus.Active && e.status != EscrowStatus.Disputed) return;
        require(_isActiveVault(e.vault), "BusinessHub: vault not allowed");
        address token = tokenRegistry.underlyingOf(e.vault);
        escrowToken[escrowId] = token;
        escrowLiabilities[token] += e.plaintextAmount;
        _escrowLiabilityCounted[escrowId] = true;
    }

    function _clearUnresolved(uint256 escrowId) internal {
        if (legacyEscrowUnresolved[escrowId]) {
            legacyEscrowUnresolved[escrowId] = false;
            unresolvedLegacyEscrows -= 1;
        }
    }

    function _releaseEscrow(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        e.status = EscrowStatus.Released;
        _payoutEscrow(escrowId, e.beneficiary);

        emit EscrowReleased(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, e.beneficiary, "escrow_released", e.description, escrowId) {} catch {}
    }

    /// @dev Pays the plaintext deposit from the token stored at creation.
    ///      Escrows created before tokens were stored resolve it from the
    ///      registry and revert if the vault is not active: re-reading the
    ///      vault is exactly what let a fake vault swap the payout token.
    function _payoutEscrow(uint256 escrowId, address to) internal {
        Escrow storage e = _escrows[escrowId];
        address token = escrowToken[escrowId];
        if (token == address(0)) {
            require(_isActiveVault(e.vault), "BusinessHub: vault not allowed");
            token = tokenRegistry.underlyingOf(e.vault);
            escrowToken[escrowId] = token;
        }
        _clearUnresolved(escrowId);
        if (_escrowLiabilityCounted[escrowId]) {
            _escrowLiabilityCounted[escrowId] = false;
            escrowLiabilities[token] -= e.plaintextAmount;
        }
        IERC20(token).safeTransfer(to, e.plaintextAmount);
    }

    function _isActiveVault(address vault) internal view returns (bool) {
        return address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault);
    }

    function _requireAllowedVault(address vault) internal view {
        require(_isActiveVault(vault), "BusinessHub: vault not allowed");
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

    function setEventHub(address _eventHub) external onlyOwner {
        // A codeless hub makes every emitActivity call revert outside the
        // try/catch (extcodesize check), which would brick the hub.
        require(_eventHub.code.length > 0, "BusinessHub: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    /// @notice Vault allowlist used by every entry that takes a vault.
    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "BusinessHub: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    /// @notice #92: Set the PaymentReceipts contract address. When non-zero,
    ///         runPayroll forwards each recipient's transferred amount so
    ///         they can later prove their encrypted total received income.
    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        require(
            _paymentReceipts == address(0) || _paymentReceipts.code.length > 0,
            "BusinessHub: bad receipts"
        );
        address previous = paymentReceipts;
        paymentReceipts = _paymentReceipts;
        emit PaymentReceiptsSet(previous, _paymentReceipts);
    }

    /// @dev Internal: forward a pre-verified euint64 to PaymentReceipts for
    ///      both per-user bump and global aggregate bump. Wrapped in
    ///      try/catch so a misconfigured (non-authorized) PaymentReceipts
    ///      can never block a payroll transfer. Mirrors PaymentHub's
    ///      `_bumpAggregate` defensive pattern.
    /// @dev §2.8 helper: verify an encrypted payment matches the encrypted
    ///      invoice amount and grant the standard allow-set (this + sender)
    ///      so the caller can later read the boolean off-chain. Caller is
    ///      responsible for the optional `FHE.allowPublic(exactMatch)` and
    ///      for persisting the result in `_invoicePaymentValidation`.
    function _verifyEncryptedMatch(euint64 payment, euint64 expected)
        internal
        returns (ebool exactMatch)
    {
        exactMatch = FHE.eq(payment, expected);
        FHE.allowThis(exactMatch);
        FHE.allowSender(exactMatch);
    }

    function _bumpReceipts(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        // Transient-allow the PaymentReceipts contract to read the amount
        // handle for the duration of this call frame.
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        // allowTransient is scoped to each external call, so re-authorize
        // for the global bump.
        try IPaymentReceipts(paymentReceipts).bumpGlobal(FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
    }

    /// @dev Owner-managed allowlist of swap routers permitted by
    ///      `payInvoiceWithSwap`. Audit P2.10: a caller-supplied router was
    ///      already bounded (only the just-pulled payToken can be lost), but
    ///      curating an explicit allowlist prevents novice users from being
    ///      tricked into specifying a malicious router that immediately
    ///      drains the per-tx amount via a custom `exactOutputSingle`. Owner
    ///      seeds with Uniswap v3 SwapRouter02 per chain (lib/uniswap.ts).
    ///
    ///      v0.2.1 storage append: decrements the gap from 50 → 49.
    /// @dev Unused since the swap path was retired. Slot kept for layout.
    mapping(address => bool) public approvedSwapRouters;

    // ─── v0.3 audit fixes (append-only, each slot taken from __gap) ─────

    /// @dev Vault allowlist. Unset means every vault-taking entry fails closed.
    ITokenRegistry public tokenRegistry;
    /// @dev How each invoice was paid, so each finalize accepts only its own mode.
    mapping(uint256 => PaymentMode) public invoicePaymentMode;
    /// @dev Handle of what payInvoice actually moved to the vendor. Refunds
    ///      return this, not the invoiced amount.
    mapping(uint256 => euint64) private _invoicePaidAmount;
    mapping(uint256 => uint256) public invoicePaidAt;
    /// @dev refundDisputedInvoice result check: refunded == paid.
    mapping(uint256 => ebool) private _invoiceRefundCheck;
    mapping(uint256 => bool) public invoiceRefundPending;
    /// @dev ERC20 resolved from the registry at escrow creation. Payouts use
    ///      this, never vault.underlyingToken() at release time.
    mapping(uint256 => address) public escrowToken;
    mapping(uint256 => uint256) public escrowDisputedAt;
    /// @dev Plaintext tokens owed to escrow parties, per token.
    mapping(address => uint256) public escrowLiabilities;
    mapping(uint256 => bool) private _escrowLiabilityCounted;
    /// @dev Every escrow id below this has been considered for liabilities.
    uint256 public escrowAccountingCursor;
    /// @dev Legacy escrows skipped by accountLegacyEscrows (no active vault).
    mapping(uint256 => bool) public legacyEscrowUnresolved;
    uint256 public unresolvedLegacyEscrows;

    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Used: 31. Gap: 36.
    uint256[36] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ═══════════════════════════════════════════════════════════════════
    //  CID ANCHORING (Phase 3.5)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Anchor `keccak256(IPFS CID)` of an invoice PDF on-chain.
    ///         Only the invoice's vendor may call. Allowed only while the
    ///         invoice is still open (Pending / PaymentPending) so a paid
    ///         or cancelled invoice can't have its evidence retroactively
    ///         swapped by either party.
    /// @param invoiceId Invoice the file belongs to.
    /// @param cidHash   keccak256 of the UTF-8-encoded IPFS CID string.
    function setInvoicePdfCidHash(uint256 invoiceId, bytes32 cidHash) external {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.vendor == msg.sender, "BusinessHub: not the vendor");
        require(
            inv.status == InvoiceStatus.Pending ||
                inv.status == InvoiceStatus.PaymentPending,
            "BusinessHub: invoice no longer open"
        );
        invoicePdfCidHash[invoiceId] = cidHash;
        emit InvoicePdfCidSet(invoiceId, cidHash, block.timestamp);
    }

    /// @notice Anchor `keccak256(IPFS CID)` of an escrow attachment on-chain.
    ///         Either party (depositor or beneficiary) may call while the
    ///         escrow is still Active. Locked once the status moves off
    ///         Active so settlement evidence can't be back-dated.
    /// @param escrowId Escrow the file belongs to.
    /// @param cidHash  keccak256 of the UTF-8-encoded IPFS CID string.
    function setEscrowAttachmentCidHash(uint256 escrowId, bytes32 cidHash) external {
        Escrow storage e = _escrows[escrowId];
        require(
            msg.sender == e.depositor || msg.sender == e.beneficiary,
            "BusinessHub: not a party"
        );
        require(e.status == EscrowStatus.Active, "BusinessHub: escrow no longer active");
        escrowAttachmentCidHash[escrowId] = cidHash;
        emit EscrowAttachmentCidSet(escrowId, cidHash, block.timestamp);
    }
}
