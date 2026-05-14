import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for SendSuccess screen. The terminal screen of every
// payment flow. Pins:
//   - 8s auto-redirect to /app (so the celebratory screen never
//     hijacks the user's session after a successful send)
//   - cleanup-on-unmount of the redirect timer (no stray navigate
//     after the user leaves)
//   - reset-BEFORE-navigate ordering on handleBackHome (else the
//     stale payment state survives the redirect and the user lands
//     on Dashboard with phantom in-flight data)
//   - single-payment vs batch-payment branch rendering
//   - CRITICAL batch total math: splitMode="equal" multiplies
//     amount * recipients.length; splitMode="custom" sums
//     recipientAmounts. A typo (amount + length, or
//     amount * recipientAmounts.length) would silently misreport
//     the user's actual on-chain spend.
//   - no-txHash → no explorer link (don't render a broken link
//     before the receipt comes in)

const useNavigateMock = vi.hoisted(() => vi.fn());
const useSendPaymentMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));
vi.mock("@/hooks/useSendPayment", () => ({
  useSendPayment: useSendPaymentMock,
}));
vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));
vi.mock("@/lib/constants", () => ({
  getExplorerTxUrl: getExplorerTxUrlMock,
}));

import SendSuccess from "./SendSuccess";

const RECIPIENT = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
const RECIPIENT_2 = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

type PaymentState = {
  mode: "single" | "many";
  recipient: string | null;
  amount: string;
  txHash: string | null;
  recipients: string[];
  recipientAmounts: string[];
  splitMode: "equal" | "custom";
  reset: ReturnType<typeof vi.fn>;
};

function basePayment(overrides: Partial<PaymentState> = {}): PaymentState {
  return {
    mode: "single",
    recipient: RECIPIENT,
    amount: "10.50",
    txHash: TX_HASH,
    recipients: [],
    recipientAmounts: [],
    splitMode: "equal",
    reset: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useNavigateMock.mockReset();
  useSendPaymentMock.mockReset();
  useChainMock.mockReset();
  getExplorerTxUrlMock.mockReset();

  useChainMock.mockReturnValue({ activeChain: { id: 11155111, name: "Ethereum Sepolia" } });
  getExplorerTxUrlMock.mockImplementation((hash: string, chainId: number) => {
    return `https://sepolia.etherscan.io/tx/${hash}?chainId=${chainId}`;
  });
  useSendPaymentMock.mockReturnValue(basePayment());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SendSuccess — page chrome (§15.x)", () => {
  it("renders 'Payment Sent!' heading", () => {
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("Payment Sent!");
  });

  it("subtitle names the active chain + Fully Homomorphic Encryption", () => {
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("confirmed on Ethereum Sepolia");
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
  });

  it("renders the FHE Protected badge", () => {
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("FHE Protected");
  });

  it("renders 'Back to Home' CTA", () => {
    const { getByText } = render(<SendSuccess />);
    expect(getByText("Back to Home")).toBeDefined();
  });
});

describe("SendSuccess — single-payment branch (§15.x)", () => {
  it("shows truncated recipient + amount with USDC suffix", () => {
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
    expect(container.textContent).toContain("$10.50 USDC");
  });

  it("renders explorer link with target=_blank + rel guard + getExplorerTxUrl URL", () => {
    const { getByText } = render(<SendSuccess />);
    const link = getByText("View on Explorer").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("href")).toContain(TX_HASH);
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith(TX_HASH, 11155111);
  });

  it("explorer link HIDDEN when txHash is null (no broken link pre-receipt)", () => {
    useSendPaymentMock.mockReturnValue(basePayment({ txHash: null }));
    const { queryByText } = render(<SendSuccess />);
    expect(queryByText("View on Explorer")).toBeNull();
  });

  it("single-mode details HIDDEN when no recipient (initial state)", () => {
    useSendPaymentMock.mockReturnValue(basePayment({ recipient: null }));
    const { container } = render(<SendSuccess />);
    // "To" / "Amount" rows live inside the single-mode block; without
    // a recipient that whole block is skipped.
    expect(container.textContent).not.toContain("To");
    expect(container.textContent).not.toContain("Amount");
  });
});

describe("SendSuccess — batch-payment branch (§15.x)", () => {
  it("shows recipients count when mode='many'", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT, RECIPIENT_2],
        recipientAmounts: ["10", "20"],
        amount: "0",
        splitMode: "custom",
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("Recipients");
    expect(container.textContent).toContain("2");
  });

  it("CRITICAL splitMode='equal': total = amount * recipients.length (3 * $25 = $75.00)", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT, RECIPIENT_2, "0xdddddddddddddddddddddddddddddddddddddddd"],
        amount: "25",
        splitMode: "equal",
        recipientAmounts: [],
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("$75.00 USDC");
  });

  it("CRITICAL splitMode='custom': total = sum(recipientAmounts) ($10 + $20 + $5.50 = $35.50)", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT, RECIPIENT_2, "0xdddddddddddddddddddddddddddddddddddddddd"],
        amount: "0",
        splitMode: "custom",
        recipientAmounts: ["10", "20", "5.50"],
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("$35.50 USDC");
  });

  it("custom split with non-numeric entries treats them as 0 (defensive parseFloat fallback)", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT, RECIPIENT_2],
        amount: "0",
        splitMode: "custom",
        recipientAmounts: ["abc", "5"],
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("$5.00 USDC");
  });

  it("equal split with non-numeric amount treats it as 0", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT, RECIPIENT_2],
        amount: "not-a-number",
        splitMode: "equal",
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).toContain("$0.00 USDC");
  });

  it("batch details HIDDEN when recipients array is empty", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [],
        recipientAmounts: [],
      }),
    );
    const { container } = render(<SendSuccess />);
    expect(container.textContent).not.toContain("Recipients");
    expect(container.textContent).not.toContain("Total");
  });

  it("batch explorer link hidden when no txHash", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT],
        recipientAmounts: ["5"],
        splitMode: "custom",
        txHash: null,
      }),
    );
    const { queryByText } = render(<SendSuccess />);
    expect(queryByText("View on Explorer")).toBeNull();
  });

  it("batch explorer link uses the same getExplorerTxUrl(txHash, chain.id) shape", () => {
    useSendPaymentMock.mockReturnValue(
      basePayment({
        mode: "many",
        recipient: null,
        recipients: [RECIPIENT],
        recipientAmounts: ["5"],
        splitMode: "custom",
      }),
    );
    const { getByText } = render(<SendSuccess />);
    const link = getByText("View on Explorer").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain(TX_HASH);
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith(TX_HASH, 11155111);
  });
});

describe("SendSuccess — handleBackHome ordering (§15.x)", () => {
  it("CRITICAL: payment.reset() runs BEFORE navigate (so stale state doesn't leak past redirect)", () => {
    const order: string[] = [];
    const resetMock = vi.fn(() => { order.push("reset"); });
    useNavigateMock.mockImplementation(() => { order.push("navigate"); });
    useSendPaymentMock.mockReturnValue(basePayment({ reset: resetMock }));

    const { getByText } = render(<SendSuccess />);
    fireEvent.click(getByText("Back to Home"));

    expect(order).toEqual(["reset", "navigate"]);
    expect(resetMock).toHaveBeenCalled();
  });

  it("navigates to /app with { replace: true } (still-connected user → Dashboard, not landing)", () => {
    const { getByText } = render(<SendSuccess />);
    fireEvent.click(getByText("Back to Home"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app", { replace: true });
  });
});

describe("SendSuccess — 8s auto-redirect (§15.x)", () => {
  it("auto-fires handleBackHome after 8000ms (reset + navigate)", () => {
    vi.useFakeTimers();
    const resetMock = vi.fn();
    useSendPaymentMock.mockReturnValue(basePayment({ reset: resetMock }));

    render(<SendSuccess />);
    expect(resetMock).not.toHaveBeenCalled();
    expect(useNavigateMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(resetMock).toHaveBeenCalled();
    expect(useNavigateMock).toHaveBeenCalledWith("/app", { replace: true });
  });

  it("auto-redirect does NOT fire before 8000ms (still pending at 7999ms)", () => {
    vi.useFakeTimers();
    const resetMock = vi.fn();
    useSendPaymentMock.mockReturnValue(basePayment({ reset: resetMock }));

    render(<SendSuccess />);
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(resetMock).not.toHaveBeenCalled();
    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  it("CRITICAL: timer cleared on unmount (no stray redirect after user leaves)", () => {
    vi.useFakeTimers();
    const resetMock = vi.fn();
    useSendPaymentMock.mockReturnValue(basePayment({ reset: resetMock }));

    const { unmount } = render(<SendSuccess />);
    unmount();

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(resetMock).not.toHaveBeenCalled();
    expect(useNavigateMock).not.toHaveBeenCalled();
  });
});
