import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for AmountDisplay. The big-number amount display
// rendered above the NumericKeypad on the mobile SendAmount
// screen. Renders the user's typed amount in tall mono digits
// with staggered pop-in animation per character, and underneath
// shows the 'encrypted equivalent' placeholder (████.██) to
// teach users that the on-chain stored value is FHE-encrypted
// while the input is plaintext in their browser.
//
// CRITICAL pins:
//   - empty amount ('' or '0') -> renders '0' as the display
//     value (NOT empty string); the dollar sign + 0 stay
//     visible so the user has a consistent target to type
//     INTO. The aria-label flips to 'No amount entered' for
//     screen-readers so they get a meaningful state cue
//     instead of just hearing '0 dollars'.
//   - non-empty amount -> shows the raw amount string via
//     character-split mapping (NOT parseFloat round-trip).
//     This preserves trailing decimal '.' and leading zeros
//     so typing '0.0' shows '0.0' (not '0' from parseFloat).
//   - aria-label format: empty -> 'No amount entered'; non-
//     empty -> '<amount> dollars' (so VoiceOver says 'forty-
//     two point five zero dollars' for '42.50').
//   - dollar-sign color flips based on emptiness:
//     'text-neutral-700' when empty, 'text-neutral-500' when
//     not — the empty state is slightly DIMMER so the eye
//     focuses on the keypad below rather than the empty
//     amount placeholder.
//   - digit color flips: empty -> 'text-neutral-700' (matches
//     dim dollar sign); non-empty -> 'text-white' (high
//     contrast typed input).
//   - encrypted placeholder '████.██' is the LITERAL Unicode
//     U+2022 (BULLET) chars (NOT 'X' or '#') because bullets
//     read as 'hidden value' more universally than letters or
//     hash marks; pinned literally so a regression that
//     swapped to ASCII '*' would lose the visual weight that
//     bullets carry on iOS / Android system fonts.
//   - token prop default is 'USDC' so the common case is
//     zero-config; custom token like 'USDT' or 'wETH' renders
//     in the 'encrypted <token>' label.
//   - aria-live='polite' on the outer div so screen-readers
//     announce amount changes during typing (NOT 'assertive'
//     which would cut off whatever VoiceOver is currently
//     announcing — 'polite' queues for the next pause).

// Mock framer-motion to render plain divs without animation
vi.mock("framer-motion", () => {
  return {
    motion: {
      span: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
        <span className={className}>{children}</span>
      ),
      div: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
        <div className={className}>{children}</div>
      ),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { AmountDisplay } from "./AmountDisplay";

// ───────────────────────────────────────────────────────────
//  Empty-amount default state
// ───────────────────────────────────────────────────────────

describe("AmountDisplay — empty state (§15.x)", () => {
  it("amount='' -> displays '0' (not empty), aria-label 'No amount entered'", () => {
    const { container } = render(<AmountDisplay amount="" />);
    expect(screen.getByText("0")).toBeInTheDocument();
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe("No amount entered");
  });

  it("amount='0' -> same empty-state behavior (0 + 'No amount entered')", () => {
    const { container } = render(<AmountDisplay amount="0" />);
    expect(screen.getByText("0")).toBeInTheDocument();
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe("No amount entered");
  });

  it("dollar sign color in empty state: 'text-neutral-700' (dim)", () => {
    const { container } = render(<AmountDisplay amount="" />);
    const dollarSign = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "$",
    );
    expect(dollarSign).toBeDefined();
    expect(dollarSign!.className).toContain("text-neutral-700");
  });

  it("digit color in empty state: 'text-neutral-700' (dim, matches dollar sign)", () => {
    const { container } = render(<AmountDisplay amount="" />);
    const zero = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "0",
    );
    expect(zero).toBeDefined();
    expect(zero!.className).toContain("text-neutral-700");
  });
});

// ───────────────────────────────────────────────────────────
//  Non-empty amount
// ───────────────────────────────────────────────────────────

describe("AmountDisplay — non-empty amount (§15.x)", () => {
  it("amount='42' -> renders each digit as a separate span (animation-ready)", () => {
    render(<AmountDisplay amount="42" />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("amount='42.50' -> renders all 5 chars including the '.' (NOT parseFloat round-trip)", () => {
    render(<AmountDisplay amount="42.50" />);
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(".")).toBeInTheDocument();
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  it("amount='0.0' -> preserves trailing decimal (NOT collapsed to '0' by parseFloat)", () => {
    render(<AmountDisplay amount="0.0" />);
    // The literal '0.0' chars all appear
    expect(screen.getByText(".")).toBeInTheDocument();
    // Two '0's: one before the dot, one after
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBeGreaterThanOrEqual(2);
  });

  it("aria-label format: non-empty -> '<amount> dollars'", () => {
    const { container } = render(<AmountDisplay amount="42.50" />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe("42.50 dollars");
  });

  it("dollar sign color in non-empty: 'text-neutral-500' (brighter than empty)", () => {
    const { container } = render(<AmountDisplay amount="50" />);
    const dollarSign = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "$",
    );
    expect(dollarSign).toBeDefined();
    expect(dollarSign!.className).toContain("text-neutral-500");
    expect(dollarSign!.className).not.toContain("text-neutral-700");
  });

  it("digit color in non-empty: 'text-white' (high contrast)", () => {
    const { container } = render(<AmountDisplay amount="50" />);
    const five = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "5",
    );
    expect(five).toBeDefined();
    expect(five!.className).toContain("text-white");
  });
});

// ───────────────────────────────────────────────────────────
//  Encrypted placeholder
// ───────────────────────────────────────────────────────────

describe("AmountDisplay — encrypted placeholder (§15.x)", () => {
  it("renders the literal '████.██' bullet-char placeholder (NOT '*' or '#')", () => {
    render(<AmountDisplay amount="50" />);
    // The placeholder uses U+2022 BULLET chars
    expect(screen.getByText(/••••\.••/)).toBeInTheDocument();
  });

  it("'encrypted USDC' label by default (token prop default)", () => {
    render(<AmountDisplay amount="50" />);
    expect(screen.getByText("encrypted USDC")).toBeInTheDocument();
  });

  it("custom token prop -> 'encrypted <token>' label", () => {
    render(<AmountDisplay amount="50" token="USDT" />);
    expect(screen.getByText("encrypted USDT")).toBeInTheDocument();
  });

  it("encrypted placeholder is the FULL '= ████.██' prefix (the '=' signals equality)", () => {
    render(<AmountDisplay amount="50" />);
    expect(screen.getByText(/= ••••\.••/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Accessibility
// ───────────────────────────────────────────────────────────

describe("AmountDisplay — accessibility (§15.x)", () => {
  it("outer div has aria-live='polite' so amount changes announce during typing", () => {
    const { container } = render(<AmountDisplay amount="42" />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-live")).toBe("polite");
  });

  it("aria-label updates as amount changes (controlled-component re-render)", () => {
    const { container, rerender } = render(<AmountDisplay amount="42" />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe("42 dollars");
    rerender(<AmountDisplay amount="100" />);
    expect(root.getAttribute("aria-label")).toBe("100 dollars");
  });
});

// ───────────────────────────────────────────────────────────
//  className passthrough
// ───────────────────────────────────────────────────────────

describe("AmountDisplay — className passthrough (§15.x)", () => {
  it("custom className merges with base flex-col + items-center classes", () => {
    const { container } = render(
      <AmountDisplay amount="50" className="custom-cls" />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("flex");
    expect(root.className).toContain("custom-cls");
  });
});
