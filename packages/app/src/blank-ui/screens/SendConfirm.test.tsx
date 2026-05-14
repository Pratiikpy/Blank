import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for SendConfirm screen. Third leg of the send flow
// triad (SendContacts -> SendAmount -> SendConfirm). Pinning this
// completes the send-flow coverage.
//
// CRITICAL pins:
//   - audit Top-28 #17 mid-tx back-nav guard: back button is
//     DISABLED + early-returns on click when isProcessing. Losing
//     this screen mid-tx loses the success/error surface for a
//     tx the user already authorized.
//   - step==='success' triggers auto-navigate to /app/send/success
//     with replace:true (so the back button on success can't
//     bounce the user back to a stale confirm screen).
//   - 2 mutually exclusive stealth modes: metaStealthMode (Phase
//     9.3 ERC-5564) visible only when recipient has registered
//     meta-address; stealthMode (claim-code Phase 3.1) visible
//     only when recipient does NOT have meta-address. Both hidden
//     in many-mode entirely (claim-code is per-payment, batched
//     analogue doesn't exist).
//   - Phase 7.5/7.6 paymaster resilience tri-state:
//     paymasterUnavailable+low-AA-eth -> needsFunding banner +
//     Fund modal; +sufficient-AA-eth -> paymasterMode='self'
//     threaded to confirmSend; degraded -> amber banner (not
//     blocking).
//   - handleConfirm 4-branch dispatch: meta-stealth path,
//     claim-code stealth path, needsFunding path, default path.
//     A regression that flattens this into one path would break
//     the privacy contract or burn gas on a tx that would revert.
//   - audit #265 inline error surface via mapError: persists
//     until retry/back (so the user doesn't lose the failure
//     reason when the toast fades).
//   - batch math: total = sum(parseFloat(row.amount) || 0); equal
//     split duplicates `amount`, custom uses recipientAmounts[i].

const useNavigateMock = vi.hoisted(() => vi.fn());
const useSendPaymentMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePaymasterHealthMock = vi.hoisted(() => vi.fn());
const useBalanceMock = vi.hoisted(() => vi.fn());
const useStealthMetaAddressLookupMock = vi.hoisted(() => vi.fn());
const useStealthSendMock = vi.hoisted(() => vi.fn());
const mapErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useNavigate: () => useNavigateMock }));
vi.mock("wagmi", () => ({ useBalance: useBalanceMock }));
vi.mock("@/hooks/useSendPayment", () => ({ useSendPayment: useSendPaymentMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/usePaymasterHealth", () => ({ usePaymasterHealth: usePaymasterHealthMock }));
vi.mock("@/hooks/useStealthSend", () => ({
  useStealthMetaAddressLookup: useStealthMetaAddressLookupMock,
  useStealthSend: useStealthSendMock,
}));
vi.mock("@/blank-ui/components/FundAccountModal", () => ({
  FundAccountModal: (props: { open: boolean; onClose: () => void; onFunded: () => void }) => (
    <div
      data-testid="fund-modal"
      data-open={props.open ? "true" : "false"}
    >
      <button data-testid="fund-close" onClick={props.onClose}>close</button>
      <button data-testid="fund-onfunded" onClick={props.onFunded}>onFunded</button>
    </div>
  ),
}));
vi.mock("@/lib/error-messages", () => ({ mapError: mapErrorMock }));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import SendConfirm from "./SendConfirm";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDC = "0xfffffffffffffffffffffffffffffffffffffff1";
const META_ADDRESS = "st:eth:0xabcd";
const STEALTH_TX = "0xstealthtx";
const STEALTH_ADDR = "0xstealthaddr0000000000000000000000000000";

let confirmSendMock: ReturnType<typeof vi.fn>;
let goBackMock: ReturnType<typeof vi.fn>;
let sendStealthPaymentMock: ReturnType<typeof vi.fn>;
let refetchMock: ReturnType<typeof vi.fn>;

type SendState = {
  step: "idle" | "encrypting" | "approving" | "sending" | "success" | "error";
  recipient: string | null;
  amount: string;
  note: string;
  error: string | null;
  mode: "single" | "many";
  recipients: string[];
  splitMode: "equal" | "custom";
  recipientAmounts: string[];
  isEncrypting: boolean;
  isSending: boolean;
};

function setSend(overrides: Partial<SendState> = {}) {
  useSendPaymentMock.mockReturnValue({
    step: overrides.step ?? "idle",
    recipient: overrides.recipient ?? RECIPIENT,
    amount: overrides.amount ?? "10",
    note: overrides.note ?? "",
    error: overrides.error ?? null,
    mode: overrides.mode ?? "single",
    recipients: overrides.recipients ?? [],
    splitMode: overrides.splitMode ?? "equal",
    recipientAmounts: overrides.recipientAmounts ?? [],
    isEncrypting: overrides.isEncrypting ?? false,
    isSending: overrides.isSending ?? false,
    confirmSend: confirmSendMock,
    goBack: goBackMock,
  });
}

beforeEach(() => {
  useNavigateMock.mockReset();
  useSendPaymentMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePaymasterHealthMock.mockReset();
  useBalanceMock.mockReset();
  useStealthMetaAddressLookupMock.mockReset();
  useStealthSendMock.mockReset();
  mapErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  confirmSendMock = vi.fn().mockResolvedValue(undefined);
  goBackMock = vi.fn();
  sendStealthPaymentMock = vi.fn().mockResolvedValue({
    txHash: STEALTH_TX,
    stealthAddress: STEALTH_ADDR,
  });
  refetchMock = vi.fn();

  setSend();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { TestUSDC: USDC },
  });
  usePaymasterHealthMock.mockReturnValue({ status: "ready" });
  useBalanceMock.mockReturnValue({
    data: { value: 5_000_000_000_000_000n }, // 0.005 ETH > 0.001 threshold
    refetch: refetchMock,
  });
  useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: null });
  useStealthSendMock.mockReturnValue({ sendStealthPayment: sendStealthPaymentMock });
  mapErrorMock.mockReturnValue({ title: "Unknown error", body: "Try again" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SendConfirm — page chrome (§15.x)", () => {
  it("renders 'Confirm Payment' heading + 'Review the details' subtitle", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Confirm Payment");
    expect(container.textContent).toContain("Review the details before sending");
  });

  it("end-to-end encryption banner copy visible (load-bearing privacy disclosure)", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("End-to-end encrypted");
    expect(container.textContent).toContain("Only the sender and recipient can decrypt");
  });

  it("renders 'FHE Encrypted' pill + gas estimate row", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("FHE Encrypted");
    expect(container.textContent).toContain("~1.2M gas");
  });
});

describe("SendConfirm — single-recipient details card (§15.x)", () => {
  it("renders 'To' + truncated recipient + 'Amount' + $X USDC", () => {
    setSend({ mode: "single", recipient: RECIPIENT, amount: "25.50" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toMatch(/0xbbbb.{1,3}bbbb/i);
    expect(container.textContent).toContain("$25.50 USDC");
  });

  it("amount fallback '$0.00 USDC' when amount is empty", () => {
    setSend({ amount: "" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("$0.00 USDC");
  });

  it("renders Note row when note is truthy", () => {
    setSend({ note: "for coffee" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("for coffee");
  });
});

describe("SendConfirm — batch-mode details (§15.x)", () => {
  it("Recipients (N) + 'Equal split' or 'Custom amounts' label", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"],
      splitMode: "equal",
      amount: "5",
    });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Recipients (2)");
    expect(container.textContent).toContain("Equal split");
  });

  it("custom split: each row uses recipientAmounts[i]", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"],
      splitMode: "custom",
      recipientAmounts: ["3", "7"],
    });
    const { container, getByTestId } = render(<SendConfirm />);
    const rows = getByTestId("batch-confirm-rows");
    expect(rows.textContent).toContain("$3");
    expect(rows.textContent).toContain("$7");
    expect(container.textContent).toContain("Custom amounts");
  });

  it("CRITICAL batch total: equal-split duplicates `amount` per row (10 * 3 = $30)", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"],
      splitMode: "equal",
      amount: "10",
    });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("$30.00 USDC");
  });

  it("CRITICAL batch total: custom sums recipientAmounts with parseFloat fallback", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"],
      splitMode: "custom",
      recipientAmounts: ["3.5", "7"],
    });
    const { container } = render(<SendConfirm />);
    // 10.5 -> 6dp because batchTotal % 1 !== 0
    expect(container.textContent).toContain("$10.500000 USDC");
  });

  it("batch total: fractional value uses 6dp; integer uses 2dp", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"],
      splitMode: "equal",
      amount: "10",
    });
    const { container } = render(<SendConfirm />);
    // 10 * 2 = 20 (integer) -> 2dp
    expect(container.textContent).toContain("$20.00 USDC");
  });

  it("many-mode stealth toggles HIDDEN entirely (claim-code is per-payment)", () => {
    setSend({
      mode: "many",
      recipients: [RECIPIENT, "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"],
    });
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: META_ADDRESS });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).not.toContain("Hide my identity");
    expect(container.textContent).not.toContain("Send to stealth address");
  });
});

describe("SendConfirm — back-nav audit Top-28 #17 (§15.x)", () => {
  it("idle state: back button enabled + click calls goBack + navigate(-1)", () => {
    const { getByLabelText } = render(<SendConfirm />);
    const back = getByLabelText("Go back") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    fireEvent.click(back);
    expect(goBackMock).toHaveBeenCalled();
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });

  it("CRITICAL isProcessing (sending) -> back button DISABLED + click is a no-op", () => {
    setSend({ step: "sending", isSending: true });
    const { getByLabelText } = render(<SendConfirm />);
    const back = getByLabelText("Go back") as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    expect(goBackMock).not.toHaveBeenCalled();
    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  it("isProcessing (encrypting) also blocks back-nav", () => {
    setSend({ step: "encrypting", isEncrypting: true });
    const { getByLabelText } = render(<SendConfirm />);
    fireEvent.click(getByLabelText("Go back"));
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it("isProcessing (approving) also blocks back-nav (batch path vault approval in-flight)", () => {
    setSend({ step: "approving" });
    const { getByLabelText } = render(<SendConfirm />);
    fireEvent.click(getByLabelText("Go back"));
    expect(goBackMock).not.toHaveBeenCalled();
  });
});

describe("SendConfirm — step=success auto-navigate (§15.x)", () => {
  it("CRITICAL: step transitions to 'success' -> navigate('/app/send/success', {replace:true})", () => {
    setSend({ step: "success" });
    render(<SendConfirm />);
    expect(useNavigateMock).toHaveBeenCalledWith("/app/send/success", { replace: true });
  });

  it("non-success steps do NOT trigger navigate", () => {
    setSend({ step: "idle" });
    render(<SendConfirm />);
    expect(useNavigateMock).not.toHaveBeenCalled();
  });
});

describe("SendConfirm — statusLabel + button copy matrix (§15.x)", () => {
  it("idle -> 'Confirm & Send' label", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Confirm & Send");
  });

  it("isEncrypting -> 'Encrypting...' label", () => {
    setSend({ step: "encrypting", isEncrypting: true });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Encrypting...");
  });

  it("isSending -> 'Broadcasting...' label", () => {
    setSend({ step: "sending", isSending: true });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Broadcasting...");
  });

  it("step=approving -> 'Approving encrypted transfers...' indicator", () => {
    setSend({ step: "approving" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Approving encrypted transfers");
  });

  it("step=error -> 'Try again' button copy", () => {
    setSend({ step: "error", error: "boom" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Try again");
  });
});

describe("SendConfirm — claim-code stealth toggle (Phase 3.1) (§15.x)", () => {
  it("single mode + recipient WITHOUT meta-address -> 'Hide my identity' toggle visible", () => {
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: null });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Hide my identity");
    expect(container.textContent).toContain("Recipient claims via a shareable link");
  });

  it("toggling stealthMode + Confirm -> navigate /app/stealth with ?to=&amount=&note= params", () => {
    setSend({ amount: "20", note: "rent" });
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: null });
    const { container, getByText } = render(<SendConfirm />);
    const stealthToggle = container.querySelector("button[role='switch']") as HTMLButtonElement;
    fireEvent.click(stealthToggle);
    // Button label flips to "Continue stealth send"
    expect(container.textContent).toContain("Continue stealth send");
    fireEvent.click(getByText("Continue stealth send"));
    expect(useNavigateMock).toHaveBeenCalledWith(expect.stringContaining("/app/stealth?"));
    const url = useNavigateMock.mock.calls[0][0] as string;
    expect(url).toContain(`to=${RECIPIENT}`);
    expect(url).toContain("amount=20");
    expect(url).toContain("note=rent");
  });

  it("CRITICAL: stealth toggle HIDDEN when recipient HAS meta-address (mutual exclusion)", () => {
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: META_ADDRESS });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).not.toContain("Hide my identity");
    expect(container.textContent).toContain("Send to stealth address");
  });
});

describe("SendConfirm — meta-stealth toggle (Phase 9.3 ERC-5564) (§15.x)", () => {
  beforeEach(() => {
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: META_ADDRESS });
  });

  it("recipient HAS meta-address -> 'Send to stealth address' toggle visible", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Send to stealth address");
    expect(container.textContent).toContain("Recipient publishes a stealth meta-address");
  });

  it("toggling metaStealth flips aria-checked + button copy", () => {
    const { container } = render(<SendConfirm />);
    const toggle = container.querySelector("button[role='switch']") as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Send to stealth address");
  });

  // Helper: the Confirm button and the toggle LABEL both contain "Send to
  // stealth address" when meta-stealth is on, so getByText matches multiple.
  // Walk the buttons and pick the one that's NOT role=switch (the toggle).
  function findConfirmButton(container: HTMLElement): HTMLButtonElement {
    const btns = Array.from(container.querySelectorAll("button"));
    return btns.find(
      (b) => b.getAttribute("role") !== "switch" && /Send to stealth address|Confirm & Send|Try again|Continue stealth send|Fund wallet|Broadcasting|Encrypting|Processing/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
  }

  it("meta-stealth Confirm: calls sendStealthPayment with USDC + parsed amount + meta-address", async () => {
    setSend({ amount: "5.50" });
    const { container } = render(<SendConfirm />);
    fireEvent.click(container.querySelector("button[role='switch']") as HTMLButtonElement);
    await act(async () => {
      fireEvent.click(findConfirmButton(container));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendStealthPaymentMock).toHaveBeenCalledWith({
      token: USDC,
      amount: 5_500_000n,
      metaAddress: META_ADDRESS,
    });
  });

  it("CRITICAL meta-stealth amount<=0 rejected (parseUnits('0', 6) = 0n)", async () => {
    setSend({ amount: "0" });
    const { container } = render(<SendConfirm />);
    fireEvent.click(container.querySelector("button[role='switch']") as HTMLButtonElement);
    await act(async () => {
      fireEvent.click(findConfirmButton(container));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sendStealthPaymentMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Amount must be positive");
  });

  it("meta-stealth success -> navigates to /app/send/success with tx + stealth + amount params", async () => {
    setSend({ amount: "5" });
    const { container } = render(<SendConfirm />);
    fireEvent.click(container.querySelector("button[role='switch']") as HTMLButtonElement);
    await act(async () => {
      fireEvent.click(findConfirmButton(container));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(useNavigateMock).toHaveBeenCalled();
    const url = useNavigateMock.mock.calls[0][0] as string;
    expect(url).toContain("/app/send/success");
    expect(url).toContain(`tx=${STEALTH_TX}`);
    expect(url).toContain("stealth=");
    expect(url).toContain("amount=5");
  });

  it("meta-stealth failure -> inline error visible + sendStealthPayment error message preserved", async () => {
    sendStealthPaymentMock.mockRejectedValueOnce(new Error("Stealth derivation failed"));
    setSend({ amount: "5" });
    const { container } = render(<SendConfirm />);
    fireEvent.click(container.querySelector("button[role='switch']") as HTMLButtonElement);
    await act(async () => {
      fireEvent.click(findConfirmButton(container));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Stealth send failed. See details on the screen");
    expect(container.textContent).toContain("Stealth send failed");
    expect(container.textContent).toContain("Stealth derivation failed");
  });
});

describe("SendConfirm — paymaster resilience tri-state (Phase 7.5/7.6) (§15.x)", () => {
  it("paymaster ready -> no banner + 'Confirm & Send' default copy", () => {
    usePaymasterHealthMock.mockReturnValue({ status: "ready" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).not.toContain("Sponsored gas is running low");
    expect(container.textContent).not.toContain("Sponsored gas unavailable");
    expect(container.textContent).toContain("Confirm & Send");
  });

  it("paymaster degraded -> amber 'Sponsored gas is running low' banner (NOT blocking)", () => {
    usePaymasterHealthMock.mockReturnValue({ status: "degraded" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Sponsored gas is running low");
    expect(container.textContent).toContain("we'll walk you through funding");
    // Still has the normal Confirm button.
    expect(container.textContent).toContain("Confirm & Send");
  });

  it("CRITICAL paymaster unavailable + low AA-eth -> 'Fund wallet to send' button copy + rose banner", () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({
      data: { value: 100n }, // way below 0.001 ETH threshold
      refetch: refetchMock,
    });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Fund wallet to send");
    expect(container.textContent).toContain("Sponsored gas unavailable");
    expect(container.textContent).toContain("Top up");
  });

  it("CRITICAL paymaster unavailable + sufficient AA-eth -> NO funding banner + 'Confirm & Send' (self-pay)", () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({
      data: { value: 5_000_000_000_000_000n }, // 0.005 ETH > 0.001 threshold
      refetch: refetchMock,
    });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).not.toContain("Sponsored gas unavailable");
    expect(container.textContent).toContain("Confirm & Send");
  });

  it("CRITICAL paymaster unavailable + sufficient AA-eth -> confirmSend called with 'self' mode", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({
      data: { value: 5_000_000_000_000_000n },
      refetch: refetchMock,
    });
    const { getByText } = render(<SendConfirm />);
    await act(async () => {
      fireEvent.click(getByText("Confirm & Send"));
      await Promise.resolve();
    });
    expect(confirmSendMock).toHaveBeenCalledWith("self");
  });

  it("paymaster ready -> confirmSend called with undefined (sponsored path default)", async () => {
    const { getByText } = render(<SendConfirm />);
    await act(async () => {
      fireEvent.click(getByText("Confirm & Send"));
      await Promise.resolve();
    });
    expect(confirmSendMock).toHaveBeenCalledWith(undefined);
  });

  it("CRITICAL needsFunding click -> opens FundAccountModal (NOT confirmSend)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 0n }, refetch: refetchMock });
    const { getByText, getByTestId } = render(<SendConfirm />);
    expect(getByTestId("fund-modal").getAttribute("data-open")).toBe("false");
    fireEvent.click(getByText("Fund wallet to send"));
    expect(getByTestId("fund-modal").getAttribute("data-open")).toBe("true");
    expect(confirmSendMock).not.toHaveBeenCalled();
  });

  it("FundAccountModal onFunded -> refetch AA balance (so aaCanSelfPay updates immediately)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 0n }, refetch: refetchMock });
    const { getByText, getByTestId } = render(<SendConfirm />);
    fireEvent.click(getByText("Fund wallet to send"));
    fireEvent.click(getByTestId("fund-onfunded"));
    expect(refetchMock).toHaveBeenCalled();
  });
});

describe("SendConfirm — audit #265 inline error surface (§15.x)", () => {
  it("step=error + error -> mapError result rendered inline (persists past toast fade)", () => {
    mapErrorMock.mockReturnValue({ title: "Insufficient gas", body: "Top up your wallet" });
    setSend({ step: "error", error: "user rejected" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Insufficient gas");
    expect(container.textContent).toContain("Top up your wallet");
    expect(mapErrorMock).toHaveBeenCalledWith("user rejected");
  });

  it("CRITICAL: metaStealthError WINS over hook's error (legacy may be stale from prior retry)", async () => {
    sendStealthPaymentMock.mockRejectedValueOnce(new Error("Stealth path: derive failed"));
    // NOTE: step=error makes isErrored=true which makes statusLabel='Try again'
    // (the button copy is NOT 'Send to stealth address' here). Walk buttons
    // and skip the role=switch toggle to find the actual Confirm.
    setSend({ step: "error", error: "stale legacy error", amount: "5" });
    useStealthMetaAddressLookupMock.mockReturnValue({ metaAddress: META_ADDRESS });
    const { container } = render(<SendConfirm />);
    fireEvent.click(container.querySelector("button[role='switch']") as HTMLButtonElement);
    const confirmBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("role") !== "switch" &&
        /Try again|Send to stealth address|Confirm & Send/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Stealth send failed");
    expect(container.textContent).toContain("Stealth path: derive failed");
    expect(container.textContent).not.toContain("stale legacy error");
  });

  it("no error -> no error card rendered", () => {
    setSend({ step: "idle", error: null });
    const { container } = render(<SendConfirm />);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("SendConfirm — processing indicator panel (§15.x)", () => {
  it("isEncrypting -> 'Encrypting payment amount...' + ZK proof copy", () => {
    setSend({ step: "encrypting", isEncrypting: true });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Encrypting payment amount");
    expect(container.textContent).toContain("Generating FHE ciphertext and ZK proof");
  });

  it("step=sending -> 'Broadcasting to Ethereum Sepolia' + 'Waiting for transaction confirmation'", () => {
    setSend({ step: "sending", isSending: true });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("Broadcasting to Ethereum Sepolia");
    expect(container.textContent).toContain("Waiting for transaction confirmation");
  });

  it("step=approving -> 'First batch needs a one-time vault approval' explanation", () => {
    setSend({ step: "approving" });
    const { container } = render(<SendConfirm />);
    expect(container.textContent).toContain("First batch needs a one-time vault approval");
  });

  it("idle -> no processing indicator panel", () => {
    const { container } = render(<SendConfirm />);
    expect(container.textContent).not.toContain("Encrypting payment amount");
    expect(container.textContent).not.toContain("Broadcasting to");
  });
});

describe("SendConfirm — Confirm button enable/disable (§15.x)", () => {
  it("idle state -> Confirm button enabled", () => {
    const { getByText } = render(<SendConfirm />);
    const btn = getByText("Confirm & Send").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("isProcessing -> Confirm disabled", () => {
    setSend({ step: "sending", isSending: true });
    const { container } = render(<SendConfirm />);
    // statusLabel is "Broadcasting..."
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Broadcasting")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
