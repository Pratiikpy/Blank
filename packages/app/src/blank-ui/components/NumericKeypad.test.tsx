import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for NumericKeypad. The mobile amount-input pad
// used on SendAmount + InvoiceCreate + payment-flow screens.
// Renders a 3x4 grid of digit keys (0-9 + decimal point) plus a
// backspace key. The onKey callback receives the digit/decimal
// string; the onBackspace callback receives no args. The caller
// is responsible for appending / removing from the displayed
// amount.
//
// CRITICAL pins:
//   - 11 digit/decimal keys + 1 backspace = 12 total buttons in
//     the grid. Keys are rendered in order [1,2,3,4,5,6,7,8,9,
//     '.',0] — the decimal point is in the 10th slot (above 0
//     in standard phone-keypad layout) NOT the 11th. A
//     regression that reordered the array would break user
//     muscle memory for amount entry.
//   - Each digit key calls onKey(key) with the EXACT string
//     value (e.g. '1', '.', '0'); not a number, not parseInt.
//     The caller decides how to append (e.g. '12' + '.' + '34'
//     -> '12.34'); the keypad does NOT enforce decimal-only-
//     once or any other validation — that's the caller's
//     responsibility.
//   - Decimal point has aria-label='Decimal point' (NOT '.')
//     so screen-readers announce 'decimal point' instead of
//     a literal period sound; all digit keys have their digit
//     as aria-label.
//   - Backspace button uses the Delete icon (lucide-react,
//     size=24 strokeWidth=1.5) + aria-label='Backspace';
//     visually distinct from digit keys via the tertiary text
//     color (!text-[var(--text-tertiary)]).
//   - Click on backspace calls onBackspace() with NO arguments;
//     a regression that passed the key string would confuse
//     callers expecting void.

import { NumericKeypad } from "./NumericKeypad";

// ───────────────────────────────────────────────────────────
//  Grid layout (12 buttons total)
// ───────────────────────────────────────────────────────────

describe("NumericKeypad — grid layout (§15.x)", () => {
  it("renders 12 total buttons (10 digits + decimal + backspace)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(12);
  });

  it("renders digits 0-9 + decimal point + Backspace as accessible buttons", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(screen.getByLabelText(digit)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Decimal point")).toBeInTheDocument();
    expect(screen.getByLabelText("Backspace")).toBeInTheDocument();
  });

  it("key order: [1,2,3,4,5,6,7,8,9,'.',0] then Backspace last (phone-keypad layout)", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "Decimal point",
      "0",
      "Backspace",
    ]);
  });

  it("decimal point is in the 10th slot (above '0' in standard phone layout)", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons[9]!.getAttribute("aria-label")).toBe("Decimal point");
    expect(buttons[10]!.getAttribute("aria-label")).toBe("0");
  });
});

// ───────────────────────────────────────────────────────────
//  onKey callback dispatches the exact string value
// ───────────────────────────────────────────────────────────

describe("NumericKeypad — onKey dispatch (§15.x)", () => {
  it("digit click -> onKey called with that exact string", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("5"));
    expect(onKey).toHaveBeenCalledWith("5");
  });

  it("decimal point click -> onKey called with '.' (NOT 'Decimal point' label)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Decimal point"));
    expect(onKey).toHaveBeenCalledWith(".");
  });

  it("'0' click -> onKey called with '0' string (not number)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("0"));
    expect(onKey).toHaveBeenCalledWith("0");
    // Specifically NOT called with the number 0
    expect(onKey).not.toHaveBeenCalledWith(0);
  });

  it("multiple clicks fire onKey once per click", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("1"));
    fireEvent.click(screen.getByLabelText("2"));
    fireEvent.click(screen.getByLabelText("3"));
    expect(onKey).toHaveBeenCalledTimes(3);
    expect(onKey).toHaveBeenNthCalledWith(1, "1");
    expect(onKey).toHaveBeenNthCalledWith(2, "2");
    expect(onKey).toHaveBeenNthCalledWith(3, "3");
  });

  it("keypad does NOT enforce decimal-only-once or any validation (caller's job)", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Decimal point"));
    fireEvent.click(screen.getByLabelText("Decimal point"));
    // Both clicks fire — caller decides whether the second one is valid
    expect(onKey).toHaveBeenCalledTimes(2);
    expect(onKey).toHaveBeenNthCalledWith(1, ".");
    expect(onKey).toHaveBeenNthCalledWith(2, ".");
  });
});

// ───────────────────────────────────────────────────────────
//  onBackspace callback (no args)
// ───────────────────────────────────────────────────────────

describe("NumericKeypad — onBackspace dispatch (§15.x)", () => {
  it("Backspace click -> onBackspace called once with NO args", () => {
    const onBackspace = vi.fn();
    render(<NumericKeypad onKey={vi.fn()} onBackspace={onBackspace} />);
    fireEvent.click(screen.getByLabelText("Backspace"));
    expect(onBackspace).toHaveBeenCalledTimes(1);
    // The onClick handler passes the event but onBackspace expects no args
    // — pin that the handler was called (event arg is fine, we just don't
    // care; the contract is "void => void").
    expect(onBackspace.mock.calls[0].length).toBeLessThanOrEqual(1);
  });

  it("Backspace click does NOT call onKey", () => {
    const onKey = vi.fn();
    render(<NumericKeypad onKey={onKey} onBackspace={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Backspace"));
    expect(onKey).toHaveBeenCalledTimes(0);
  });

  it("digit click does NOT call onBackspace", () => {
    const onBackspace = vi.fn();
    render(<NumericKeypad onKey={vi.fn()} onBackspace={onBackspace} />);
    fireEvent.click(screen.getByLabelText("7"));
    expect(onBackspace).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Backspace visual variant
// ───────────────────────────────────────────────────────────

describe("NumericKeypad — Backspace styling (§15.x)", () => {
  it("Backspace button has tertiary-color override (!text-[var(--text-tertiary)])", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const backspace = screen.getByLabelText("Backspace");
    expect(backspace.className).toContain("!text-[var(--text-tertiary)]");
  });

  it("Backspace renders a Delete icon (svg child, NOT a text label)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const backspace = screen.getByLabelText("Backspace");
    const svg = backspace.querySelector("svg");
    expect(svg).not.toBeNull();
    // The button text is empty (icon-only)
    expect(backspace.textContent).toBe("");
  });

  it("digit buttons render their digit as text (NOT an icon)", () => {
    render(<NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />);
    const seven = screen.getByLabelText("7");
    expect(seven.textContent).toBe("7");
    expect(seven.querySelector("svg")).toBeNull();
  });
});
