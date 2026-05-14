import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// §15.x test for BlankButton. Design-system primitive used across
// the entire app (every CTA in every screen). Wraps native button
// with: 3 variants (primary / secondary / ghost), 4 sizes (sm /
// md / lg / full), loading state with built-in spinner, optional
// leading icon, ref forwarding for parent-controlled focus.
// Because it's load-bearing for every CTA, a regression that
// dropped the disabled-during-loading guard would let users
// double-click submit and fire two writes.
//
// CRITICAL pins:
//   - 3 variant classes: 'primary' -> 'btn-primary' (default if
//     not specified); 'secondary' -> 'btn-secondary'; 'ghost' ->
//     'btn-ghost'; the variant maps to a class name (NOT inline
//     styles) so design tokens stay in CSS.
//   - 4 size modifiers: 'sm' (!h-10 !text-sm !px-4); 'lg' (!h-14
//     !rounded-2xl !text-base); 'full' (!w-full !rounded-2xl
//     !h-14 !text-base); 'md' = no modifier (default, falls
//     through to btn-{variant}'s base styling).
//   - loading=true -> spinner replaces icon + opacity-70 +
//     pointer-events-none classes + button.disabled=true even
//     when the disabled prop is false; the prop OR loading guard
//     prevents accidental double-submit during in-flight writes.
//   - children render AFTER icon/spinner so the text label is
//     after the leading visual; loading=true doesn't replace
//     children (still rendered), only swaps the icon slot for
//     the spinner.
//   - icon prop rendered ONLY when loading=false (loading wins);
//     when both loading=true AND icon is provided, the icon is
//     hidden by the spinner.
//   - disabled propagates to button.disabled; loading also
//     forces disabled even when disabled=false; the combined
//     guard is `disabled || loading` so either flag is sufficient.
//   - className passthrough via cn() so callers can override or
//     extend styles; cn() merges base + size + loading +
//     className in that order so user-className wins last.
//   - forwardRef: ref points at the native <button> element so
//     parent can call .focus() / .click() / .blur() (e.g. for
//     auto-focus on modal open).
//   - rest props spread onto button: onClick / type / aria-* /
//     data-testid all pass through; type defaults to button's
//     native default which is 'submit' — caller should pass
//     type='button' explicitly when not in a form context to
//     avoid accidental form submit.
//   - displayName='BlankButton' for React DevTools (forwardRef
//     normally shows 'ForwardRef' without it).

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { BlankButton } from "./BlankButton";

// ───────────────────────────────────────────────────────────
//  Variant classes (3)
// ───────────────────────────────────────────────────────────

describe("BlankButton — variants (§15.x)", () => {
  it("default variant -> 'btn-primary'", () => {
    render(<BlankButton>Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-primary");
  });

  it("variant='secondary' -> 'btn-secondary'", () => {
    render(<BlankButton variant="secondary">Cancel</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-secondary");
    expect(btn.className).not.toContain("btn-primary");
  });

  it("variant='ghost' -> 'btn-ghost'", () => {
    render(<BlankButton variant="ghost">Skip</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-ghost");
  });
});

// ───────────────────────────────────────────────────────────
//  Size modifiers (4)
// ───────────────────────────────────────────────────────────

describe("BlankButton — sizes (§15.x)", () => {
  it("default size='md' -> NO size modifier (falls through to btn-* base)", () => {
    render(<BlankButton>Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).not.toContain("!h-14");
    expect(btn.className).not.toContain("!h-10");
    expect(btn.className).not.toContain("!w-full");
  });

  it("size='sm' -> '!h-10 !text-sm !px-4'", () => {
    render(<BlankButton size="sm">Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("!h-10");
    expect(btn.className).toContain("!text-sm");
    expect(btn.className).toContain("!px-4");
  });

  it("size='lg' -> '!h-14 !rounded-2xl !text-base'", () => {
    render(<BlankButton size="lg">Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("!h-14");
    expect(btn.className).toContain("!rounded-2xl");
    expect(btn.className).toContain("!text-base");
  });

  it("size='full' -> '!w-full !rounded-2xl !h-14 !text-base'", () => {
    render(<BlankButton size="full">Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("!w-full");
    expect(btn.className).toContain("!h-14");
    expect(btn.className).toContain("!rounded-2xl");
    expect(btn.className).toContain("!text-base");
  });
});

// ───────────────────────────────────────────────────────────
//  Loading state
// ───────────────────────────────────────────────────────────

describe("BlankButton — loading state (§15.x)", () => {
  it("loading=false -> NO spinner, NO opacity-70, NO pointer-events-none", () => {
    render(<BlankButton>Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).not.toContain("opacity-70");
    expect(btn.className).not.toContain("pointer-events-none");
    // No spinner span
    expect(btn.querySelector(".animate-spin")).toBeNull();
  });

  it("loading=true -> spinner renders + opacity-70 + pointer-events-none", () => {
    render(<BlankButton loading>Save</BlankButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("opacity-70");
    expect(btn.className).toContain("pointer-events-none");
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
  });

  it("loading=true forces button.disabled=true (even when disabled prop is false)", () => {
    render(<BlankButton loading>Save</BlankButton>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disabled=true + loading=false -> button.disabled=true (prop alone is enough)", () => {
    render(<BlankButton disabled>Save</BlankButton>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("children still render during loading (text label NOT hidden by spinner)", () => {
    render(<BlankButton loading>Save</BlankButton>);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("loading=true + icon prop -> spinner replaces icon (icon NOT rendered)", () => {
    render(
      <BlankButton
        loading
        icon={<span data-testid="leading-icon">★</span>}
      >
        Save
      </BlankButton>,
    );
    expect(screen.queryByTestId("leading-icon")).toBeNull();
    expect(screen.getByRole("button").querySelector(".animate-spin")).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Icon slot
// ───────────────────────────────────────────────────────────

describe("BlankButton — icon prop (§15.x)", () => {
  it("icon prop renders BEFORE children", () => {
    render(
      <BlankButton icon={<span data-testid="leading-icon">★</span>}>
        Save
      </BlankButton>,
    );
    const btn = screen.getByRole("button");
    expect(screen.getByTestId("leading-icon")).toBeInTheDocument();
    // Verify order: icon comes before "Save" text in the DOM
    const iconEl = screen.getByTestId("leading-icon");
    const saveText = btn.lastChild;
    expect(saveText?.textContent).toBe("Save");
    expect(iconEl.compareDocumentPosition(saveText as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("icon prop omitted -> renders nothing in the icon slot (NOT a placeholder)", () => {
    render(<BlankButton>Save</BlankButton>);
    const btn = screen.getByRole("button");
    // Only the text node "Save" should be in the button
    expect(btn.children.length).toBe(0); // no element children
    expect(btn.textContent).toBe("Save");
  });
});

// ───────────────────────────────────────────────────────────
//  Ref forwarding
// ───────────────────────────────────────────────────────────

describe("BlankButton — ref forwarding (§15.x)", () => {
  it("ref points at the native HTMLButtonElement", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<BlankButton ref={ref}>Save</BlankButton>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("ref.current.focus() works (parent-controlled focus)", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<BlankButton ref={ref}>Save</BlankButton>);
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("displayName='BlankButton' for React DevTools", () => {
    expect(BlankButton.displayName).toBe("BlankButton");
  });
});

// ───────────────────────────────────────────────────────────
//  Prop passthrough (onClick / type / aria-* / data-*)
// ───────────────────────────────────────────────────────────

describe("BlankButton — prop passthrough (§15.x)", () => {
  it("onClick fires when clicked", () => {
    const onClick = vi.fn();
    render(<BlankButton onClick={onClick}>Save</BlankButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("onClick does NOT fire when disabled", () => {
    const onClick = vi.fn();
    render(
      <BlankButton onClick={onClick} disabled>
        Save
      </BlankButton>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(0);
  });

  it("onClick does NOT fire during loading (pointer-events-none + disabled)", () => {
    const onClick = vi.fn();
    render(
      <BlankButton onClick={onClick} loading>
        Save
      </BlankButton>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(0);
  });

  it("type='button' passthrough", () => {
    render(<BlankButton type="button">Save</BlankButton>);
    expect((screen.getByRole("button") as HTMLButtonElement).type).toBe("button");
  });

  it("type='submit' passthrough", () => {
    render(<BlankButton type="submit">Save</BlankButton>);
    expect((screen.getByRole("button") as HTMLButtonElement).type).toBe("submit");
  });

  it("aria-label passthrough", () => {
    render(<BlankButton aria-label="Save changes">Save</BlankButton>);
    expect(
      screen.getByRole("button").getAttribute("aria-label"),
    ).toBe("Save changes");
  });

  it("data-testid passthrough", () => {
    render(<BlankButton data-testid="save-btn">Save</BlankButton>);
    expect(screen.getByTestId("save-btn")).toBeInTheDocument();
  });

  it("custom className merges with base + size + loading classes (last wins via cn)", () => {
    render(
      <BlankButton variant="primary" size="sm" className="custom-extra">
        Save
      </BlankButton>,
    );
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("btn-primary");
    expect(btn.className).toContain("!h-10");
    expect(btn.className).toContain("custom-extra");
  });
});
