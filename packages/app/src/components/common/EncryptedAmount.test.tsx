import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for EncryptedAmount. Pins the value-formatting contract
// (decimals + en-US locale) and the reveal/hide lifecycle including
// the 10s auto-hide timeout. Get the decimals wrong and balances
// display 1000x off; get the timeout off and revealed amounts stay
// on screen forever.

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...rest }, ref) => {
        const safe = Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) =>
              !k.startsWith("while") &&
              !k.startsWith("initial") &&
              !k.startsWith("animate") &&
              !k.startsWith("exit") &&
              k !== "transition" &&
              k !== "layoutId" &&
              k !== "layout" &&
              k !== "style",
          ),
        );
        return React.createElement(prop, { ref, ...safe }, children as React.ReactNode);
      },
    ),
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useMotionValue: () => ({ get: () => 0, set: () => {} }),
    useTransform: () => 0,
    animate: () => ({ stop: () => {} }),
  };
});

import { EncryptedAmount } from "./EncryptedAmount";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EncryptedAmount — placeholder + loading (§15.x)", () => {
  it("renders the encrypted placeholder (•••.••) when not revealed", () => {
    const { container } = render(<EncryptedAmount value={1_234_567_000n} />);
    // Placeholder is "•••• .••" (4 bullets + . + 2 bullets via •).
    expect(container.textContent).toMatch(/[•]{4}\.[•]{2}/);
  });

  it("shows shimmer skeleton with role='status' when isLoading", () => {
    const { getByRole } = render(<EncryptedAmount isLoading={true} />);
    const status = getByRole("status");
    expect(status.className).toContain("shimmer");
    expect(status.getAttribute("aria-label")).toBe("Loading encrypted amount");
  });

  it("shows ShieldCheck lock icon when value is null/undefined (no toggle path)", () => {
    const { container } = render(<EncryptedAmount value={null} />);
    // No revealed value, no Eye toggle — only the ShieldCheck SVG.
    expect(container.querySelector("svg")).not.toBeNull();
    // Button should NOT be cursor-pointer (no value to reveal). The
    // cursor-pointer class only renders when showToggle && formattedValue
    // both truthy.
    const btn = container.querySelector("button")!;
    expect(btn.className).not.toContain("cursor-pointer");
  });
});

describe("EncryptedAmount — reveal lifecycle (§15.x)", () => {
  it("clicking toggles reveal → shows formatted $value", async () => {
    // 1.5M USDC at 6 decimals = $1,500,000.00
    const { container } = render(<EncryptedAmount value={1_500_000_000_000n} />);
    const button = container.querySelector("button")!;

    await act(async () => {
      fireEvent.click(button);
      // Advance enough to bypass scramble (350ms) but not the 10s reveal timeout.
      vi.advanceTimersByTime(500);
    });

    expect(container.textContent).toContain("$1,500,000.00");
  });

  it("auto-hides after the 10s reveal timeout", async () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} />);
    const button = container.querySelector("button")!;

    await act(async () => {
      fireEvent.click(button);
      vi.advanceTimersByTime(500); // past scramble
    });
    expect(container.textContent).toContain("$1.00");

    await act(async () => {
      vi.advanceTimersByTime(10_000); // past REVEAL_TIMEOUT_MS
    });

    // Back to encrypted placeholder.
    expect(container.textContent).toMatch(/[•]{4}\.[•]{2}/);
    expect(container.textContent).not.toContain("$1.00");
  });

  it("clicking again before timeout hides immediately (manual toggle)", async () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} />);
    const button = container.querySelector("button")!;

    await act(async () => {
      fireEvent.click(button);
      vi.advanceTimersByTime(500);
    });
    expect(container.textContent).toContain("$1.00");

    await act(async () => {
      fireEvent.click(button);
    });
    expect(container.textContent).toMatch(/[•]{4}\.[•]{2}/);
  });

  it("click is a no-op when value is null (no reveal, no error)", async () => {
    const { container } = render(<EncryptedAmount value={null} />);
    const button = container.querySelector("button")!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(container.textContent).not.toContain("$");
  });
});

describe("EncryptedAmount — value formatting (§15.x)", () => {
  it("default 6 decimals: 1_234_567_000n → $1,234.57", async () => {
    const { container } = render(<EncryptedAmount value={1_234_567_000n} />);
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
      vi.advanceTimersByTime(500);
    });
    // 1234567000 / 1e6 = 1234.567 → toLocaleString rounds to 1,234.57
    expect(container.textContent).toContain("$1,234.57");
  });

  it("explicit decimals=18: 10_000_000_000_000_000n (1e16 wei) → $0.01", async () => {
    const { container } = render(
      <EncryptedAmount value={10_000_000_000_000_000n} decimals={18} />,
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
      vi.advanceTimersByTime(500);
    });
    expect(container.textContent).toContain("$0.01");
  });

  it("zero value still renders as $0.00 when revealed", async () => {
    const { container } = render(<EncryptedAmount value={0} />);
    await act(async () => {
      fireEvent.click(container.querySelector("button")!);
      vi.advanceTimersByTime(500);
    });
    // Note: per source, formattedValue = "0.00" but `if (!formattedValue) return;`
    // in toggleReveal — string "0.00" is truthy so reveal fires.
    expect(container.textContent).toContain("$0.00");
  });

  it("aria-label flips between encrypted hint and revealed value", async () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} symbol="USDT" />);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Encrypted amount, tap to reveal");

    await act(async () => {
      fireEvent.click(button);
      vi.advanceTimersByTime(500);
    });
    expect(button.getAttribute("aria-label")).toBe("1.00 USDT");
  });
});

describe("EncryptedAmount — showToggle prop (§15.x)", () => {
  it("showToggle=false renders cursor-default (read-only display)", () => {
    const { container } = render(
      <EncryptedAmount value={1_000_000n} showToggle={false} />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("cursor-default");
  });

  it("showToggle=true (default) renders cursor-pointer when value is set", () => {
    const { container } = render(<EncryptedAmount value={1_000_000n} />);
    const button = container.querySelector("button")!;
    expect(button.className).toContain("cursor-pointer");
  });
});

describe("EncryptedAmount — size variants (§15.x)", () => {
  it("each size variant applies a distinct text-size class", () => {
    const sizes = [
      ["sm", "text-sm"],
      ["md", "text-lg"],
      ["lg", "text-2xl"],
      ["xl", "text-mono-display"],
    ] as const;
    for (const [size, expectedClass] of sizes) {
      const { container } = render(<EncryptedAmount value={1_000_000n} size={size} />);
      // The class lands on the encrypted-text span.
      const span = container.querySelector(".encrypted-text");
      expect(span?.className).toContain(expectedClass);
    }
  });
});
