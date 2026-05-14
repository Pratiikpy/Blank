import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for FHEBadge. The 'FHE Encrypted' marker pill
// dropped next to any amount that's privacy-preserved by Fhenix
// CoFHE on-chain. The badge is intentionally static — no props
// for status / state variants. It's a visual signal that the
// adjacent amount is NOT plaintext on the chain; flipping its
// appearance based on encryption state would invert the meaning
// (user assumes 'encrypted' until they see 'NOT encrypted' UI,
// which would be silently dangerous if the badge ever rendered
// against a plaintext value).
//
// CRITICAL pins:
//   - Renders the literal string 'FHE Encrypted' (NOT 'Encrypted'
//     alone or 'FHE-protected' or any other variant); the wording
//     is locked because the brand-meaningful phrase is 'FHE' so
//     users learn what FHE means while interacting with the app.
//   - Includes a Lock icon (lucide-react) with size=12 +
//     strokeWidth=2.5 inline before the text; the strokeWidth
//     is deliberately bold (2.5 vs 2) so the icon reads as
//     'locked' at 12px size where thinner strokes would
//     disappear visually.
//   - 'badge-fhe' design-system class always applied via cn();
//     callers can pass additional className that merges via cn();
//     no variant prop because the badge has only one state.
//   - <span> root (NOT <div>) so the badge inlines next to its
//     adjacent amount in copy-flow: '{amount} {FHEBadge}'.

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { FHEBadge } from "./FHEBadge";

// ───────────────────────────────────────────────────────────
//  Static label + icon
// ───────────────────────────────────────────────────────────

describe("FHEBadge — static content (§15.x)", () => {
  it("renders the literal string 'FHE Encrypted'", () => {
    render(<FHEBadge />);
    expect(screen.getByText("FHE Encrypted")).toBeInTheDocument();
  });

  it("includes a Lock icon (svg child) inline before the text", () => {
    const { container } = render(<FHEBadge />);
    const span = container.querySelector("span");
    const svg = span!.querySelector("svg");
    expect(svg).not.toBeNull();
    // Lock icon comes BEFORE the text label
    expect(span!.firstElementChild).toBe(svg);
  });

  it("renders as a <span> (NOT a <div>) so it inlines in copy-flow", () => {
    const { container } = render(<FHEBadge />);
    const root = container.firstChild as HTMLElement;
    expect(root.tagName).toBe("SPAN");
  });

  it("badge has 'badge-fhe' design-system class", () => {
    const { container } = render(<FHEBadge />);
    const span = container.querySelector("span");
    expect(span!.className).toContain("badge-fhe");
  });
});

// ───────────────────────────────────────────────────────────
//  className passthrough
// ───────────────────────────────────────────────────────────

describe("FHEBadge — className passthrough (§15.x)", () => {
  it("custom className merges with 'badge-fhe' base via cn()", () => {
    const { container } = render(<FHEBadge className="custom-cls" />);
    const span = container.querySelector("span");
    expect(span!.className).toContain("badge-fhe");
    expect(span!.className).toContain("custom-cls");
  });

  it("no className prop -> just 'badge-fhe' base (no empty space)", () => {
    const { container } = render(<FHEBadge />);
    const span = container.querySelector("span");
    expect(span!.className).toBe("badge-fhe");
  });
});

// ───────────────────────────────────────────────────────────
//  Icon attributes (size + strokeWidth)
// ───────────────────────────────────────────────────────────

describe("FHEBadge — Lock icon attributes (§15.x)", () => {
  it("Lock icon has size=12 (rendered via svg width/height)", () => {
    const { container } = render(<FHEBadge />);
    const svg = container.querySelector("svg");
    expect(svg!.getAttribute("width")).toBe("12");
    expect(svg!.getAttribute("height")).toBe("12");
  });

  it("Lock icon has strokeWidth=2.5 (bold for readability at 12px)", () => {
    const { container } = render(<FHEBadge />);
    const svg = container.querySelector("svg");
    expect(svg!.getAttribute("stroke-width")).toBe("2.5");
  });
});
