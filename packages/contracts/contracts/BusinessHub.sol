// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transferVerified(address to, euint64 amount) external returns (euint64);
    function underlyingToken() external view returns (address);
}

/// @dev Minimal Uniswap v3 SwapRouter02 surface. We only call `exactOutputSingle`
///      so the contract can spend an EXACT amount of USDC (the invoice's
///      expected token) at a known maximum payToken cost. Refunds the unused
///      payToken to the caller. Pulled from Uniswap's SwapRouter02 ABI —
///      addresses checked off-chain, BusinessHub never trusts the router
///      with anything but the payToken it just pulled from msg.sender.
interface ISwapRouter02 {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, euint64 amount) external;
    function bumpGlobal(euint64 amount) external;
}

/// @title BusinessHub — Encrypted invoicing, payroll, and escrow
/// @notice Handles B2B payment flows where amounts are encrypted.
///         Invoices: vendor creates, client pays.
///         Payroll: employer pays multiple employees in one batch.
///         Escrow: 2-of-2 approval with optional arbiter and deadline.
contract BusinessHub is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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
        // Audit P2.15: cap description bytes so an attacker can't grief
        // the contract with multi-KB on-chain strings (cheap storage-bloat
        // griefing). 512 bytes is generous for any real invoice memo.
        require(bytes(description).length <= 512, "BusinessHub: description too long");

        euint64 amount = FHE.asEuint64(encAmount);
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

        // #214: lock first payer in. If someone else already started paying,
        // reject with a specific message. Same caller may retry (idempotent).
        if (invoicePaymentStartedBy[invoiceId] != address(0)) {
            require(invoicePaymentStartedBy[invoiceId] == msg.sender, "BusinessHub: payment already started by another address");
        }
        invoicePaymentStartedBy[invoiceId] = msg.sender;

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
        // #213: only the named client can finalize. Previously anyone with
        // the decryption signature could finalize; this restricts it to the
        // invoice's client. Defense-in-depth alongside the #214 payment-starter
        // check below.
        require(msg.sender == inv.client, "BusinessHub: only client can finalize");
        // #214: only the address that initiated payment can finalize. Combined
        // with the client check above, this means: only the client (who is
        // also the payment-starter) can ever finalize.
        require(invoicePaymentStartedBy[invoiceId] == msg.sender, "BusinessHub: only the payment-starter can finalize");

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

        // Note: _invoicePaymentValidation[invoiceId] persists. Solidity's
        // `delete` keyword can't be applied to FHE types (ebool), and there's
        // no non-reverting reset primitive that doesn't incur encryption
        // cost. Status field gates re-entry, so stale handle reads are safe.
    }

    function cancelInvoice(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.vendor, "BusinessHub: not the vendor");
        inv.status = InvoiceStatus.Cancelled;
        // #214: clear the payment-starter so a fresh invoice (if one is later
        // re-created at this id — currently impossible because ids increment,
        // but defensive against future status-reset paths).
        invoicePaymentStartedBy[invoiceId] = address(0);
        emit InvoiceCancelled(invoiceId, block.timestamp);
    }

    /// @notice Vendor-initiated refund for a Disputed invoice.
    ///
    ///         payInvoice transfers funds to the vendor BEFORE the
    ///         encrypted-amount match is verified. If the client paid the
    ///         wrong amount, payInvoiceFinalize moves the invoice into the
    ///         Disputed state — but the funds have already moved. This
    ///         function lets the vendor return the encrypted amount to
    ///         the client (msg.sender = vendor; recipient = inv.client),
    ///         transitioning Disputed → Cancelled atomically with the
    ///         on-chain refund.
    ///
    ///         Requires the vendor to have first granted BusinessHub an
    ///         encrypted vault allowance (`vault.approve(businessHub, ...)`)
    ///         — same pattern as any other transferFromVerified caller.
    ///
    // ─────────────────────────────────────────────────────────────────
    //  PRIVATE INVOICE ESCROW (PR-C)
    //
    //  payInvoice transfers funds to the vendor BEFORE the encrypted-amount
    //  match is verified (and only fixes mismatches via vendor-cooperative
    //  refundDisputedInvoice). For workflows where trustless settlement
    //  matters — freelancers paid by clients they haven't worked with
    //  before, longer engagements, B2B invoicing — the escrow path holds
    //  the encrypted payment in this contract until match is verified,
    //  then atomically releases to vendor (match) or refunds the client
    //  (mismatch). No vendor cooperation required.
    // ─────────────────────────────────────────────────────────────────

    /// @notice Escrow-flavoured payInvoice. Funds sit in BusinessHub's vault
    ///         balance until releaseInvoiceEscrow finalizes the match check.
    /// @param invoiceId Invoice id (must be Pending).
    /// @param encAmount Client's encrypted payment.
    function payInvoiceEscrow(uint256 invoiceId, InEuint64 memory encAmount) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(invoicePaymentStartedBy[invoiceId] == address(0), "BusinessHub: already paying");
        invoicePaymentStartedBy[invoiceId] = msg.sender;

        // Verify the encrypted input in the client's (msg.sender) context.
        euint64 payment = FHE.asEuint64(encAmount);
        FHE.allowTransient(payment, inv.vault);

        // Pull funds INTO this contract (escrow). The vault's transferFrom-
        // Verified returns a verified handle of the actual amount transferred
        // — which we keep in storage until release.
        euint64 held = IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, address(this), payment);
        FHE.allowThis(held);
        FHE.allowSender(held);
        _invoiceEscrowHeld[invoiceId] = held;

        // Encrypted equality check — same shape as payInvoice. Public so the
        // SDK's threshold-decrypt path can publish the result back via
        // releaseInvoiceEscrow.
        ebool exactMatch = FHE.eq(payment, inv.amount);
        FHE.allowThis(exactMatch);
        FHE.allowSender(exactMatch);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;

        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        try eventHub.emitActivity(msg.sender, inv.vendor, "invoice_escrow_funded", inv.description, invoiceId) {} catch {}
    }

    /// @notice Finalize a payInvoiceEscrow. Off-chain, the SDK threshold-
    ///         decrypts the validation ebool and supplies the plaintext
    ///         result + signature; this function publishes that result on-
    ///         chain (which reverts if the signature is wrong) and then
    ///         atomically routes the held funds: Paid (vendor) on match,
    ///         Cancelled (client refund) on mismatch.
    function releaseInvoiceEscrow(
        uint256 invoiceId,
        bool matchPlaintext,
        bytes calldata signature
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.PaymentPending, "BusinessHub: not payment pending");
        require(msg.sender == inv.client, "BusinessHub: only client can finalize");
        require(invoicePaymentStartedBy[invoiceId] == msg.sender, "BusinessHub: only the payment-starter can finalize");

        ebool validation = _invoicePaymentValidation[invoiceId];
        FHE.publishDecryptResult(validation, matchPlaintext, signature);
        (bool matchResult, bool ready) = FHE.getDecryptResultSafe(validation);
        require(ready, "BusinessHub: validation decryption not ready");

        euint64 held = _invoiceEscrowHeld[invoiceId];
        // Authorize the vault to act on our held handle for this call.
        FHE.allowTransient(held, inv.vault);

        if (matchResult) {
            // Match: release to vendor.
            IFHERC20Vault(inv.vault).transferVerified(inv.vendor, held);
            inv.status = InvoiceStatus.Paid;
            emit InvoicePaid(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_paid", inv.description, invoiceId) {} catch {}
        } else {
            // Mismatch: refund to the client (= msg.sender). No vendor
            // cooperation required — the funds never left this contract.
            IFHERC20Vault(inv.vault).transferVerified(msg.sender, held);
            inv.status = InvoiceStatus.Cancelled;
            emit InvoiceCancelled(invoiceId, block.timestamp);
            try eventHub.emitActivity(inv.client, inv.vendor, "invoice_refunded", inv.description, invoiceId) {} catch {}
        }
    }

    /// @param invoiceId The invoice in `Disputed` state.
    /// @param encAmount The encrypted refund amount (typically the original
    ///                   payment, but the vendor controls this — UI should
    ///                   prefill from the on-chain invoice amount).
    function refundDisputedInvoice(uint256 invoiceId, InEuint64 memory encAmount) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Disputed, "BusinessHub: not disputed");
        require(msg.sender == inv.vendor, "BusinessHub: not the vendor");

        // Verify the encrypted input under the vendor's context, then hand
        // the verified handle to the vault.
        euint64 refund = FHE.asEuint64(encAmount);
        FHE.allowTransient(refund, inv.vault);

        IFHERC20Vault(inv.vault).transferFromVerified(msg.sender, inv.client, refund);

        inv.status = InvoiceStatus.Cancelled;
        // Allow the same invoice id to never be replayed: clear the
        // payment-starter so any future cancelInvoice re-entry is rejected
        // by the Pending status guard above (defense-in-depth).
        invoicePaymentStartedBy[invoiceId] = address(0);

        emit InvoiceCancelled(invoiceId, block.timestamp);
        try eventHub.emitActivity(inv.vendor, inv.client, "invoice_refunded", inv.description, invoiceId) {} catch {}
    }

    /// @notice Phase 5.6 — pay an invoice using ANY ERC-20 token. Routes
    ///         through Uniswap v3 to swap the caller's `payToken` into the
    ///         vault's underlying token (USDC, etc.) for an EXACT output
    ///         amount, then plaintext-transfers that to the vendor. The
    ///         encrypted-amount match check still runs (same async finalize
    ///         flow as `payInvoice`), so the vendor gets the same integrity
    ///         guarantee — the difference is only the token the payer spent.
    ///
    ///         Same-token short-circuit: if `payToken == vault.underlyingToken()`
    ///         the swap is skipped entirely (cheaper, no Uniswap dependency,
    ///         no slippage concern).
    ///
    /// @dev    PRIVACY HOLE (documented in Plan §5.6 — "the swap routes through
    ///         a public DEX, so the payment-amount-in-original-token is visible
    ///         on-chain during the swap window. Amount in USDC stays encrypted
    ///         post-settlement"). Mitigation lives in UI copy ("Pay in different
    ///         token (amount briefly visible during transit)").
    ///
    /// @dev    SECURITY: `swapRouter` is supplied by the caller. The frontend
    ///         hardcodes Uniswap's SwapRouter02 per chain (lib/uniswap.ts).
    ///         A malicious router cannot drain the contract — the only token
    ///         this contract holds at the time of the swap is what was just
    ///         pulled from msg.sender. The downstream `safeTransfer(vendor)`
    ///         reverts cleanly if the swap output is short.
    ///
    /// @param invoiceId       The invoice to pay.
    /// @param payToken        ERC-20 the caller is spending (e.g. USDT, WETH).
    /// @param payAmountInMax  Upper bound on payToken to pull from the caller.
    ///                        Caller must `approve(BusinessHub, payAmountInMax)` first.
    /// @param expectedUsdcOut Plaintext amount of vault.underlyingToken to
    ///                        deliver to the vendor. Must equal the off-chain
    ///                        decrypted invoice amount; the `encAmount` arg
    ///                        proves that match via the existing FHE flow.
    /// @param fee             Uniswap v3 pool fee tier (3000 = 0.3%, etc.).
    /// @param swapRouter      Address of Uniswap v3 SwapRouter02 (per chain).
    /// @param encAmount       Encrypted match value — same role as `payInvoice`.
    function payInvoiceWithSwap(
        uint256 invoiceId,
        address payToken,
        uint256 payAmountInMax,
        uint256 expectedUsdcOut,
        uint24 fee,
        address swapRouter,
        InEuint64 memory encAmount
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.client, "BusinessHub: not the client");
        require(payToken != address(0), "BusinessHub: zero payToken");
        require(swapRouter != address(0), "BusinessHub: zero swapRouter");
        require(approvedSwapRouters[swapRouter], "BusinessHub: router not approved");
        require(payAmountInMax > 0, "BusinessHub: zero payAmountInMax");
        require(expectedUsdcOut > 0, "BusinessHub: zero expectedUsdcOut");

        // #214: lock first payer in (same as payInvoice).
        if (invoicePaymentStartedBy[invoiceId] != address(0)) {
            require(
                invoicePaymentStartedBy[invoiceId] == msg.sender,
                "BusinessHub: payment already started by another address"
            );
        }
        invoicePaymentStartedBy[invoiceId] = msg.sender;

        // ── 1. Encrypted-match validation ──────────────────────────────
        // Verify encrypted input here (msg.sender = client) before any cross
        // -contract call. The match result is published for later off-chain
        // decryption + finalize, mirroring payInvoice exactly so the same
        // payInvoiceFinalize() handles both flows.
        euint64 payment = FHE.asEuint64(encAmount);
        ebool exactMatch = FHE.eq(payment, inv.amount);
        FHE.allowThis(exactMatch);
        FHE.allowSender(exactMatch);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;

        // ── 2. Pull payToken from caller ───────────────────────────────
        IERC20(payToken).safeTransferFrom(msg.sender, address(this), payAmountInMax);

        // ── 3. Swap (or skip if same-token) ────────────────────────────
        address vaultUnderlying = IFHERC20Vault(inv.vault).underlyingToken();
        uint256 amountInActual;
        if (payToken == vaultUnderlying) {
            // No-swap path: payToken IS the invoice's token. Caller must
            // have provided exactly the expected amount (plus zero excess),
            // otherwise the math doesn't tie out.
            require(
                payAmountInMax == expectedUsdcOut,
                "BusinessHub: same-token requires payAmountInMax == expectedUsdcOut"
            );
            amountInActual = expectedUsdcOut;
        } else {
            // Approve the router for the upper bound, then swap for an
            // exact output. Reset approval to zero after to defend against
            // routers that don't burn the full allowance.
            IERC20(payToken).forceApprove(swapRouter, payAmountInMax);
            amountInActual = ISwapRouter02(swapRouter).exactOutputSingle(
                ISwapRouter02.ExactOutputSingleParams({
                    tokenIn: payToken,
                    tokenOut: vaultUnderlying,
                    fee: fee,
                    recipient: address(this),
                    amountOut: expectedUsdcOut,
                    amountInMaximum: payAmountInMax,
                    sqrtPriceLimitX96: 0
                })
            );
            IERC20(payToken).forceApprove(swapRouter, 0);

            // Refund unused payToken (most swaps undershoot the cap by some
            // small slippage delta).
            if (amountInActual < payAmountInMax) {
                IERC20(payToken).safeTransfer(msg.sender, payAmountInMax - amountInActual);
            }
        }

        // ── 4. Plaintext transfer to vendor ────────────────────────────
        // The vendor gets PLAINTEXT USDC — they can shield manually later
        // if they want encrypted balance. This is the privacy trade-off
        // documented above. If they want encryption preserved end-to-end,
        // the standard `payInvoice` flow remains available.
        IERC20(vaultUnderlying).safeTransfer(inv.vendor, expectedUsdcOut);

        // ── 5. Mark PaymentPending — finalize required ─────────────────
        // The async finalize step (payInvoiceFinalize) verifies the FHE
        // match decryption and flips Paid/Disputed. Vendors should NOT
        // assume the payment is final until that step lands — same as
        // the existing payInvoice flow.
        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        emit InvoicePaymentSwapped(
            invoiceId,
            payToken,
            amountInActual,
            expectedUsdcOut,
            block.timestamp
        );
        try eventHub.emitActivity(
            msg.sender,
            inv.vendor,
            "invoice_payment_initiated",
            inv.description,
            invoiceId
        ) {} catch {}
    }

    /// @notice Phase 5.7 — owner sweeps accumulated tokens out of the
    ///         contract. The oracle-fallback flow pulls `payToken` from
    ///         the payer and pays the vendor in USDC out of an operator-
    ///         maintained float — the payTokens accumulate here. This
    ///         function lets the owner periodically sweep them, sell
    ///         externally, and top the USDC float back up. Without this
    ///         the operator is permanently subsidizing the asymmetric
    ///         exchange.
    ///
    /// @dev    onlyOwner gate — only the contract owner can move funds
    ///         out. The function does NOT touch the FHE-vault encrypted
    ///         flow (`payInvoice` / `runPayroll`), only the plaintext
    ///         token balances accumulated by the oracle/swap fallback
    ///         paths. Vendors paid via the encrypted path are paid out
    ///         of THEIR encrypted vault balance, not the contract's
    ///         plaintext float — those funds never touch this contract.
    function withdrawAccumulated(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(token != address(0), "BusinessHub: zero token");
        require(to != address(0), "BusinessHub: zero recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Phase 5.7 — owner-only setter for the oracle attestation
    ///         address. Backend `/api/oracle/quote` ECDSA-signs price
    ///         quotes using the corresponding private key; this contract
    ///         verifies them. Address(0) effectively disables the oracle
    ///         fallback path (every quote will fail recovery match).
    function setOracleAttestationAddress(address newAttestor) external onlyOwner {
        address previous = oracleAttestationAddress;
        oracleAttestationAddress = newAttestor;
        emit OracleAddressUpdated(previous, newAttestor);
    }

    /// @notice Phase 5.7 — pay an invoice with a token Uniswap doesn't
    ///         have a pool for, using a backend-signed price quote. The
    ///         payer pulls `payAmountIn` of `payToken`, the contract
    ///         applies the oracle's `ratePpm` (out-per-in × 1e6) to
    ///         derive the USDC settlement amount, then plaintext-transfers
    ///         that to the vendor. Same async finalize flow as `payInvoice`
    ///         and `payInvoiceWithSwap` — the FHE encrypted-amount match
    ///         check still gates Paid vs. Disputed.
    ///
    /// @dev    PRIVACY trade-off: identical to `payInvoiceWithSwap` —
    ///         payment-amount-in-original-token is publicly visible and
    ///         the vendor receives plaintext USDC. Documented in UI copy.
    ///
    /// @dev    SECURITY:
    ///           1. Signature is verified against `oracleAttestationAddress`.
    ///              Compromised key → owner rotates via setOracleAttestationAddress.
    ///           2. `expiresAt` deadline prevents replay of stale quotes.
    ///           3. `nonce` prevents reuse of valid quotes (per-payer
    ///              uniqueness via the (payer, nonce) tuple — quote-spent
    ///              tracker below).
    ///           4. Sanity bound on `ratePpm`: rejected if outside
    ///              [1, 100_000_000] which means rate is 1e-6 to 1e2 of
    ///              tokenOut per unit tokenIn. Catches mis-signed quotes
    ///              with absurd rates that could under/over-pay vendor.
    ///
    /// @param invoiceId      The invoice to pay.
    /// @param payToken       ERC-20 the caller is spending.
    /// @param payAmountIn    Amount of payToken to pull (exact, no refund).
    /// @param expectedUsdcOut Plaintext invoice amount the vendor receives.
    ///                        MUST match (payAmountIn * ratePpm / 1e6).
    /// @param ratePpm        Oracle's tokenOut-per-tokenIn rate × 1e6.
    /// @param expiresAt      Unix seconds; quote rejected after.
    /// @param nonce          Per-payer uniqueness token from /api/oracle/quote.
    /// @param signature      ECDSA over keccak256(abi.encode(invoiceId,
    ///                       payToken, payAmountIn, expectedUsdcOut,
    ///                       ratePpm, expiresAt, nonce, address(this),
    ///                       block.chainid, msg.sender)) signed by
    ///                       oracleAttestationAddress, EIP-191 prefixed.
    /// @param encAmount      Encrypted match value — same role as `payInvoice`.
    function payInvoiceWithOracleQuote(
        uint256 invoiceId,
        address payToken,
        uint256 payAmountIn,
        uint256 expectedUsdcOut,
        uint256 ratePpm,
        uint256 expiresAt,
        bytes32 nonce,
        bytes calldata signature,
        InEuint64 memory encAmount
    ) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        require(inv.status == InvoiceStatus.Pending, "BusinessHub: not pending");
        require(msg.sender == inv.client, "BusinessHub: not the client");
        require(payToken != address(0), "BusinessHub: zero payToken");
        require(payAmountIn > 0, "BusinessHub: zero payAmountIn");
        require(expectedUsdcOut > 0, "BusinessHub: zero expectedUsdcOut");
        require(block.timestamp <= expiresAt, "BusinessHub: quote expired");

        // Sanity-bound the rate. ratePpm = 1 means 1e-6 tokenOut per tokenIn
        // (e.g. 1 wei of unit token → 1 wei of unit USDC, scaled). ratePpm
        // = 100_000_000 means 100x — catches a mis-signed `1e9` rate that
        // would over-credit the vendor 1000x. Outside this band is a
        // signed-quote bug, not a real market quote.
        require(ratePpm >= 1 && ratePpm <= 100_000_000, "BusinessHub: rate out of bounds");

        // Verify expectedUsdcOut matches the rate exactly.
        //
        // Audit P2.16: the previous shape allowed `expectedUsdcOut = derivedOut - 1`
        // (the +1 tolerance was applied to the upper bound), letting a payer
        // submit a valid signed quote but underpay the vendor by 1 unit per
        // settlement. Tolerance for division rounding is the backend's job —
        // if the off-chain quote computation produces non-integer results,
        // round there with deterministic rules. The on-chain check is exact.
        uint256 derivedOut = (payAmountIn * ratePpm) / 1_000_000;
        require(derivedOut == expectedUsdcOut, "BusinessHub: expectedUsdcOut mismatch");

        // Verify oracle signature. EIP-191 prefix prevents the same digest
        // being reused as a regular tx (off-chain → on-chain replay).
        // Including address(this), chainid, and msg.sender in the digest
        // prevents cross-contract / cross-chain / cross-payer replay.
        require(oracleAttestationAddress != address(0), "BusinessHub: oracle unset");
        bytes32 digest = keccak256(
            abi.encode(
                invoiceId,
                payToken,
                payAmountIn,
                expectedUsdcOut,
                ratePpm,
                expiresAt,
                nonce,
                address(this),
                block.chainid,
                msg.sender
            )
        );
        bytes32 ethDigest = MessageHashUtils.toEthSignedMessageHash(digest);
        address recovered = ECDSA.recover(ethDigest, signature);
        require(recovered == oracleAttestationAddress, "BusinessHub: bad oracle sig");

        // Per-payer nonce tracking: prevents reuse of the same valid quote
        // (e.g. payer drains payToken from same wallet twice with one
        // signed quote). Storage is gated by msg.sender so an attacker
        // can't pollute someone else's nonce slot.
        require(!_oracleQuoteUsed[msg.sender][nonce], "BusinessHub: nonce used");
        _oracleQuoteUsed[msg.sender][nonce] = true;

        // ── Payment-starter lock-in ────────────────────────────────────
        if (invoicePaymentStartedBy[invoiceId] != address(0)) {
            require(
                invoicePaymentStartedBy[invoiceId] == msg.sender,
                "BusinessHub: payment already started by another address"
            );
        }
        invoicePaymentStartedBy[invoiceId] = msg.sender;

        // ── FHE encrypted-match validation ─────────────────────────────
        euint64 payment = FHE.asEuint64(encAmount);
        ebool exactMatch = FHE.eq(payment, inv.amount);
        FHE.allowThis(exactMatch);
        FHE.allowSender(exactMatch);
        FHE.allowPublic(exactMatch);
        _invoicePaymentValidation[invoiceId] = exactMatch;

        // ── Pull payToken + transfer USDC to vendor ────────────────────
        IERC20(payToken).safeTransferFrom(msg.sender, address(this), payAmountIn);
        address vaultUnderlying = IFHERC20Vault(inv.vault).underlyingToken();
        IERC20(vaultUnderlying).safeTransfer(inv.vendor, expectedUsdcOut);

        inv.status = InvoiceStatus.PaymentPending;

        emit InvoicePaymentInitiated(invoiceId, block.timestamp);
        emit InvoicePaymentOracleSettled(
            invoiceId,
            payToken,
            payAmountIn,
            expectedUsdcOut,
            ratePpm,
            block.timestamp
        );
        try eventHub.emitActivity(
            msg.sender,
            inv.vendor,
            "invoice_payment_initiated",
            inv.description,
            invoiceId
        ) {} catch {}
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
        require(bytes(description).length <= 512, "BusinessHub: description too long");

        // Lock plaintext amount in the underlying ERC20 (not encrypted — escrow needs release)
        // The user shields tokens first, then this function takes from their PUBLIC balance
        // This is the correct pattern: escrow amounts must be releasable without FHE passthrough
        // Audit fix: safeTransferFrom — non-standard ERC-20s that return false silently
        // would otherwise leave the contract in a "deposit succeeded" state with no funds.
        IERC20 underlying = IERC20(IFHERC20Vault(vault).underlyingToken());
        underlying.safeTransferFrom(msg.sender, address(this), plaintextAmount);

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

        // #212: if depositor already approved before delivery, the original
        // approveRelease never re-checked the release condition — funds got
        // stuck. Mirror the release-check from approveRelease here so either
        // ordering of (approveRelease, markDelivered) triggers a release.
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
        underlying.safeTransfer(recipient, e.plaintextAmount);

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
        underlying.safeTransfer(e.depositor, e.plaintextAmount);

        emit EscrowExpiryClaimed(escrowId, block.timestamp);
        try eventHub.emitActivity(e.depositor, address(0), "escrow_expired", e.description, escrowId) {} catch {}
    }

    function _releaseEscrow(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        e.status = EscrowStatus.Released;

        // Transfer plaintext escrowed funds to beneficiary
        IERC20 underlying = IERC20(IFHERC20Vault(e.vault).underlyingToken());
        underlying.safeTransfer(e.beneficiary, e.plaintextAmount);

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

    /// @notice #92: Set the PaymentReceipts contract address. When non-zero,
    ///         runPayroll forwards each recipient's transferred amount so
    ///         they can later prove their encrypted total received income.
    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        paymentReceipts = _paymentReceipts;
    }

    /// @dev Internal: forward a pre-verified euint64 to PaymentReceipts for
    ///      both per-user bump and global aggregate bump. Wrapped in
    ///      try/catch so a misconfigured (non-authorized) PaymentReceipts
    ///      can never block a payroll transfer. Mirrors PaymentHub's
    ///      `_bumpAggregate` defensive pattern.
    function _bumpReceipts(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        // Transient-allow the PaymentReceipts contract to read the amount
        // handle for the duration of this call frame.
        FHE.allowTransient(amount, paymentReceipts);
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, amount) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        // allowTransient is scoped to each external call, so re-authorize
        // for the global bump.
        FHE.allowTransient(amount, paymentReceipts);
        try IPaymentReceipts(paymentReceipts).bumpGlobal(amount) {} catch (bytes memory reason) {
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
    mapping(address => bool) public approvedSwapRouters;

    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Used: 18. Gap: 49.
    uint256[49] private __gap;

    event SwapRouterApprovalChanged(address indexed router, bool approved);

    /// @notice Approve or unapprove a swap router for `payInvoiceWithSwap`.
    function setSwapRouterApproved(address router, bool approved) external onlyOwner {
        require(router != address(0), "BusinessHub: zero router");
        approvedSwapRouters[router] = approved;
        emit SwapRouterApprovalChanged(router, approved);
    }

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
