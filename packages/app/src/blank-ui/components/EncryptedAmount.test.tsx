import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for the LIGHTWEIGHT EncryptedAmount in blank-ui (distinct
// from the heavier framer-motion variant in components/common/). The
// 3-tier formatting strategy is the load-bearing bit: <0.01 shows 6
// decimals, <1 shows 4 decimals, otherwise 2 (en-US locale grouping).
// This handles small-amount dust ($0.000001) without rounding to
// "$0.00" — important for FHE where every wei matters.

import { EncryptedAmount } from "./EncryptedAmount";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EncryptedAmount (blank-ui) — placeholder + reveal (§15.x)", () => {
  it("renders $***** placeholder when not revealed", () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} />);
    expect(container.textContent).toBe("$*****");
  });

  it("does NOT render Eye toggle when value is null", () => {
    const { container, queryByLabelText } = render(<EncryptedAmount value={null} />);
    expect(queryByLabelText("Reveal amount")).toBeNull();
    expect(queryByLabelText("Hide amount")).toBeNull();
    // Value-less span still renders the placeholder.
    expect(container.textContent).toContain("$*****");
  });

  it("clicking the toggle reveals the formatted value", () => {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={1_500_000n} />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(container.textContent).toContain("$1.50");
  });

  it("auto-hides after the 10s reveal timeout", () => {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={1_000_000n} />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(container.textContent).toContain("$1.00");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(container.textContent).toContain("$*****");
  });

  it("clicking again before timeout hides immediately", () => {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={1_000_000n} />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(container.textContent).toContain("$1.00");

    fireEvent.click(getByLabelText("Hide amount"));
    expect(container.textContent).toContain("$*****");
  });

  it("clicking placeholder when value=null is a no-op (no Eye to click; defensive)", () => {
    // Even rendering — useToggleReveal short-circuits on null value.
    const { container } = render(<EncryptedAmount value={null} />);
    expect(container.textContent).toContain("$*****");
  });
});

describe("EncryptedAmount (blank-ui) — 3-tier formatting (§15.x)", () => {
  function reveal(value: bigint | number, decimals = 6): string {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={value} decimals={decimals} />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    return container.textContent ?? "";
  }

  it("amount >= 1: 2-decimal locale-grouped (1,234,567.89)", () => {
    // 1234.56 USDC at 6 decimals = 1234560000n.
    expect(reveal(1_234_560_000n)).toContain("$1,234.56");
  });

  it("amount < 1 and >= 0.01: 4 decimals (0.5000)", () => {
    expect(reveal(500_000n)).toContain("$0.5000");
  });

  it("amount < 0.01 and > 0: 6 decimals (avoids rounding dust to $0.00)", () => {
    // 0.000001 USDC = 1n at 6 decimals.
    expect(reveal(1n)).toContain("$0.000001");
  });

  it("zero is rendered with 2-decimal default ('$0.00')", () => {
    expect(reveal(0n)).toContain("$0.00");
  });

  it("supports decimals prop for non-USDC tokens (1e16 wei / 18 = 0.01)", () => {
    expect(reveal(10_000_000_000_000_000n, 18)).toContain("$0.0100");
  });

  it("plain number values are NOT divided by decimals (raw number passed through)", () => {
    // Source: `typeof value === "bigint" ? Number(value)/10**decimals : value`
    // So `value=2` (not 2_000_000) renders as "$2.00".
    expect(reveal(2)).toContain("$2.00");
    // And a "raw" 2,000,000 number renders with locale grouping:
    expect(reveal(2_000_000)).toContain("$2,000,000.00");
  });
});

describe("EncryptedAmount (blank-ui) — prefix + size variants (§15.x)", () => {
  it("prefix='+' renders the literal '+' before the amount", () => {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={1_000_000n} prefix="+" />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(container.textContent).toContain("+$1.00");
  });

  it("prefix='-' renders the literal '-' before the amount", () => {
    const { container, getByLabelText } = render(
      <EncryptedAmount value={1_000_000n} prefix="-" />,
    );
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(container.textContent).toContain("-$1.00");
  });

  it("placeholder also includes the prefix when set ('+$*****')", () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} prefix="+" />);
    expect(container.textContent).toBe("+$*****");
  });

  it("each size variant applies the matching text class (after reveal so twMerge doesn't strip it)", () => {
    // Need to reveal first: in the placeholder state the inner span gets
    // BOTH the size class AND `text-[var(--text-tertiary)]`, and twMerge
    // resolves text-display-hero vs text-[arbitrary] as conflicting
    // text-* utilities — keeping only the latter. Revealing swaps in
    // text-[var(--text-primary)] which doesn't conflict the same way.
    const cases = [
      ["sm", "text-sm"],
      ["md", "text-lg"],
      ["lg", "text-2xl"],
    ] as const;
    for (const [size, cls] of cases) {
      const { container, getByLabelText, unmount } = render(
        <EncryptedAmount value={1_000_000n} size={size} />,
      );
      fireEvent.click(getByLabelText("Reveal amount"));
      const innerSpan = container.querySelector("span > span")!;
      expect(innerSpan.className).toContain(cls);
      unmount();
    }
  });
});

describe("EncryptedAmount (blank-ui) — showToggle prop (§15.x)", () => {
  it("showToggle=false hides the eye button entirely", () => {
    const { queryByLabelText } = render(
      <EncryptedAmount value={1_000_000n} showToggle={false} />,
    );
    expect(queryByLabelText("Reveal amount")).toBeNull();
    expect(queryByLabelText("Hide amount")).toBeNull();
  });

  it("showToggle=true (default) renders the eye button when value is set", () => {
    const { getByLabelText } = render(<EncryptedAmount value={1_000_000n} />);
    expect(getByLabelText("Reveal amount")).toBeDefined();
  });

  it("aria-label flips between 'Reveal amount' and 'Hide amount' on toggle", () => {
    const { getByLabelText } = render(<EncryptedAmount value={1_000_000n} />);
    fireEvent.click(getByLabelText("Reveal amount"));
    expect(getByLabelText("Hide amount")).toBeDefined();
  });
});
