import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for two share/install affordance components:
// CopyInvoiceLink (clipboard write + 2s "Copied" feedback) and
// IosPwaCoachMark (iOS + non-PWA + non-dismissed triple-gate banner
// for Web-Push install prompting).

const buildInvoiceLinkMock = vi.hoisted(() => vi.fn());
const isIosMock = vi.hoisted(() => vi.fn());
const isStandalonePwaMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/invoice-links", () => ({
  buildInvoiceLink: buildInvoiceLinkMock,
}));

vi.mock("@/lib/push-notifications", () => ({
  isIos: isIosMock,
  isStandalonePwa: isStandalonePwaMock,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import { CopyInvoiceLink } from "./CopyInvoiceLink";
import { IosPwaCoachMark } from "./IosPwaCoachMark";

beforeEach(() => {
  buildInvoiceLinkMock.mockReset();
  isIosMock.mockReset();
  isStandalonePwaMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  buildInvoiceLinkMock.mockReturnValue("https://blank.app/app/invoice/11155111/42");
  localStorage.clear();
  // Stub navigator.clipboard.writeText for the copy path.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyInvoiceLink (§15.x)", () => {
  it("default variant='full' renders 'Copy link' label + Copy icon", () => {
    const { container } = render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    expect(container.textContent).toContain("Copy link");
  });

  it("variant='icon' renders icon-only button (no label text) with aria-label", () => {
    const { container, getByLabelText } = render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="icon" />,
    );
    expect(container.textContent).not.toContain("Copy link");
    expect(getByLabelText("Copy invoice link")).toBeDefined();
  });

  it("clicking calls buildInvoiceLink with (chainId, invoiceId) and writes URL to clipboard", async () => {
    const { container } = render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    const writeText = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
    });

    expect(buildInvoiceLinkMock).toHaveBeenCalledWith(11155111, 42);
    expect(writeText).toHaveBeenCalledWith("https://blank.app/app/invoice/11155111/42");
    expect(toastSuccessMock).toHaveBeenCalledWith("Invoice link copied");
  });

  it("flips to 'Copied' state after successful copy + reverts after ~2s", async () => {
    vi.useFakeTimers();
    const { container } = render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);

    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
      // Flush the async clipboard.writeText promise so setCopied(true) resolves.
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Copied");

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(container.textContent).toContain("Copy link");
    expect(container.textContent).not.toContain("Copied");
  });

  it("clipboard write rejection triggers an error toast (not a thrown error)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("clipboard denied"); }) },
      configurable: true,
      writable: true,
    });
    const { container } = render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);

    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
    });

    expect(toastErrorMock).toHaveBeenCalledWith("clipboard denied");
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("supports invoiceId as string (slug-style) too, not just number", async () => {
    const { container } = render(<CopyInvoiceLink chainId={84532} invoiceId="INV-42" />);
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
    });
    expect(buildInvoiceLinkMock).toHaveBeenCalledWith(84532, "INV-42");
  });
});

describe("IosPwaCoachMark — visibility triple-gate (§15.x)", () => {
  it("renders nothing when isIos() is false (desktop / Android)", () => {
    isIosMock.mockReturnValue(false);
    isStandalonePwaMock.mockReturnValue(false);
    const { container } = render(<IosPwaCoachMark />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when isIos() is true but already in standalone PWA", () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(true);
    const { container } = render(<IosPwaCoachMark />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when localStorage flag says user already dismissed", () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(false);
    localStorage.setItem("blank_ios_pwa_coach_dismissed", "1");
    const { container } = render(<IosPwaCoachMark />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when iOS + not standalone + not dismissed (all 3 gates pass)", () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(false);
    const { container } = render(<IosPwaCoachMark />);
    expect(container.textContent).toContain("Add Blank to your Home Screen");
    expect(container.textContent).toContain("Add to Home Screen");
  });

  it("uses role='status' for screen-reader announcement", () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(false);
    const { getByRole } = render(<IosPwaCoachMark />);
    expect(getByRole("status")).toBeDefined();
  });

  it("clicking dismiss persists 'blank_ios_pwa_coach_dismissed=1' to localStorage AND hides the banner", () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(false);
    const { container, getByLabelText } = render(<IosPwaCoachMark />);
    expect(container.textContent).toContain("Add Blank");

    fireEvent.click(getByLabelText("Dismiss"));

    expect(localStorage.getItem("blank_ios_pwa_coach_dismissed")).toBe("1");
    expect(container.textContent).not.toContain("Add Blank");
  });
});
