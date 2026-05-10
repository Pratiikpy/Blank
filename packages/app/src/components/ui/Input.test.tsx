import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Input } from "./Input";

// §15.x test for the Input UI component. Used everywhere a form
// field appears (Send, Create Invoice, Settings). The accessibility
// + error-display contracts are the load-bearing parts.

describe("Input (§15.x)", () => {
  it("renders an input element by default", () => {
    const { container } = render(<Input placeholder="enter" />);
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input!.placeholder).toBe("enter");
  });

  it("renders the label when provided", () => {
    const { getByText } = render(<Input label="Amount" />);
    expect(getByText("Amount")).toBeDefined();
  });

  it("does NOT render label when omitted", () => {
    const { container } = render(<Input placeholder="x" />);
    expect(container.querySelectorAll("label").length).toBe(0);
  });

  it("associates label with input via htmlFor → id", () => {
    const { container } = render(<Input label="Amount" />);
    const input = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).toBeTruthy();
  });

  it("respects an explicit id prop (takes precedence over auto-id)", () => {
    const { container } = render(<Input id="custom-id" label="x" />);
    const input = container.querySelector("input")!;
    expect(input.id).toBe("custom-id");
  });

  it("renders error message with role=alert + AlertCircle icon", () => {
    const { getByRole, getByText } = render(
      <Input label="Amount" error="amount must be > 0" />,
    );
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("amount must be > 0");
    expect(getByText("amount must be > 0")).toBeDefined();
  });

  it("sets aria-invalid + aria-describedby on input when error is present", () => {
    const { container } = render(
      <Input label="Amount" error="bad" />,
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(describedBy).toContain("error");
  });

  it("renders hint when no error", () => {
    const { getByText, queryByRole } = render(
      <Input label="Amount" hint="USD only" />,
    );
    expect(getByText("USD only")).toBeDefined();
    // No alert role since there's no error.
    expect(queryByRole("alert")).toBeNull();
  });

  it("error wins over hint (hint is hidden when both are passed)", () => {
    const { getByText, queryByText } = render(
      <Input label="Amount" hint="USD only" error="bad" />,
    );
    expect(getByText("bad")).toBeDefined();
    // Hint must NOT render when error is also set.
    expect(queryByText("USD only")).toBeNull();
  });

  it("isAmount mode applies the mono + right-align classes", () => {
    const { container } = render(<Input isAmount placeholder="0" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("font-mono");
    expect(input.className).toContain("text-right");
  });

  it("rightElement renders alongside the input", () => {
    const { getByText } = render(
      <Input label="Amount" rightElement={<span>USDC</span>} />,
    );
    expect(getByText("USDC")).toBeDefined();
  });
});
