import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for CopyInvoiceLink. Small affordance used in
// BusinessTools (next to each invoice in the vendor list) AND on
// InvoicePage (vendor view) to copy the canonical share link
// `<origin>/app/invoice/<chainId>/<id>` to the clipboard. Two
// variants: 'full' (default — 'Copy link' pill) and 'icon'
// (compact 36×36 icon-only button).
//
// CRITICAL pins:
//   - Build invoice URL via buildInvoiceLink(chainId, invoiceId)
//     NOT inline string concatenation; this lets the URL format
//     change in one place (lib/invoice-links.ts) without touching
//     every consumer.
//   - Write to navigator.clipboard.writeText + on success: set
//     copied=true + toast.success('Invoice link copied') + auto-
//     clear copied after 2000ms (setTimeout); on failure: toast.
//     error with err.message verbatim OR 'Couldn't copy link'
//     fallback for non-Error throws (e.g. permission denied
//     surfaced as a string).
//   - 'icon' variant: 36×36 button (h-9 w-9), aria-label flips
//     'Copy invoice link' -> 'Copied' so screen-readers announce
//     the success state; button is icon-only (no text label)
//     so the aria-label is the only accessible name.
//   - 'full' variant: pill button with both icon AND text label
//     ('Copy link' / 'Copied'); the text serves as the accessible
//     name so no aria-label needed.
//   - copied state is per-instance (not shared across multiple
//     mounted CopyInvoiceLink components) — two mounted side-by-
//     side and clicked independently each have their own copied
//     flag.
//   - invoiceId accepts both number AND string types; the
//     interface explicitly typed `number | string` so the
//     component doesn't need to coerce.
//   - Default variant is 'full' (no variant prop -> renders pill).

const buildInvoiceLinkMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/invoice-links", () => ({
  buildInvoiceLink: buildInvoiceLinkMock,
}));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

import { CopyInvoiceLink } from "./CopyInvoiceLink";

const writeTextMock = vi.fn();

beforeEach(() => {
  buildInvoiceLinkMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  writeTextMock.mockReset();

  buildInvoiceLinkMock.mockReturnValue(
    "https://blank.app/app/invoice/11155111/42",
  );
  writeTextMock.mockResolvedValue(undefined);

  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

// ───────────────────────────────────────────────────────────
//  Variant rendering (full vs icon)
// ───────────────────────────────────────────────────────────

describe("CopyInvoiceLink — variants (§15.x)", () => {
  it("default variant ('full') -> renders pill with 'Copy link' label", () => {
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });

  it("variant='full' (explicit) -> same as default", () => {
    render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="full" />,
    );
    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });

  it("variant='icon' -> icon-only button with aria-label='Copy invoice link'", () => {
    render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="icon" />,
    );
    expect(screen.getByLabelText("Copy invoice link")).toBeInTheDocument();
    // No text label on icon variant
    expect(screen.queryByText("Copy link")).toBeNull();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("className passed through to the button element (both variants)", () => {
    const { container } = render(
      <CopyInvoiceLink
        chainId={11155111}
        invoiceId={42}
        className="custom-class"
      />,
    );
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("custom-class");
  });
});

// ───────────────────────────────────────────────────────────
//  Happy-path copy flow
// ───────────────────────────────────────────────────────────

describe("CopyInvoiceLink — copy happy path (§15.x)", () => {
  it("click 'full' variant -> buildInvoiceLink + clipboard.writeText + success toast + label flips to 'Copied'", async () => {
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(buildInvoiceLinkMock).toHaveBeenCalledWith(11155111, 42);
      expect(writeTextMock).toHaveBeenCalledWith(
        "https://blank.app/app/invoice/11155111/42",
      );
      expect(toastSuccessMock).toHaveBeenCalledWith("Invoice link copied");
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
  });

  it("click 'icon' variant -> aria-label flips to 'Copied'", async () => {
    render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="icon" />,
    );
    fireEvent.click(screen.getByLabelText("Copy invoice link"));
    await waitFor(() => {
      expect(screen.getByLabelText("Copied")).toBeInTheDocument();
    });
  });

  it("string invoiceId passed through to buildInvoiceLink unchanged", async () => {
    render(<CopyInvoiceLink chainId={11155111} invoiceId="invoice-uuid-abc" />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(buildInvoiceLinkMock).toHaveBeenCalledWith(
        11155111,
        "invoice-uuid-abc",
      );
    });
  });

  it("different chainId passed through unchanged (Base Sepolia)", async () => {
    render(<CopyInvoiceLink chainId={84532} invoiceId={7} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(buildInvoiceLinkMock).toHaveBeenCalledWith(84532, 7);
    });
  });

  it("copied state registers a setTimeout(2000ms) for the auto-clear", async () => {
    // Spy on setTimeout to verify the 2s timer registers when copied flips.
    // Avoid driving fake-time through the React + clipboard promise dance
    // (non-deterministic in jsdom — see FundAccountModal test).
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
    const matchingTimer = setTimeoutSpy.mock.calls.find(
      (call) => call[1] === 2000,
    );
    expect(matchingTimer).toBeDefined();
    setTimeoutSpy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────
//  Error path
// ───────────────────────────────────────────────────────────

describe("CopyInvoiceLink — copy error path (§15.x)", () => {
  it("clipboard.writeText rejects with Error -> toast.error with err.message + copied STAYS false", async () => {
    writeTextMock.mockRejectedValue(new Error("permission denied"));
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("permission denied");
    });
    // Label stays as 'Copy link' (copied=false because the setCopied call
    // didn't fire — promise rejected before it).
    expect(screen.getByText("Copy link")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("clipboard.writeText rejects with non-Error -> \"Couldn't copy link\" fallback", async () => {
    writeTextMock.mockRejectedValue("string error");
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Couldn't copy link");
    });
  });

  it("buildInvoiceLink throws -> caught by outer try, toast.error fires", async () => {
    buildInvoiceLinkMock.mockImplementation(() => {
      throw new Error("invalid chainId");
    });
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("invalid chainId");
    });
    // writeText should NOT have been called (build failed before we got there)
    expect(writeTextMock).toHaveBeenCalledTimes(0);
  });

  it("error path -> NO success toast", async () => {
    writeTextMock.mockRejectedValue(new Error("fail"));
    render(<CopyInvoiceLink chainId={11155111} invoiceId={42} />);
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(toastSuccessMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Per-instance copied state isolation
// ───────────────────────────────────────────────────────────

describe("CopyInvoiceLink — per-instance state isolation (§15.x)", () => {
  it("two mounted instances clicked independently have separate copied flags", async () => {
    render(
      <>
        <CopyInvoiceLink chainId={11155111} invoiceId={1} />
        <CopyInvoiceLink chainId={11155111} invoiceId={2} />
      </>,
    );
    const buttons = screen.getAllByText("Copy link");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(screen.getAllByText("Copy link")).toHaveLength(1); // one flipped to Copied
    });
    expect(screen.getAllByText("Copied")).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Button semantics
// ───────────────────────────────────────────────────────────

describe("CopyInvoiceLink — button semantics (§15.x)", () => {
  it("button type='button' on both variants (avoids accidental form submit)", () => {
    const { container: fullContainer } = render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="full" />,
    );
    expect(fullContainer.querySelector("button")?.type).toBe("button");
    const { container: iconContainer } = render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} variant="icon" />,
    );
    expect(iconContainer.querySelector("button")?.type).toBe("button");
  });

  it("renders a single <button> element per instance", () => {
    const { container } = render(
      <CopyInvoiceLink chainId={11155111} invoiceId={42} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
