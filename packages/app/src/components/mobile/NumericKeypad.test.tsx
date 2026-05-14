import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for mobile NumericKeypad. The keypad rendered in
// the BottomSheet on SendAmount / payment-flow screens. Different
// from the blank-ui NumericKeypad: structured as a 4x3 ROWS
// array (NOT a flat 11-keys + 1-backspace list) so the layout
// is explicit at the source level. Phone-style 1-2-3 at top,
// 0 at bottom with decimal point + backspace flanking it.
//
// CRITICAL pins:
//   - 4x3 grid (12 total buttons): row 1 = [1, 2, 3]; row 2 =
//     [4, 5, 6]; row 3 = [7, 8, 9]; row 4 = ['.', '0',
//     backspace]. Decimal point is at row-4 col-1 (left of 0)
//     and backspace at row-4 col-3 (right of 0); a regression
//     that swapped their positions would break user muscle
//     memory because phone-OS keypads put backspace bottom-
//     right and decimal point bottom-left.
//   - onKey called with the EXACT string value: '1', '0', '.'
//     etc.; keypad does NOT enforce decimal-only-once or any
//     other validation (caller's responsibility, same as the
//     blank-ui keypad). The split-by-type discriminated union
//     (digit | backspace) means clicking a digit fires onKey
//     and clicking backspace fires onBackspace — no leakage
//     across types.
//   - Backspace label is 'Delete' internally (the local var)
//     but aria-label is 'Backspace' so screen-readers announce
//     the user-facing word; renders Delete icon (lucide-react,
//     strokeWidth=1.5) not a text label.
//   - Outer div has role='group' + aria-label='Numeric keypad'
//     so screen-readers identify the cluster as a single
//     interactive unit.
//   - All buttons type='button' (NOT default 'submit') so
//     embedding inside a <form> doesn't accidentally submit
//     when tapping a digit.
//   - Backspace gets 'text-neutral-400' muted styling
//     (different from digits' 'text-white') so the destructive
//     action reads as secondary visually.
//   - className passthrough on the outer wrapper merges with
//     the glass-surface base classes via cn().

// Mock framer-motion: render motion.button as plain button so
// click handlers work normally without animation overhead.
vi.mock("framer-motion", () => ({
  motion: {
    button: ({
      children,
      onClick,
      className,
      ...rest
    }: {
      children?: React.ReactNode;
      onClick?: (e: React.MouseEvent) => void;
      className?: string;
    } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button
        onClick={onClick}
        className={className}
        {...Object.fromEntries(
          Object.entries(rest).filter(([k]) => !k.startsWith("while") && !k.startsWith("animate") && !k.startsWith("initial") && !k.startsWith("exit") && !k.startsWith("transition")),
        )}
      >
        {children}
      </button>
    ),
  },
}));

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { NumericKeypad } from "./NumericKeypad";

// ───────────────────────────────────────────────────────────
//  Grid layout (4x3 = 12 buttons)
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — 4x3 grid (§15.x)", () => {
  it("renders 12 total buttons (10 digits + decimal + backspace)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(12);
  });

  it("phone-keypad order: row 1 [1,2,3], row 2 [4,5,6], row 3 [7,8,9], row 4 ['.', '0', Backspace]", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "1", "2", "3",
      "4", "5", "6",
      "7", "8", "9",
      ".", "0", "Backspace",
    ]);
  });

  it("decimal point at row-4 col-1 (LEFT of 0); backspace at row-4 col-3 (RIGHT of 0)", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    // Index 9, 10, 11 are the last row
    expect(buttons[9]!.getAttribute("aria-label")).toBe(".");
    expect(buttons[10]!.getAttribute("aria-label")).toBe("0");
    expect(buttons[11]!.getAttribute("aria-label")).toBe("Backspace");
  });
});

// ───────────────────────────────────────────────────────────
//  onKey dispatches exact string value
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — onKey dispatch (§15.x)", () => {
  it("digit click -> onKey called with that exact string", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("5"));
    expect(onKey).toHaveBeenCalledWith("5");
  });

  it("decimal point click -> onKey('.') NOT 'Decimal point' or any other label", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("."));
    expect(onKey).toHaveBeenCalledWith(".");
  });

  it("'0' click -> onKey('0') as STRING (not number)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("0"));
    expect(onKey).toHaveBeenCalledWith("0");
    expect(onKey).not.toHaveBeenCalledWith(0);
  });

  it("multiple clicks fire onKey once per click in order", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("4"));
    fireEvent.click(screen.getByLabelText("2"));
    fireEvent.click(screen.getByLabelText("."));
    fireEvent.click(screen.getByLabelText("5"));
    expect(onKey).toHaveBeenCalledTimes(4);
    expect(onKey).toHaveBeenNthCalledWith(1, "4");
    expect(onKey).toHaveBeenNthCalledWith(2, "2");
    expect(onKey).toHaveBeenNthCalledWith(3, ".");
    expect(onKey).toHaveBeenNthCalledWith(4, "5");
  });

  it("keypad does NOT enforce decimal-only-once (caller's job)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("."));
    fireEvent.click(screen.getByLabelText("."));
    // Both clicks fire — caller decides whether the second one is valid
    expect(onKey).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────────────────────────────────────
//  onBackspace dispatch + cross-leak prevention
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — onBackspace dispatch (§15.x)", () => {
  it("Backspace click -> onBackspace called once", () => {
    const onBackspace = vi.fn();
    render(<NumericKeypad onKey={vi.fn()} onBackspace={onBackspace} />);
    fireEvent.click(screen.getByLabelText("Backspace"));
    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it("Backspace click does NOT call onKey (cross-leak prevention)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Backspace"));
    expect(onKey).toHaveBeenCalledTimes(0);
  });

  it("digit click does NOT call onBackspace", () => {
    const onBackspace = vi.fn();
    render(<NumericKeypad onKey={vi.fn()} onBackspace={onBackspace} />);
    fireEvent.click(screen.getByLabelText("7"));
    fireEvent.click(screen.getByLabelText("."));
    expect(onBackspace).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Backspace visual + a11y
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — Backspace styling + a11y (§15.x)", () => {
  it("Backspace aria-label is 'Backspace' (user-facing word, NOT 'Delete')", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    expect(screen.getByLabelText("Backspace")).toBeInTheDocument();
    // Verify 'Delete' label isn't there (the local var is named 'Delete'
    // but it doesn't surface to the user)
    expect(screen.queryByLabelText("Delete")).toBeNull();
  });

  it("Backspace renders a Delete icon (svg child, NOT a text label)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const backspace = screen.getByLabelText("Backspace");
    expect(backspace.querySelector("svg")).not.toBeNull();
    expect(backspace.textContent).toBe(""); // icon-only
  });

  it("Backspace has muted text-neutral-400 styling (secondary visual weight)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const backspace = screen.getByLabelText("Backspace");
    expect(backspace.className).toContain("text-neutral-400");
  });

  it("digit buttons have 'text-white' high-contrast styling (NOT muted)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const seven = screen.getByLabelText("7");
    expect(seven.className).toContain("text-white");
    expect(seven.className).not.toContain("text-neutral-400");
  });
});

// ───────────────────────────────────────────────────────────
//  Outer container a11y
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — container a11y (§15.x)", () => {
  it("outer div has role='group' + aria-label='Numeric keypad'", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Numeric keypad" });
    expect(group).toBeInTheDocument();
  });

  it("custom className passthrough on outer wrapper", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} className="custom-cls" />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("custom-cls");
    // Base classes still present
    expect(root.className).toContain("rounded-3xl");
  });
});

// ───────────────────────────────────────────────────────────
//  Button type discipline
// ───────────────────────────────────────────────────────────

describe("NumericKeypad (mobile) — button type discipline (§15.x)", () => {
  it("ALL buttons type='button' so embedding in a <form> doesn't submit on tap", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect((btn as HTMLButtonElement).type).toBe("button");
    }
  });
});
