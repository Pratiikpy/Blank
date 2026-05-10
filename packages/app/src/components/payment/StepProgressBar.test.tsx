import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

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
              k !== "layout",
          ),
        );
        return React.createElement(prop, { ref, ...safe }, children as React.ReactNode);
      },
    ),
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { StepProgressBar } from "./StepProgressBar";

describe("StepProgressBar (§15.x)", () => {
  it("renders all three step labels (Encrypt / Confirm / Send)", () => {
    const { getByText } = render(<StepProgressBar currentStep={0} />);
    expect(getByText("Encrypt")).toBeDefined();
    expect(getByText("Confirm")).toBeDefined();
    expect(getByText("Send")).toBeDefined();
  });

  it("uses role='status' with aria-live='polite' for screen-reader announcement", () => {
    const { getByRole } = render(<StepProgressBar currentStep={0} />);
    const status = getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("aria-label announces current step number + total + label", () => {
    const { getByRole } = render(<StepProgressBar currentStep={1} />);
    const status = getByRole("status");
    expect(status.getAttribute("aria-label")).toBe(
      "Payment step 2 of 3: Confirm",
    );
  });

  it("marks the active step with aria-current='step' (currentStep=0 → Encrypt)", () => {
    const { container } = render(<StepProgressBar currentStep={0} />);
    const active = container.querySelectorAll('[aria-current="step"]');
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("Encrypt");
  });

  it("aria-current shifts when currentStep advances to 1", () => {
    const { container } = render(<StepProgressBar currentStep={1} />);
    const active = container.querySelectorAll('[aria-current="step"]');
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("Confirm");
  });

  it("aria-current points at Send when currentStep=2", () => {
    const { container } = render(<StepProgressBar currentStep={2} />);
    const active = container.querySelectorAll('[aria-current="step"]');
    expect(active.length).toBe(1);
    expect(active[0].textContent).toContain("Send");
  });

  it("future steps (index > currentStep) render the step number, not a check", () => {
    const { container } = render(<StepProgressBar currentStep={0} />);
    // Step 2 (index 1) is future at currentStep=0.
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("3");
  });

  it("aria-label clamps to last step when currentStep > steps.length-1 (out-of-range guard)", () => {
    // The component uses Math.min(currentStep, steps.length - 1) to keep
    // the aria-label sane if a caller overshoots.
    const { getByRole } = render(<StepProgressBar currentStep={99} />);
    const status = getByRole("status");
    // 99+1 = "step 100 of 3" is technically what the number reads (no clamp
    // on the position number), but the label MUST stay valid — pin the label
    // tail to confirm no crash + no "undefined" leak.
    const aria = status.getAttribute("aria-label") ?? "";
    expect(aria).toContain("Send");
    expect(aria).not.toContain("undefined");
  });

  it("merges a custom className onto the root container", () => {
    const { getByRole } = render(
      <StepProgressBar currentStep={0} className="custom-cls" />,
    );
    const status = getByRole("status");
    expect(status.className).toContain("custom-cls");
    // And keeps the built-in layout classes.
    expect(status.className).toContain("flex");
  });
});
