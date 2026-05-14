import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for BottomSheet. Mobile bottom-sheet primitive
// used across SendAmount keypad / payment confirms / mobile
// modals. Supports: 2 snap points (half + full dvh), swipe-down-
// to-dismiss with offset + velocity thresholds, ESC to close,
// backdrop tap to close, body scroll lock while open, drag-
// handle visual affordance, optional title, focus restoration
// to the sheet on open.
//
// CRITICAL pins:
//   - isOpen=false -> renders null (AnimatePresence wraps the
//     conditional); test pins via queryByRole('dialog') === null.
//   - isOpen=true -> renders dialog with role='dialog' + aria-
//     modal='true' + backdrop with aria-label='Close bottom
//     sheet'.
//   - Body scroll lock: opening sets document.body.style.
//     overflow='hidden'; closing restores the previous value
//     (NOT just '' or 'auto' — the PREVIOUS value to be polite
//     to other code that set it). Test pins by setting a
//     non-default value before mount, opening, asserting
//     hidden, then closing and asserting restoration.
//   - ESC key listener attached only when isOpen=true; cleanup
//     on close + unmount.
//   - Backdrop click calls onClose.
//   - Drag-end dismiss threshold: offset.y > 100 px OR
//     velocity.y > 500 px/s; below both -> snaps back (no
//     dismiss). The OR is important: a fast flick with low
//     offset still dismisses; a slow drag with high offset
//     also dismisses. Either signal alone is sufficient.
//   - Snap-points: default ['half', 'full']; height comes from
//     the FIRST snap point so passing snapPoints={['full']}
//     opens at full height directly.
//   - Drag handle div is aria-hidden='true' (purely decorative,
//     not an interactive affordance for screen readers).
//   - Title slot optional: renders <h2 className='text-
//     heading-3'> when provided; omitted entirely when not
//     (no empty title node).

// Mock framer-motion to render simpler stand-ins so we can
// drive the drag handler manually + skip animation states.
vi.mock("framer-motion", () => {
  const noop = (..._args: unknown[]) => 0;
  return {
    motion: {
      div: ({
        children,
        onClick,
        onDragEnd,
        style,
        className,
        ...rest
      }: {
        children?: React.ReactNode;
        onClick?: (e: React.MouseEvent) => void;
        onDragEnd?: (e: unknown, info: { offset: { y: number }; velocity: { y: number } }) => void;
        style?: React.CSSProperties;
        className?: string;
      }) => (
        <div
          onClick={onClick}
          style={style}
          className={className}
          data-on-drag-end={onDragEnd ? "true" : undefined}
          // Expose the drag handler via a data attribute + a global
          // setter so tests can invoke it.
          ref={(el) => {
            if (el && onDragEnd) {
              (el as unknown as { __onDragEnd: typeof onDragEnd }).__onDragEnd = onDragEnd;
            }
          }}
          {...Object.fromEntries(
            Object.entries(rest).filter(([k]) => !k.startsWith("drag") && !k.startsWith("initial") && !k.startsWith("animate") && !k.startsWith("exit") && !k.startsWith("transition") && !k.startsWith("onAnimation")),
          )}
        >
          {children}
        </div>
      ),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useMotionValue: () => ({ get: () => 0, set: () => {} }),
    useTransform: () => noop,
    useAnimation: () => ({ start: vi.fn() }),
  };
});

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { BottomSheet } from "./BottomSheet";

beforeEach(() => {
  // Reset body overflow so cross-test leaks don't bias assertions
  document.body.style.overflow = "";
});

// ───────────────────────────────────────────────────────────
//  open / closed rendering
// ───────────────────────────────────────────────────────────

describe("BottomSheet — open / closed (§15.x)", () => {
  it("isOpen=false -> renders null", () => {
    render(
      <BottomSheet isOpen={false} onClose={vi.fn()}>
        <div data-testid="content">hi</div>
      </BottomSheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("isOpen=true -> renders dialog with role + aria-modal", () => {
    render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        <div data-testid="content">hi</div>
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("backdrop has aria-label='Close bottom sheet'", () => {
    render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(screen.getByLabelText("Close bottom sheet")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Title slot
// ───────────────────────────────────────────────────────────

describe("BottomSheet — title slot (§15.x)", () => {
  it("title prop set -> renders <h2> with the title text", () => {
    render(
      <BottomSheet isOpen={true} onClose={vi.fn()} title="Send Payment">
        children
      </BottomSheet>,
    );
    const heading = screen.getByRole("heading", { name: "Send Payment" });
    expect(heading.tagName).toBe("H2");
    expect(heading.className).toContain("text-heading-3");
  });

  it("title omitted -> NO <h2> rendered", () => {
    const { container } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(container.querySelector("h2")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Body scroll lock
// ───────────────────────────────────────────────────────────

describe("BottomSheet — body scroll lock (§15.x)", () => {
  it("opening -> document.body.style.overflow = 'hidden'", () => {
    expect(document.body.style.overflow).toBe("");
    render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closing -> restores PREVIOUS overflow value (NOT '')", () => {
    // Set a non-default value before mount
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    // Now close
    rerender(
      <BottomSheet isOpen={false} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("isOpen=false from the start -> body overflow untouched", () => {
    document.body.style.overflow = "auto";
    render(
      <BottomSheet isOpen={false} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("auto");
  });
});

// ───────────────────────────────────────────────────────────
//  Close paths
// ───────────────────────────────────────────────────────────

describe("BottomSheet — close paths (§15.x)", () => {
  it("Escape key -> onClose called", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("non-Escape keys -> onClose NOT called", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("backdrop click -> onClose called", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    fireEvent.click(screen.getByLabelText("Close bottom sheet"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("isOpen=false -> Escape listener NOT attached (no onClose fire)", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={false} onClose={onClose}>
        children
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Drag-end dismiss thresholds
// ───────────────────────────────────────────────────────────

describe("BottomSheet — drag-end dismiss thresholds (§15.x)", () => {
  function getDragHandler(): (e: unknown, info: { offset: { y: number }; velocity: { y: number } }) => void {
    // Find the sheet motion.div by looking for the element with the
    // exposed __onDragEnd handler. The framer-motion mock saves it
    // on the DOM node ref so tests can invoke it directly.
    const allEls = document.querySelectorAll("*");
    for (const el of Array.from(allEls)) {
      if ((el as unknown as { __onDragEnd?: unknown }).__onDragEnd) {
        return (el as unknown as {
          __onDragEnd: (e: unknown, info: { offset: { y: number }; velocity: { y: number } }) => void;
        }).__onDragEnd;
      }
    }
    throw new Error("No drag handler found on any rendered element");
  }

  it("offset.y > 100 (slow drag past threshold) -> dismiss (onClose called)", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    const handler = getDragHandler();
    handler({}, { offset: { y: 150 }, velocity: { y: 100 } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("velocity.y > 500 (fast flick) with low offset -> dismiss", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    const handler = getDragHandler();
    handler({}, { offset: { y: 20 }, velocity: { y: 600 } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offset.y exactly 100 AND velocity.y exactly 500 (boundary) -> snap back (NOT dismiss)", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    const handler = getDragHandler();
    handler({}, { offset: { y: 100 }, velocity: { y: 500 } });
    // Strict > thresholds (not >=), so boundary case stays open
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("offset.y=50 + velocity.y=200 (both below) -> snap back, no dismiss", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    const handler = getDragHandler();
    handler({}, { offset: { y: 50 }, velocity: { y: 200 } });
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("OR semantics: high offset (200) with negative velocity (user dragging UP at end) -> still dismiss", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} onClose={onClose}>
        children
      </BottomSheet>,
    );
    const handler = getDragHandler();
    handler({}, { offset: { y: 200 }, velocity: { y: -100 } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Snap-points height selection
// ───────────────────────────────────────────────────────────

describe("BottomSheet — snap-points (§15.x)", () => {
  it("default snapPoints=['half', 'full'] -> first ('half') drives initial height", () => {
    const { container } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    // The motion.div sheet has the height set via style; check that
    // SOME inner element has '50dvh' in its style attribute.
    const html = container.innerHTML;
    expect(html).toContain("50dvh");
  });

  it("snapPoints=['full'] -> uses 'calc(100dvh - 40px)' height", () => {
    const { container } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()} snapPoints={["full"]}>
        children
      </BottomSheet>,
    );
    const html = container.innerHTML;
    expect(html).toContain("calc(100dvh - 40px)");
  });

  it("empty snapPoints array -> falls back to 'half' (50dvh)", () => {
    const { container } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()} snapPoints={[]}>
        children
      </BottomSheet>,
    );
    expect(container.innerHTML).toContain("50dvh");
  });
});

// ───────────────────────────────────────────────────────────
//  Drag handle accessibility
// ───────────────────────────────────────────────────────────

describe("BottomSheet — drag handle a11y (§15.x)", () => {
  it("drag-handle pill is aria-hidden='true' (decorative only)", () => {
    const { container } = render(
      <BottomSheet isOpen={true} onClose={vi.fn()}>
        children
      </BottomSheet>,
    );
    // The drag handle is the small w-8 h-1 pill at the top of the sheet
    const ariaHidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(ariaHidden.length).toBeGreaterThan(0);
  });
});
