import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// §15.x test for BlankInput. Design-system primitive paired with
// BlankButton — used in every form across the app. Wraps native
// input with: optional label (rendered above the field), error
// message (rendered below with red styling), hint message
// (rendered below with tertiary styling — hidden when error is
// present), ref forwarding, className passthrough, and all
// native input props (value / onChange / placeholder / type /
// disabled / etc).
//
// CRITICAL pins:
//   - label prop rendered ABOVE the input as a <label> element
//     when set; omitted entirely when not set (no empty label
//     node). The label is NOT yet wired to htmlFor/id — a known
//     accessibility gap that should be tracked separately.
//   - error prop priority: when set, error message appears
//     BELOW the input with red text color (var(--error)) AND
//     adds !border-[var(--error)] + focus:!ring-red-100 to the
//     input so the field itself gets a red border + red focus
//     ring; the !-bang modifiers ensure error styles win over
//     any base or className overrides.
//   - hint prop rendered BELOW the input with tertiary text
//     color WHEN error is NOT set; the error vs hint slot is
//     mutually exclusive so a field can't show both
//     simultaneously (avoids visual conflict between green
//     'helper text' and red 'fix this' messaging).
//   - className passthrough merges with 'input-field' base +
//     error styles via cn(); user-className wins last in the
//     join order.
//   - forwardRef: ref points at the native HTMLInputElement so
//     parents can call .focus() / .select() / .value access
//     directly.
//   - displayName='BlankInput' for React DevTools.
//   - All native input props spread onto the input via {...
//     props}: value / onChange / placeholder / type / disabled
//     / autoFocus / aria-* / data-*.
//   - The outer wrapper is a div with space-y-1.5 so label /
//     input / hint stack with consistent spacing; this matters
//     because nesting BlankInput inside a flex container should
//     give the same visual spacing regardless of parent layout.

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { BlankInput } from "./BlankInput";

// ───────────────────────────────────────────────────────────
//  Label slot
// ───────────────────────────────────────────────────────────

describe("BlankInput — label slot (§15.x)", () => {
  it("label prop set -> renders a <label> element above the input", () => {
    const { container } = render(<BlankInput label="Email" />);
    const label = container.querySelector("label");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Email");
  });

  it("label prop omitted -> NO label element rendered (no empty node)", () => {
    const { container } = render(<BlankInput />);
    expect(container.querySelector("label")).toBeNull();
  });

  it("label has 'text-label' design-token class for typography consistency", () => {
    const { container } = render(<BlankInput label="Amount" />);
    const label = container.querySelector("label");
    expect(label!.className).toContain("text-label");
  });
});

// ───────────────────────────────────────────────────────────
//  Error slot (priority over hint)
// ───────────────────────────────────────────────────────────

describe("BlankInput — error slot (§15.x)", () => {
  it("error prop set -> renders error message below the input", () => {
    render(<BlankInput error="Required field" />);
    expect(screen.getByText("Required field")).toBeInTheDocument();
  });

  it("error prop adds red border + red focus-ring to input via !-bang utilities", () => {
    const { container } = render(<BlankInput error="Bad" />);
    const input = container.querySelector("input");
    expect(input!.className).toContain("!border-[var(--error)]");
    expect(input!.className).toContain("focus:!ring-red-100");
  });

  it("error prop OMITTED -> input does NOT get the error-border class", () => {
    const { container } = render(<BlankInput />);
    const input = container.querySelector("input");
    expect(input!.className).not.toContain("!border-[var(--error)]");
  });

  it("error message has var(--error) color class", () => {
    const { container } = render(<BlankInput error="Bad" />);
    const errorP = container.querySelector("p.text-\\[var\\(--error\\)\\]");
    expect(errorP).not.toBeNull();
    expect(errorP!.textContent).toBe("Bad");
  });
});

// ───────────────────────────────────────────────────────────
//  Hint slot (mutually exclusive with error)
// ───────────────────────────────────────────────────────────

describe("BlankInput — hint slot (§15.x)", () => {
  it("hint prop set, error NOT set -> hint message below the input", () => {
    render(<BlankInput hint="Min 8 characters" />);
    expect(screen.getByText("Min 8 characters")).toBeInTheDocument();
  });

  it("hint AND error both set -> ONLY error shown, hint hidden (priority)", () => {
    render(<BlankInput hint="Min 8 chars" error="Required" />);
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByText("Min 8 chars")).toBeNull();
  });

  it("hint prop omitted (and no error) -> NO secondary text rendered", () => {
    const { container } = render(<BlankInput />);
    // No <p> elements rendered below input
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("hint message has tertiary text color (NOT error color)", () => {
    const { container } = render(<BlankInput hint="Helper" />);
    const hintP = container.querySelector(
      "p.text-\\[var\\(--text-tertiary\\)\\]",
    );
    expect(hintP).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  className + base styles
// ───────────────────────────────────────────────────────────

describe("BlankInput — className + base (§15.x)", () => {
  it("input has 'input-field' base class", () => {
    const { container } = render(<BlankInput />);
    expect(container.querySelector("input")!.className).toContain("input-field");
  });

  it("custom className merges with base + error via cn() (user wins last)", () => {
    const { container } = render(<BlankInput className="custom-extra" />);
    const input = container.querySelector("input");
    expect(input!.className).toContain("input-field");
    expect(input!.className).toContain("custom-extra");
  });

  it("wrapper div has space-y-1.5 for consistent vertical stacking", () => {
    const { container } = render(<BlankInput label="X" hint="Y" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("space-y-1.5");
  });
});

// ───────────────────────────────────────────────────────────
//  Ref forwarding
// ───────────────────────────────────────────────────────────

describe("BlankInput — ref forwarding (§15.x)", () => {
  it("ref points at the native HTMLInputElement", () => {
    const ref = createRef<HTMLInputElement>();
    render(<BlankInput ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("ref.current.focus() works (parent-controlled focus)", () => {
    const ref = createRef<HTMLInputElement>();
    render(<BlankInput ref={ref} />);
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("displayName='BlankInput' for React DevTools", () => {
    expect(BlankInput.displayName).toBe("BlankInput");
  });
});

// ───────────────────────────────────────────────────────────
//  Prop passthrough (native input props)
// ───────────────────────────────────────────────────────────

describe("BlankInput — prop passthrough (§15.x)", () => {
  it("value + onChange wiring works (controlled input)", () => {
    const onChange = vi.fn();
    render(<BlankInput value="hello" onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("hello");
    fireEvent.change(input, { target: { value: "hello world" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("placeholder passthrough", () => {
    render(<BlankInput placeholder="Enter email" />);
    expect(
      (screen.getByRole("textbox") as HTMLInputElement).placeholder,
    ).toBe("Enter email");
  });

  it("type='password' passthrough -> input.type='password'", () => {
    const { container } = render(<BlankInput type="password" />);
    const input = container.querySelector("input")!;
    expect(input.type).toBe("password");
  });

  it("type='number' passthrough -> input.type='number'", () => {
    const { container } = render(<BlankInput type="number" />);
    const input = container.querySelector("input")!;
    expect(input.type).toBe("number");
  });

  it("disabled passthrough", () => {
    render(<BlankInput disabled />);
    expect(
      (screen.getByRole("textbox") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("aria-label passthrough", () => {
    render(<BlankInput aria-label="Email address" />);
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("data-testid passthrough", () => {
    render(<BlankInput data-testid="email-input" />);
    expect(screen.getByTestId("email-input")).toBeInTheDocument();
  });

  it("autoFocus passthrough", () => {
    render(<BlankInput autoFocus data-testid="auto-input" />);
    expect(document.activeElement).toBe(screen.getByTestId("auto-input"));
  });
});
