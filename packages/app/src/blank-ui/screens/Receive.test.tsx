import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Receive screen. Pins the PRODUCER side of the
// receive -> pay handshake. Receive emits a `/app/send/amount?to=&
// amount=&note=` URL that SendAmount.tsx consumes on first paint to
// pre-fill the payer's confirm flow. If Receive ships a URL the
// consumer can't parse (extra params, trailing-dot decimals, naive
// concat instead of URL builder), the "$50 for dinner" link lands
// the payer on a broken pre-fill. Tests pin URL shape + the
// sanitizer that matches SendAmount's input rules.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useMediaQueryMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const qrSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useMediaQuery", () => ({
  useMediaQuery: useMediaQueryMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: { value: string; size: number }) => {
    qrSpy(props);
    return <svg data-testid="qr-code" data-qr-value={props.value} data-qr-size={props.size} />;
  },
}));

import Receive from "./Receive";

const ADDR = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

let writeTextMock: ReturnType<typeof vi.fn>;
let originalShare: typeof navigator.share | undefined;

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useMediaQueryMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  qrSpy.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ADDR });
  useMediaQueryMock.mockReturnValue(false); // desktop

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });

  // navigator.share isn't always present in jsdom — null it so individual
  // tests can opt in via Object.defineProperty.
  originalShare = (navigator as { share?: typeof navigator.share }).share;
  Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, "share", { value: originalShare, configurable: true });
  vi.useRealTimers();
});

describe("Receive — passkey-blank-page guard (§15.x)", () => {
  it("CRITICAL: returns null when no effective address (no passkey-empty-page render)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<Receive />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the full screen when effective address present", () => {
    const { container } = render(<Receive />);
    expect(container.firstChild).not.toBeNull();
    expect(container.textContent).toContain("Receive Money");
  });
});

describe("Receive — page chrome (§15.x)", () => {
  it("heading 'Receive Money' + subtitle about QR + encrypted payments", () => {
    const { container } = render(<Receive />);
    expect(container.textContent).toContain("Receive Money");
    expect(container.textContent).toContain("Share your address or QR code to receive encrypted payments");
  });

  it("renders 'Your Payment QR' + 'Your Address' card titles", () => {
    const { container } = render(<Receive />);
    expect(container.textContent).toContain("Your Payment QR");
    expect(container.textContent).toContain("Your Address");
  });

  it("renders truncated address under the QR + full address in the address card", () => {
    const { container } = render(<Receive />);
    // truncateAddress collapses to 0xAaAa...AaAa (4 + 4 hex after 0x).
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
    // Full address rendered in the right-side wallet address card.
    expect(container.textContent).toContain(ADDR);
  });

  it("FHE Protected badge renders (signals encrypted-payment branding)", () => {
    const { container } = render(<Receive />);
    expect(container.textContent).toContain("FHE Protected");
  });
});

describe("Receive — payment-link URL shape (§15.x)", () => {
  it("bare address → /app/send/amount?to=<addr> (no amount, no note)", () => {
    const { container } = render(<Receive />);
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.pathname).toBe("/app/send/amount");
    expect(url.searchParams.get("to")?.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(url.searchParams.has("amount")).toBe(false);
    expect(url.searchParams.has("note")).toBe(false);
  });

  it("typing an amount adds ?amount=<n>", () => {
    const { container, getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "50" } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.searchParams.get("amount")).toBe("50");
  });

  it("typing a note adds ?note=<trimmed>", () => {
    const { container, getByLabelText } = render(<Receive />);
    const note = getByLabelText("Payment note") as HTMLInputElement;
    fireEvent.change(note, { target: { value: "  for dinner  " } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.searchParams.get("note")).toBe("for dinner");
  });

  it("amount '0' is NOT added (treated as 'no amount')", () => {
    const { container, getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "0" } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.searchParams.has("amount")).toBe(false);
  });

  it("whitespace-only note is NOT added", () => {
    const { container, getByLabelText } = render(<Receive />);
    const note = getByLabelText("Payment note") as HTMLInputElement;
    fireEvent.change(note, { target: { value: "   " } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.searchParams.has("note")).toBe(false);
  });

  it("CRITICAL: trailing-dot amount '5.' is stripped in URL (else SendAmount parses NaN)", () => {
    const { container, getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "5." } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.searchParams.get("amount")).toBe("5");
  });

  it("amount + note compose into a single URL (vs naive concat)", () => {
    const { container, getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "25.50" } });
    fireEvent.change(getByLabelText("Payment note"), { target: { value: "dinner" } });
    const url = new URL(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value")!);
    expect(url.pathname).toBe("/app/send/amount");
    expect(url.searchParams.get("to")?.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(url.searchParams.get("amount")).toBe("25.50");
    expect(url.searchParams.get("note")).toBe("dinner");
  });
});

describe("Receive — amount sanitizer (matches SendAmount's input rules) (§15.x)", () => {
  it("strips non-numeric/dot characters (letters, $, spaces)", () => {
    const { getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "abc1$2.3 4" } });
    expect(amt.value).toBe("12.34");
  });

  it("collapses multiple dots to the first one only ('1.2.3' → '1.23')", () => {
    const { getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "1.2.3" } });
    expect(amt.value).toBe("1.23");
  });

  it("caps decimals at 6 dp (matches SendAmount's max precision)", () => {
    const { getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "1.1234567890" } });
    expect(amt.value).toBe("1.123456");
  });

  it("preserves a trailing dot ('5.') so the user can keep typing decimals", () => {
    const { getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "5." } });
    expect(amt.value).toBe("5.");
  });

  it("empty input clears the field", () => {
    const { getByLabelText } = render(<Receive />);
    const amt = getByLabelText("Request amount in USDC") as HTMLInputElement;
    fireEvent.change(amt, { target: { value: "12.34" } });
    fireEvent.change(amt, { target: { value: "" } });
    expect(amt.value).toBe("");
  });
});

describe("Receive — note input (§15.x)", () => {
  it("respects maxLength=280 attribute", () => {
    const { getByLabelText } = render(<Receive />);
    const note = getByLabelText("Payment note") as HTMLInputElement;
    expect(note.maxLength).toBe(280);
  });
});

describe("Receive — QR code rendering (§15.x)", () => {
  it("encodes the paymentLink URL by default (not the bare address)", () => {
    const { container } = render(<Receive />);
    const qrValue = container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-value");
    expect(qrValue).toContain("/app/send/amount?to=");
  });

  it("uses 220px QR on desktop", () => {
    useMediaQueryMock.mockReturnValue(false);
    const { container } = render(<Receive />);
    expect(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-size")).toBe("220");
  });

  it("uses 160px QR on mobile (isMobile=true)", () => {
    useMediaQueryMock.mockReturnValue(true);
    const { container } = render(<Receive />);
    expect(container.querySelector("[data-testid='qr-code']")!.getAttribute("data-qr-size")).toBe("160");
  });

  it("subtitle reads 'Scan to send me money' when no amount", () => {
    const { container } = render(<Receive />);
    expect(container.textContent).toContain("Scan to send me money");
  });

  it("subtitle reads 'Scan to send $X' when amount entered", () => {
    const { container, getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "42" } });
    expect(container.textContent).toContain("Scan to send $42");
  });

  it("subtitle strips trailing dot when displayed ('5.' shows '$5', not '$5.')", () => {
    const { container, getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "5." } });
    expect(container.textContent).toContain("Scan to send $5");
    expect(container.textContent).not.toContain("Scan to send $5.");
  });
});

describe("Receive — copy address (§15.x)", () => {
  it("clicking 'Copy Address' calls navigator.clipboard.writeText(address)", async () => {
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(ADDR);
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("button label swaps to 'Copied!' after a successful copy", async () => {
    const { getByLabelText } = render(<Receive />);
    const btn = getByLabelText("Copy address");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(btn.textContent).toContain("Copied!");
  });

  it("'Copied!' state reverts after 2s timeout", async () => {
    vi.useFakeTimers();
    const { getByLabelText } = render(<Receive />);
    const btn = getByLabelText("Copy address");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(btn.textContent).toContain("Copied!");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(btn.textContent).toContain("Copy Address");
  });

  it("clipboard rejection → 'Failed to copy' toast (NOT a silent fail)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy");
  });
});

describe("Receive — copy payment link (§15.x)", () => {
  it("clicking 'Copy Payment Link' copies the FULL URL (not the address)", async () => {
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy payment link"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    const arg = writeTextMock.mock.calls[0][0];
    expect(arg).toContain("/app/send/amount?to=");
  });
});

describe("Receive — share button (§15.x)", () => {
  it("clicking 'Share' calls navigator.share with bare-address text when no amount", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
    });
    expect(shareMock).toHaveBeenCalledTimes(1);
    const arg = shareMock.mock.calls[0][0];
    expect(arg.title).toBe("Pay me on BlankPay");
    expect(arg.text).toBe("Send me an FHE-encrypted payment on BlankPay");
    expect(arg.url).toContain("/app/send/amount?to=");
  });

  it("share with amount uses 'Send me $X on BlankPay' framing", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "20" } });
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
    });
    expect(shareMock.mock.calls[0][0].title).toBe("Pay $20 on BlankPay");
    expect(shareMock.mock.calls[0][0].text).toContain("Send me $20 on BlankPay");
  });

  it("share with amount + note appends note via separator", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "20" } });
    fireEvent.change(getByLabelText("Payment note"), { target: { value: "dinner" } });
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
    });
    expect(shareMock.mock.calls[0][0].text).toContain("dinner");
  });

  it("share with trailing-dot amount strips the dot in share text", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByLabelText } = render(<Receive />);
    fireEvent.change(getByLabelText("Request amount in USDC"), { target: { value: "5." } });
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
    });
    expect(shareMock.mock.calls[0][0].title).toBe("Pay $5 on BlankPay");
    expect(shareMock.mock.calls[0][0].text).toContain("Send me $5 on BlankPay");
  });

  it("share rejection (user cancel) falls back to clipboard copy of the URL", async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error("cancelled"));
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    expect(writeTextMock.mock.calls[0][0]).toContain("/app/send/amount?to=");
  });

  it("no navigator.share + no address → handleShare is a no-op (no throw)", async () => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    const { getByLabelText } = render(<Receive />);
    await act(async () => {
      fireEvent.click(getByLabelText("Share payment link"));
      await Promise.resolve();
    });
    expect(writeTextMock).not.toHaveBeenCalled();
  });
});
