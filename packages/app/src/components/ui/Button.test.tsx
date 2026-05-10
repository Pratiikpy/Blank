import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Mock framer-motion BEFORE importing the SUT so motion.button →
// plain <button>. We don't need to verify spring physics; we
// need to verify click handling, disabled-vs-loading state,
// variant class binding, and accessibility attributes.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...rest }, ref) => {
        // Strip framer-only props that React would warn about.
        const safeProps = Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) => !k.startsWith("while") && !k.startsWith("initial") && !k.startsWith("animate") && !k.startsWith("exit") && k !== "transition" && k !== "layoutId",
          ),
        );
        return React.createElement(prop, { ref, ...safeProps }, children as React.ReactNode);
      },
    ),
  });
  return { motion, AnimatePresence: ({ children }: { children: React.ReactNode }) => children };
});

import { Button } from "./Button";

describe("Button (§15.x)", () => {
  it("renders children inside a <button>", () => {
    const { getByText, container } = render(<Button>Click me</Button>);
    expect(getByText("Click me")).toBeDefined();
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { getByText } = render(<Button onClick={onClick}>Tap</Button>);
    fireEvent.click(getByText("Tap"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled=true sets the disabled attribute", () => {
    const { container } = render(<Button disabled>Off</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("loading=true sets disabled (acts as disabled-with-spinner)", () => {
    const { container } = render(<Button loading>Saving</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("loading=true sets aria-busy=true (a11y signal)", () => {
    const { container } = render(<Button loading>Saving</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("aria-busy NOT set when not loading", () => {
    const { container } = render(<Button>Save</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("renders icon alongside children when icon prop is provided", () => {
    const { getByText, container } = render(
      <Button icon={<span data-testid="icon">★</span>}>
        Save
      </Button>,
    );
    expect(getByText("Save")).toBeDefined();
    expect(container.querySelector("[data-testid='icon']")).not.toBeNull();
  });

  it("variant='primary' applies the btn-accent-glow class", () => {
    const { container } = render(<Button variant="primary">Go</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "btn-accent-glow",
    );
  });

  it("variant='secondary' applies the secondary-bg class", () => {
    const { container } = render(<Button variant="secondary">Go</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "border-white/[0.08]",
    );
  });

  it("variant='danger' applies error-tinted bg", () => {
    const { container } = render(<Button variant="danger">Delete</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "bg-error/10",
    );
  });

  it("size='sm' applies h-8 height", () => {
    const { container } = render(<Button size="sm">x</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "h-8",
    );
  });

  it("size='lg' applies h-12 height", () => {
    const { container } = render(<Button size="lg">x</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "h-12",
    );
  });

  it("custom className merges with variant + size classes", () => {
    const { container } = render(<Button className="my-marker">x</Button>);
    expect((container.querySelector("button") as HTMLElement).className).toContain(
      "my-marker",
    );
  });
});
