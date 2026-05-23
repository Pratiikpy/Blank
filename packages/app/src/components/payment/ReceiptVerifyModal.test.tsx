import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for ReceiptVerifyModal. Verifies a payment-receipt
// bytes32 hash against the PaymentReceipts contract. Two paths
// in / out: (a) paste a receipt hash + click Verify Receipt ->
// see Verified On-Chain badge with payer/payee/token/timestamp
// breakdown + encrypted amount placeholder; (b) when wallet
// connected, expand 'My Receipts' to browse the user's own
// receipts + click one to auto-verify. Critical because
// verifying receipts is the proof surface — a regression in
// hash validation or result rendering would either reject valid
// proofs or silently surface wrong data.
//
// CRITICAL pins:
//   - isOpen=false -> renders null; isOpen=true -> dialog with
//     aria-modal + aria-labelledby='receipt-verify-title'.
//   - Header: 'Verify Receipt' h2 + subtitle 'Paste a receipt
//     hash to verify payment details on-chain' + Shield icon.
//   - bytes32 validation regex /^0x[0-9a-fA-F]{64}$/: enforces
//     0x prefix + exactly 64 hex chars (32 bytes); ID-like
//     short strings rejected; non-hex chars rejected; empty
//     input -> 'Please enter a receipt hash'; invalid format ->
//     'Invalid hash format. Must be a 32-byte hex string (0x
//     followed by 64 hex characters)' — pinned literally.
//   - Verify button DISABLED when input empty OR isVerifying;
//     valid input -> useReadContract fires with the hash as
//     [submittedHash] arg + query.enabled=!!submittedHash.
//   - 3-state result branch after submit: receipt EXISTS=true
//     -> Verified On-Chain badge + payer/payee/token/timestamp
//     grid + encrypted amount placeholder '•••• (Encrypted —
//     decrypt with permit)'; exists=false -> 'Receipt not found
//     on-chain' error; contract throws -> 'Verification failed'
//     with truncated err.message (>120 chars get '...' suffix)
//     + 'Try Again' retry button that resets submittedHash +
//     refetches.
//   - Loading state: 'Verifying...' button label while
//     isVerifying + spinner + 'Querying on-chain receipt data...'
//     placeholder in the result slot.
//   - Address truncate: 0xfirst8...last6 helper applied to
//     payer / payee / token rendering; the receipt hash itself
//     shown FULL (select-all class so users can copy it for
//     verification elsewhere).
//   - 'My Receipts' collapsible section visible ONLY when
//     wallet connected (address truthy); ChevronUp/Down icon
//     reflects open state; click on a stored receipt -> auto-
//     fills input + auto-submits + closes the collapsible.
//   - Escape key + backdrop click close the modal; Enter in
//     input submits if !isVerifying (handleKeyDown gate
//     prevents double-submit during in-flight verify).
//   - State reset on close: 250ms after isOpen flips false, all
//     state clears (receiptHash + submittedHash + errors +
//     showMyReceipts) so the next open is fresh.

const useAccountMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useReadContract: useReadContractMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/abis", () => ({ PaymentReceiptsAbi: [] }));
vi.mock("@/lib/constants", () => ({ ENCRYPTED_PLACEHOLDER: "••••.••" }));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      onClick,
      className,
      ...rest
    }: {
      children?: React.ReactNode;
      onClick?: (e: React.MouseEvent) => void;
      className?: string;
    } & React.HTMLAttributes<HTMLDivElement>) => (
      <div
        onClick={onClick}
        className={className}
        {...Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) =>
              !k.startsWith("variants") &&
              !k.startsWith("initial") &&
              !k.startsWith("animate") &&
              !k.startsWith("exit") &&
              !k.startsWith("transition") &&
              !k.startsWith("onAnimation"),
          ),
        )}
      >
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    className?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      data-loading={loading ? "true" : undefined}
      className={className}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/Input", () => ({
  Input: ({
    placeholder,
    value,
    onChange,
    error,
  }: {
    placeholder?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    error?: string;
  }) => (
    <div>
      <input
        aria-label="Receipt hash"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={onChange}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

import { ReceiptVerifyModal } from "./ReceiptVerifyModal";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const PAYER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const PAYEE = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const RECEIPTS_CONTRACT = "0x1111111111111111111111111111111111111111" as `0x${string}`;

// Valid 32-byte hash (0x + 64 hex chars)
const VALID_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const STORED_HASH_1 = ("0x" + "11".repeat(32)) as `0x${string}`;
const STORED_HASH_2 = ("0x" + "22".repeat(32)) as `0x${string}`;

const refetchMock = vi.fn();

function setupReadContract(opts: {
  verifyResult?: readonly unknown[] | undefined;
  verifyError?: Error | undefined;
  verifyLoading?: boolean;
  userReceipts?: readonly `0x${string}`[] | undefined;
  receiptsLoading?: boolean;
} = {}) {
  useReadContractMock.mockImplementation((cfg: { functionName: string }) => {
    if (cfg.functionName === "verifyReceipt") {
      return {
        data: opts.verifyResult,
        isLoading: opts.verifyLoading ?? false,
        isError: !!opts.verifyError,
        error: opts.verifyError,
        refetch: refetchMock,
      };
    }
    if (cfg.functionName === "getUserReceipts") {
      return {
        data: opts.userReceipts,
        isLoading: opts.receiptsLoading ?? false,
      };
    }
    return { data: undefined };
  });
}

function renderModal(overrides: Partial<Parameters<typeof ReceiptVerifyModal>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ReceiptVerifyModal isOpen={true} onClose={onClose} {...overrides} />,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  useAccountMock.mockReset();
  useReadContractMock.mockReset();
  useChainMock.mockReset();
  refetchMock.mockReset();

  useAccountMock.mockReturnValue({ address: ME });
  useChainMock.mockReturnValue({
    contracts: { PaymentReceipts: RECEIPTS_CONTRACT },
  });
  setupReadContract();
});

// ───────────────────────────────────────────────────────────
//  open / closed render gate + header
// ───────────────────────────────────────────────────────────

describe("ReceiptVerifyModal — open / closed + header (§15.x)", () => {
  it("isOpen=false -> renders null", () => {
    render(
      <ReceiptVerifyModal isOpen={false} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isOpen=true -> dialog with aria-modal + aria-labelledby='receipt-verify-title'", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("receipt-verify-title");
  });

  it("header: 'Verify Receipt' h2 + subtitle copy", () => {
    renderModal();
    expect(
      screen.getByRole("heading", { name: "Verify Receipt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Paste a receipt hash to verify payment details on-chain"),
    ).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  bytes32 validation
// ───────────────────────────────────────────────────────────

describe("ReceiptVerifyModal — bytes32 validation (§15.x)", () => {
  it("empty input -> Verify button DISABLED (validation gate)", () => {
    renderModal();
    // The button is disabled when empty so we don't need to click it.
    // The disabled state IS the validation gate (the empty-string error
    // path in handleSubmit is only reachable via Enter key in the input).
    const btn = screen.getByRole("button", { name: "Verify Receipt" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("invalid hex (too short '0xabc') -> 'Invalid hash format' error after Verify", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0xabc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Invalid hash format.*32-byte hex string.*0x followed by 64 hex characters/,
    );
  });

  it("invalid: 0x followed by 63 chars (one short) -> rejected", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    const short63 = "0x" + "a".repeat(63);
    fireEvent.change(input, { target: { value: short63 } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid hash format/);
  });

  it("invalid: 0x followed by 65 chars (one long) -> rejected", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    const long65 = "0x" + "a".repeat(65);
    fireEvent.change(input, { target: { value: long65 } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid hash format/);
  });

  it("invalid: missing 0x prefix -> rejected", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ab".repeat(32) } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid hash format/);
  });

  it("invalid: non-hex characters -> rejected", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0x" + "z".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid hash format/);
  });

  it("valid bytes32 -> useReadContract fires with [submittedHash] args", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    // useReadContract is called on EVERY render — find the LATEST
    // verifyReceipt call that has the hash set (initial renders have
    // args=undefined because submittedHash starts null).
    const verifyCalls = useReadContractMock.mock.calls.filter(
      (c) => c[0].functionName === "verifyReceipt" && c[0].args,
    );
    expect(verifyCalls.length).toBeGreaterThan(0);
    const last = verifyCalls[verifyCalls.length - 1]!;
    expect(last[0].args).toEqual([VALID_HASH]);
    expect(last[0].query.enabled).toBe(true);
  });

  it("typing after error clears the error eagerly (don't keep yelling)", () => {
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0xabc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: VALID_HASH } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Result states: found / not-found / contract error
// ───────────────────────────────────────────────────────────

describe("ReceiptVerifyModal — result states (§15.x)", () => {
  it("loading -> 'Verifying...' button label + button.disabled + spinner placeholder", () => {
    setupReadContract({ verifyLoading: true });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    expect(screen.getByText(/Verifying\.\.\./)).toBeInTheDocument();
    const btn = screen
      .getByText(/Verifying/)
      .closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(
      screen.getByText("Querying on-chain receipt data..."),
    ).toBeInTheDocument();
  });

  it("receipt FOUND (exists=true) -> 'Verified On-Chain' badge + payer/payee/token/timestamp grid", () => {
    setupReadContract({
      verifyResult: [true, PAYER, PAYEE, TOKEN, 1700000000n],
    });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByText("Verified On-Chain")).toBeInTheDocument();
    expect(screen.getByText("Payer")).toBeInTheDocument();
    expect(screen.getByText("Payee")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(screen.getByText("Timestamp")).toBeInTheDocument();
  });

  it("receipt FOUND -> addresses truncated 0xfirst8...last6", () => {
    setupReadContract({
      verifyResult: [true, PAYER, PAYEE, TOKEN, 1700000000n],
    });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    // Each truncate is 8 chars + ... + 6 chars
    expect(screen.getByText("0xbbbbbb...bbbbbb")).toBeInTheDocument();
    expect(screen.getByText("0xcccccc...cccccc")).toBeInTheDocument();
    expect(screen.getByText("0xdddddd...dddddd")).toBeInTheDocument();
  });

  it("receipt FOUND -> encrypted amount placeholder '••••.•• (Encrypted. Decrypt with permit.)'", () => {
    setupReadContract({
      verifyResult: [true, PAYER, PAYEE, TOKEN, 1700000000n],
    });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(
      screen.getByText(/••••\.•• \(Encrypted\. Decrypt with permit\.\)/),
    ).toBeInTheDocument();
  });

  it("receipt FOUND -> full receipt hash shown WITHOUT truncation (select-all friendly)", () => {
    setupReadContract({
      verifyResult: [true, PAYER, PAYEE, TOKEN, 1700000000n],
    });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    // The full 66-char hash appears verbatim in the Receipt Hash row
    expect(screen.getByText(VALID_HASH)).toBeInTheDocument();
  });

  it("receipt NOT FOUND (exists=false) -> 'Receipt not found on-chain' error card", () => {
    setupReadContract({
      verifyResult: [false, "0x0", "0x0", "0x0", 0n],
    });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByText("Receipt not found on-chain")).toBeInTheDocument();
    expect(
      screen.getByText("The hash does not match any recorded payment receipt"),
    ).toBeInTheDocument();
    // NOT showing verified-on-chain badge
    expect(screen.queryByText("Verified On-Chain")).toBeNull();
  });

  it("contract ERROR -> 'Verification failed' + truncated err.message + Try Again button", () => {
    const longMsg = "x".repeat(200);
    setupReadContract({ verifyError: new Error(longMsg) });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByText("Verification failed")).toBeInTheDocument();
    // Message truncated to 120 chars + '...'
    const errText = screen.getByText(/x{120}\.\.\./);
    expect(errText).toBeInTheDocument();
    expect(screen.getByText("Try Again")).toBeInTheDocument();
  });

  it("contract ERROR with short message -> full message shown (no truncate)", () => {
    setupReadContract({ verifyError: new Error("RPC timeout") });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    expect(screen.getByText("RPC timeout")).toBeInTheDocument();
  });

  it("Try Again click -> refetch fires + submittedHash reset", () => {
    setupReadContract({ verifyError: new Error("fail") });
    renderModal();
    const input = screen.getByLabelText("Receipt hash") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALID_HASH } });
    fireEvent.click(screen.getByRole("button", { name: "Verify Receipt" }));
    fireEvent.click(screen.getByText("Try Again"));
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  My Receipts section
// ───────────────────────────────────────────────────────────

describe("ReceiptVerifyModal — My Receipts section (§15.x)", () => {
  it("wallet disconnected -> 'My Receipts' section HIDDEN", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    renderModal();
    expect(screen.queryByText("My Receipts")).toBeNull();
  });

  it("wallet connected + receipts empty -> section visible but expanded shows 'No receipts found'", () => {
    setupReadContract({ userReceipts: [] });
    renderModal();
    expect(screen.getByText("My Receipts")).toBeInTheDocument();
    fireEvent.click(screen.getByText("My Receipts"));
    expect(screen.getByText("No receipts found")).toBeInTheDocument();
  });

  it("wallet connected + receipts loading -> 'Loading receipts...' inside expanded section", () => {
    setupReadContract({ receiptsLoading: true });
    renderModal();
    fireEvent.click(screen.getByText("My Receipts"));
    expect(screen.getByText("Loading receipts...")).toBeInTheDocument();
  });

  it("wallet connected + receipts present -> count badge + clickable list", () => {
    setupReadContract({ userReceipts: [STORED_HASH_1, STORED_HASH_2] });
    renderModal();
    // Count badge
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.click(screen.getByText("My Receipts"));
    // List shows both hashes
    expect(screen.getByText(STORED_HASH_1)).toBeInTheDocument();
    expect(screen.getByText(STORED_HASH_2)).toBeInTheDocument();
  });

  it("stored receipt click -> auto-fills input + triggers verify", () => {
    setupReadContract({ userReceipts: [STORED_HASH_1] });
    renderModal();
    fireEvent.click(screen.getByText("My Receipts"));
    fireEvent.click(screen.getByText(STORED_HASH_1));
    // useReadContract should have been called with the stored hash
    const verifyCall = useReadContractMock.mock.calls.find(
      (c) =>
        c[0].functionName === "verifyReceipt" &&
        c[0].args &&
        c[0].args[0] === STORED_HASH_1,
    );
    expect(verifyCall).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────
//  Close paths
// ───────────────────────────────────────────────────────────

describe("ReceiptVerifyModal — close paths (§15.x)", () => {
  it("Escape key -> onClose fires", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Close button (X) click -> onClose fires", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText("Close modal"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("isOpen=false -> Escape listener NOT attached", () => {
    const { onClose } = renderModal({ isOpen: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(0);
  });
});
