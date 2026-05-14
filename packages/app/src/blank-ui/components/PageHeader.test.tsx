import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for PageHeader. The screen-level title bar used at
// the top of every secondary screen (Send / Receive / Invoice /
// Activity-detail / etc.). Optional back button (defaults to
// navigate(-1) which steps back in history), optional subtitle
// below the title, optional right-action slot for screen-
// specific buttons (e.g. share / settings). The title truncates
// when it overflows to keep the header height stable.
//
// CRITICAL pins:
//   - 4-prop API: title (required) + subtitle (optional) +
//     showBack (default true) + rightAction (optional) + onBack
//     (optional, defaults to navigate(-1)). Each prop is
//     independently optional except title.
//   - showBack default TRUE so every screen gets a back button
//     without callers having to opt in; callers must explicitly
//     pass showBack={false} on root screens where there's no
//     'back' (e.g. Dashboard).
//   - onBack prop OVERRIDES the default navigate(-1) behavior;
//     useful for screens that need confirm-before-leave logic
//     (e.g. SendConfirm prompts 'Are you sure?' before allowing
//     back) or for modal-like screens that close instead of
//     navigating.
//   - Back button has aria-label='Go back' (NOT '← Back') for
//     screen-readers; the visible content is just the
//     ChevronLeft icon.
//   - title rendered as <h1> with truncate class so long titles
//     get ellipsis instead of wrapping (header height must stay
//     stable for layout consistency across screens).
//   - subtitle rendered as <p> below title with caption styling
//     ONLY when prop is set; omitted entirely when not (no
//     empty <p> node).
//   - rightAction slot only renders when prop is provided; the
//     slot wraps the action in shrink-0 div so a flex-grow
//     title doesn't push the action out of the header.

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { PageHeader } from "./PageHeader";

function renderHeader(props: Parameters<typeof PageHeader>[0]) {
  return render(
    <MemoryRouter>
      <PageHeader {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockReset();
});

// ───────────────────────────────────────────────────────────
//  Title rendering
// ───────────────────────────────────────────────────────────

describe("PageHeader — title (§15.x)", () => {
  it("renders title as <h1>", () => {
    renderHeader({ title: "Send Payment" });
    const heading = screen.getByRole("heading", { name: "Send Payment" });
    expect(heading.tagName).toBe("H1");
  });

  it("title has 'truncate' class so long titles get ellipsis", () => {
    renderHeader({ title: "Send Payment" });
    const heading = screen.getByRole("heading", { name: "Send Payment" });
    expect(heading.className).toContain("truncate");
  });

  it("title has 'text-h2' design-token class for typography consistency", () => {
    renderHeader({ title: "Send Payment" });
    const heading = screen.getByRole("heading", { name: "Send Payment" });
    expect(heading.className).toContain("text-h2");
  });
});

// ───────────────────────────────────────────────────────────
//  Subtitle slot
// ───────────────────────────────────────────────────────────

describe("PageHeader — subtitle slot (§15.x)", () => {
  it("subtitle set -> renders as <p> with caption styling", () => {
    const { container } = renderHeader({
      title: "Send",
      subtitle: "Step 2 of 3",
    });
    const p = container.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe("Step 2 of 3");
    expect(p!.className).toContain("text-caption");
  });

  it("subtitle omitted -> NO <p> element rendered (no empty subtitle node)", () => {
    const { container } = renderHeader({ title: "Send" });
    expect(container.querySelector("p")).toBeNull();
  });

  it("subtitle empty string -> NO <p> element rendered (falsy check)", () => {
    const { container } = renderHeader({ title: "Send", subtitle: "" });
    expect(container.querySelector("p")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Back button (showBack + onBack)
// ───────────────────────────────────────────────────────────

describe("PageHeader — back button (§15.x)", () => {
  it("default showBack=true -> back button rendered with aria-label='Go back'", () => {
    renderHeader({ title: "Send" });
    expect(screen.getByLabelText("Go back")).toBeInTheDocument();
  });

  it("showBack=false -> back button NOT rendered", () => {
    renderHeader({ title: "Dashboard", showBack: false });
    expect(screen.queryByLabelText("Go back")).toBeNull();
  });

  it("default onBack handler calls navigate(-1) (step back in history)", () => {
    renderHeader({ title: "Send" });
    fireEvent.click(screen.getByLabelText("Go back"));
    expect(navigateMock).toHaveBeenCalledWith(-1);
  });

  it("custom onBack prop OVERRIDES default navigate(-1)", () => {
    const onBack = vi.fn();
    renderHeader({ title: "Send", onBack });
    fireEvent.click(screen.getByLabelText("Go back"));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(0);
  });

  it("back button has ChevronLeft icon (svg child)", () => {
    renderHeader({ title: "Send" });
    const back = screen.getByLabelText("Go back");
    expect(back.querySelector("svg")).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  rightAction slot
// ───────────────────────────────────────────────────────────

describe("PageHeader — rightAction slot (§15.x)", () => {
  it("rightAction set -> renders the node in the right slot", () => {
    renderHeader({
      title: "Activity",
      rightAction: <button data-testid="share-btn">Share</button>,
    });
    expect(screen.getByTestId("share-btn")).toBeInTheDocument();
  });

  it("rightAction omitted -> NO right-slot wrapper rendered", () => {
    const { container } = renderHeader({ title: "Activity" });
    // The .shrink-0 wrapper only renders when rightAction is provided
    expect(container.querySelector(".shrink-0")).toBeNull();
  });

  it("rightAction wrapped in shrink-0 div so flex-grow title doesn't push it out", () => {
    renderHeader({
      title: "Activity",
      rightAction: <span data-testid="action">⚙</span>,
    });
    const action = screen.getByTestId("action");
    const wrapper = action.parentElement;
    expect(wrapper?.className).toContain("shrink-0");
  });

  it("rightAction can be any ReactNode (button / icon / fragment)", () => {
    renderHeader({
      title: "Activity",
      rightAction: (
        <>
          <button data-testid="btn-1">A</button>
          <button data-testid="btn-2">B</button>
        </>
      ),
    });
    expect(screen.getByTestId("btn-1")).toBeInTheDocument();
    expect(screen.getByTestId("btn-2")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Combined / all-props interaction
// ───────────────────────────────────────────────────────────

describe("PageHeader — combined props (§15.x)", () => {
  it("all 4 optional props set -> all 4 slots render correctly", () => {
    const onBack = vi.fn();
    renderHeader({
      title: "Send Payment",
      subtitle: "Step 2 of 3",
      onBack,
      rightAction: <button data-testid="cancel">Cancel</button>,
    });
    expect(screen.getByRole("heading", { name: "Send Payment" })).toBeInTheDocument();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Go back")).toBeInTheDocument();
    expect(screen.getByTestId("cancel")).toBeInTheDocument();

    // onBack custom handler still wired
    fireEvent.click(screen.getByLabelText("Go back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("title-only minimal usage works (other props all default)", () => {
    renderHeader({ title: "Dashboard" });
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    // Back button shown by default
    expect(screen.getByLabelText("Go back")).toBeInTheDocument();
    // No subtitle, no right-action
    expect(screen.queryByText(/Step/)).toBeNull();
  });
});
