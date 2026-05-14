import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for InvoiceStatusBadge. Single source of truth for
// the on-chain BusinessHub.sol `enum InvoiceStatus { Pending,
// Paid, Cancelled, PaymentPending, Disputed }` visual rendering.
// Used on InvoicePage + activity feed rows + (in future)
// any invoice surface. The integer enum -> visual mapping must
// stay locked because: (a) the integer comes from a uint8 read
// off the chain so any drift in this table mis-labels real
// invoices, (b) the labels appear in receipts that may be
// emailed / archived as legal records, and (c) the colour
// semantics signal urgency to the user (green=paid, amber=
// awaiting, rose=refunded, blue=funded-pending, orange=disputed).
//
// CRITICAL pins:
//   - 5 enum values mapped 0..4: 0='Awaiting payment' (amber +
//     Circle); 1='Paid' (emerald + CheckCircle2); 2='Cancelled
//     / refunded' (rose + XCircle); 3='Funded, awaiting
//     finalize' (blue + Clock); 4='Disputed, refund pending'
//     (orange + AlertTriangle).
//   - Unknown enum value (out-of-range integer like 99) falls
//     back to STYLES[0] (Awaiting payment / amber); the
//     fallback is intentional because a stale enum value from
//     a future contract upgrade should look pending-ish rather
//     than crash.
//   - data-testid='invoice-status-badge' on the root span +
//     data-status={status} attribute pinned for e2e selectors
//     and analytics.
//   - Label text is the exact user-facing copy (NOT enum names
//     like 'Cancelled' alone); test pins literal strings
//     because a regression that abbreviated 'Cancelled /
//     refunded' to just 'Cancelled' would hide the refund-path
//     information that PR-C step 2 added.
//   - Each badge uses the same outer structure: inline-flex +
//     gap-1.5 + px-3 py-1 + rounded-full + border + text-xs
//     font-medium; the per-status className adds bg/text/
//     border color tokens.
//   - Number type (NOT 'enum'): the prop is `status: number` so
//     a uint8 read off the chain via wagmi/viem can be passed
//     directly without intermediate enum conversion; the
//     STYLES table is keyed on InvoiceStatus type but accessed
//     via a numeric cast.

import { InvoiceStatusBadge } from "./InvoiceStatusBadge";

// ───────────────────────────────────────────────────────────
//  Status 0..4 -> label + visual variant mapping
// ───────────────────────────────────────────────────────────

describe("InvoiceStatusBadge — 5 enum values (§15.x)", () => {
  it("status=0 -> 'Awaiting payment' + amber colors", () => {
    render(<InvoiceStatusBadge status={0} />);
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("bg-amber-50");
    expect(badge.className).toContain("text-amber-700");
    expect(badge.className).toContain("border-amber-100");
  });

  it("status=1 -> 'Paid' + emerald colors", () => {
    render(<InvoiceStatusBadge status={1} />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("bg-emerald-50");
    expect(badge.className).toContain("text-emerald-700");
  });

  it("status=2 -> 'Cancelled / refunded' + rose colors", () => {
    render(<InvoiceStatusBadge status={2} />);
    expect(screen.getByText("Cancelled / refunded")).toBeInTheDocument();
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("bg-rose-50");
    expect(badge.className).toContain("text-rose-700");
  });

  it("status=3 -> 'Funded, awaiting finalize' + blue colors", () => {
    render(<InvoiceStatusBadge status={3} />);
    expect(screen.getByText("Funded, awaiting finalize")).toBeInTheDocument();
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("bg-blue-50");
    expect(badge.className).toContain("text-blue-700");
  });

  it("status=4 -> 'Disputed, refund pending' + orange colors", () => {
    render(<InvoiceStatusBadge status={4} />);
    expect(screen.getByText("Disputed, refund pending")).toBeInTheDocument();
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("bg-orange-50");
    expect(badge.className).toContain("text-orange-700");
  });
});

// ───────────────────────────────────────────────────────────
//  Unknown-value fallback to status=0
// ───────────────────────────────────────────────────────────

describe("InvoiceStatusBadge — unknown value fallback (§15.x)", () => {
  it("status=99 (out of range) -> falls back to 'Awaiting payment'", () => {
    render(<InvoiceStatusBadge status={99} />);
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
  });

  it("status=-1 (negative) -> falls back to 'Awaiting payment'", () => {
    render(<InvoiceStatusBadge status={-1} />);
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
  });

  it("data-status attribute STILL reflects the raw input (NOT the fallback)", () => {
    render(<InvoiceStatusBadge status={99} />);
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.getAttribute("data-status")).toBe("99");
  });
});

// ───────────────────────────────────────────────────────────
//  data-testid + data-status contract
// ───────────────────────────────────────────────────────────

describe("InvoiceStatusBadge — data attributes (§15.x)", () => {
  it("data-testid='invoice-status-badge' for e2e selectors", () => {
    render(<InvoiceStatusBadge status={1} />);
    expect(screen.getByTestId("invoice-status-badge")).toBeInTheDocument();
  });

  it("data-status reflects the numeric status (0..4)", () => {
    const { rerender } = render(<InvoiceStatusBadge status={0} />);
    expect(
      screen.getByTestId("invoice-status-badge").getAttribute("data-status"),
    ).toBe("0");

    rerender(<InvoiceStatusBadge status={4} />);
    expect(
      screen.getByTestId("invoice-status-badge").getAttribute("data-status"),
    ).toBe("4");
  });
});

// ───────────────────────────────────────────────────────────
//  Outer structure (shared across all statuses)
// ───────────────────────────────────────────────────────────

describe("InvoiceStatusBadge — shared outer structure (§15.x)", () => {
  it("renders as <span> (NOT <div>) so it inlines in copy", () => {
    render(<InvoiceStatusBadge status={1} />);
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.tagName).toBe("SPAN");
  });

  it("has inline-flex + gap-1.5 + px-3 py-1 + rounded-full + border + text-xs font-medium base classes", () => {
    render(<InvoiceStatusBadge status={0} />);
    const badge = screen.getByTestId("invoice-status-badge");
    expect(badge.className).toContain("inline-flex");
    expect(badge.className).toContain("gap-1.5");
    expect(badge.className).toContain("px-3");
    expect(badge.className).toContain("py-1");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("border");
    expect(badge.className).toContain("text-xs");
    expect(badge.className).toContain("font-medium");
  });

  it("Icon rendered inline (svg child of the span)", () => {
    render(<InvoiceStatusBadge status={1} />);
    const badge = screen.getByTestId("invoice-status-badge");
    const svg = badge.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
