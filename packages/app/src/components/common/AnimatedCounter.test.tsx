import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Stub framer-motion: useInView returns true (always in-view in tests),
// useMotionValue + useTransform pass through; animate is a no-op.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    useInView: () => true,
    useMotionValue: (initial: number) => ({
      get: () => initial,
      set: vi.fn(),
      on: vi.fn(() => () => {}),
    }),
    useTransform: () => ({
      get: () => 0,
      set: vi.fn(),
      on: vi.fn(() => () => {}),
    }),
    animate: vi.fn(),
    motion: new Proxy({}, {
      get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
        ({ children, ...rest }, ref) =>
          React.createElement(prop, { ref, ...rest }, children as React.ReactNode),
      ),
    }),
  };
});

import { AnimatedCounter } from "./AnimatedCounter";

describe("AnimatedCounter (§15.x)", () => {
  it("renders prefix + 0 + suffix initially (before animation)", () => {
    const { container } = render(
      <AnimatedCounter value={100} prefix="$" suffix=" USDC" />,
    );
    // The hook initializes to "0" textContent on mount.
    expect(container.textContent).toContain("$");
    expect(container.textContent).toContain(" USDC");
    expect(container.textContent).toContain("0");
  });

  it("renders without prefix or suffix", () => {
    const { container } = render(<AnimatedCounter value={50} />);
    expect(container.textContent).toBe("0");
  });

  it("custom className applies to the span wrapper", () => {
    const { container } = render(
      <AnimatedCounter value={1} className="my-counter" />,
    );
    const span = container.querySelector("span")!;
    expect(span.className).toContain("my-counter");
  });

  it("rendered element is a span (inline metric)", () => {
    const { container } = render(<AnimatedCounter value={42} />);
    expect(container.querySelector("span")).not.toBeNull();
  });

  it("respects custom duration prop without crashing", () => {
    expect(() =>
      render(<AnimatedCounter value={42} duration={500} />),
    ).not.toThrow();
  });

  it("re-render with the same value does not crash (hasAnimated guard)", () => {
    const { rerender } = render(<AnimatedCounter value={42} />);
    expect(() => rerender(<AnimatedCounter value={42} />)).not.toThrow();
  });
});
