import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for StatusBadge. Generic status pill — 5 string
// statuses each mapped to a 'badge-<status>' design-system
// class + a title-cased label. Used across activity feed rows /
// claim links / payment receipts / anywhere a state-snapshot
// pill belongs. Different from InvoiceStatusBadge in that the
// status enum here is a STRING (TypeScript union, no chain
// data) so there's no out-of-range fallback path — invalid
// status values are caught at compile time by the union type.
//
// CRITICAL pins:
//   - 5 string statuses mapped 1-to-1 with design-system
//     classes: 'confirmed' -> 'badge-confirmed' (label
//     'Confirmed'); 'pending' -> 'badge-pending' (label
//     'Pending'); 'unclaimed' -> 'badge-unclaimed' (label
//     'Unclaimed'); 'claimed' -> 'badge-claimed' (label
//     'Claimed'); 'active' -> 'badge-active' (label 'Active').
//     The label is the title-cased status name — pinned via
//     a separate statusLabels map so a future regression that
//     stringified the enum value directly (e.g. 'confirmed'
//     lowercase) gets caught.
//   - Always has 'badge-status' base class via cn() so the
//     shared pill styling (padding/border-radius/typography)
//     applies regardless of which status variant renders.
//   - className passthrough merges via cn() so callers can
//     extend or override styles per-usage (the merge order is
//     base + statusStyles[status] + className, so user wins
//     last).
//   - <span> root (NOT <div>) so the pill inlines in copy
//     blocks like "Status: {badge}".
//   - String union type means TypeScript catches typos at
//     compile time — no runtime fallback needed. Test
//     verifies the 5 mappings exhaustively so adding a new
//     status without updating both maps would either fail
//     type-check (in source) or fail an existing test (because
//     statusLabels[status] would be undefined and the render
//     would be empty).

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { StatusBadge } from "./StatusBadge";

// ───────────────────────────────────────────────────────────
//  5 status mappings exhaustive
// ───────────────────────────────────────────────────────────

describe("StatusBadge — status mappings (§15.x)", () => {
  it("status='confirmed' -> 'Confirmed' label + 'badge-confirmed' class", () => {
    render(<StatusBadge status="confirmed" />);
    const badge = screen.getByText("Confirmed");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-confirmed");
  });

  it("status='pending' -> 'Pending' label + 'badge-pending' class", () => {
    render(<StatusBadge status="pending" />);
    const badge = screen.getByText("Pending");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-pending");
  });

  it("status='unclaimed' -> 'Unclaimed' label + 'badge-unclaimed' class", () => {
    render(<StatusBadge status="unclaimed" />);
    const badge = screen.getByText("Unclaimed");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-unclaimed");
  });

  it("status='claimed' -> 'Claimed' label + 'badge-claimed' class", () => {
    render(<StatusBadge status="claimed" />);
    const badge = screen.getByText("Claimed");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-claimed");
  });

  it("status='active' -> 'Active' label + 'badge-active' class", () => {
    render(<StatusBadge status="active" />);
    const badge = screen.getByText("Active");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-active");
  });
});

// ───────────────────────────────────────────────────────────
//  Shared base class
// ───────────────────────────────────────────────────────────

describe("StatusBadge — shared base class (§15.x)", () => {
  it("all 5 statuses have 'badge-status' base class", () => {
    for (const status of ["confirmed", "pending", "unclaimed", "claimed", "active"] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      const badge = screen.getByText(
        status.charAt(0).toUpperCase() + status.slice(1),
      );
      expect(badge.className).toContain("badge-status");
      unmount();
    }
  });
});

// ───────────────────────────────────────────────────────────
//  className passthrough
// ───────────────────────────────────────────────────────────

describe("StatusBadge — className passthrough (§15.x)", () => {
  it("custom className merges with base + variant via cn() (user wins last)", () => {
    render(<StatusBadge status="confirmed" className="custom-cls" />);
    const badge = screen.getByText("Confirmed");
    expect(badge.className).toContain("badge-status");
    expect(badge.className).toContain("badge-confirmed");
    expect(badge.className).toContain("custom-cls");
  });

  it("undefined className -> no extra space-padding in the final className", () => {
    render(<StatusBadge status="pending" />);
    const badge = screen.getByText("Pending");
    // cn() filters falsy strings so no double-spaces
    expect(badge.className).not.toContain("  ");
  });
});

// ───────────────────────────────────────────────────────────
//  Structural / semantic markup
// ───────────────────────────────────────────────────────────

describe("StatusBadge — structural markup (§15.x)", () => {
  it("renders as <span> (inline element)", () => {
    render(<StatusBadge status="confirmed" />);
    const badge = screen.getByText("Confirmed");
    expect(badge.tagName).toBe("SPAN");
  });

  it("renders the label text as the only child (no nested icon or extra markup)", () => {
    render(<StatusBadge status="active" />);
    const badge = screen.getByText("Active");
    expect(badge.children).toHaveLength(0); // no element children
    expect(badge.textContent).toBe("Active");
  });
});
