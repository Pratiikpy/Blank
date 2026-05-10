import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Extended framer-motion mock: motion.X via Proxy + useMotionValue +
// useSpring + useTransform stubs that pass values through unchanged.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, style, ...rest }, ref) => {
        const safeProps = Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) =>
              !k.startsWith("while") &&
              !k.startsWith("initial") &&
              !k.startsWith("animate") &&
              !k.startsWith("exit") &&
              k !== "transition" &&
              k !== "layoutId",
          ),
        );
        return React.createElement(prop, { ref, style, ...safeProps }, children as React.ReactNode);
      },
    ),
  });
  // Stubs return a plain object with a .set() method — TiltCard reads
  // motion-value handles via .set() but framer renders the values via
  // the style prop, which our motion-mock just passes through as-is.
  const useMotionValue = (initial: unknown) => ({
    get: () => initial,
    set: vi.fn(),
    on: vi.fn(() => () => {}),
  });
  const useSpring = (val: unknown) => val;
  const useTransform = (_val: unknown, _input: unknown, _output?: unknown) => 0;
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useMotionValue,
    useSpring,
    useTransform,
  };
});

import { TiltCard } from "./TiltCard";

describe("TiltCard (§15.x)", () => {
  it("renders children inside the card", () => {
    const { getByText } = render(
      <TiltCard>
        <span>tilt-child</span>
      </TiltCard>,
    );
    expect(getByText("tilt-child")).toBeDefined();
  });

  it("wraps content in a perspective container (3D context)", () => {
    const { container } = render(
      <TiltCard>
        <span>x</span>
      </TiltCard>,
    );
    // The outer wrapper sets perspective via inline style.
    const outer = container.firstChild as HTMLElement;
    expect(outer.style.perspective).toBe("800px");
  });

  it("custom className applies to the inner card", () => {
    const { container } = render(
      <TiltCard className="my-tilt-marker">
        <span>x</span>
      </TiltCard>,
    );
    // Inner motion.div is the second-level element under perspective wrapper.
    expect(container.innerHTML).toContain("my-tilt-marker");
  });

  it("disabled=true does NOT throw on mouse events (no-op behavior)", () => {
    const { container } = render(
      <TiltCard disabled>
        <span>x</span>
      </TiltCard>,
    );
    const card = container.querySelector(".my-tilt-marker") ?? (container.firstChild as HTMLElement).firstChild as HTMLElement;
    // Mouse events should NOT crash even with disabled=true.
    expect(() => {
      fireEvent.mouseEnter(card as HTMLElement);
      fireEvent.mouseMove(card as HTMLElement, { clientX: 100, clientY: 100 });
      fireEvent.mouseLeave(card as HTMLElement);
    }).not.toThrow();
  });

  it("mouse-move on enabled card does NOT throw (motion-value handles wired)", () => {
    const { container } = render(
      <TiltCard>
        <span>x</span>
      </TiltCard>,
    );
    const card = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(() => {
      fireEvent.mouseEnter(card);
      fireEvent.mouseMove(card, { clientX: 50, clientY: 50 });
      fireEvent.mouseLeave(card);
    }).not.toThrow();
  });

  it("renders the dot-grid + highlight + glare overlays (aria-hidden)", () => {
    const { container } = render(
      <TiltCard>
        <span>x</span>
      </TiltCard>,
    );
    // The 3 decorative overlays are aria-hidden so screen readers skip.
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThanOrEqual(3);
  });
});
