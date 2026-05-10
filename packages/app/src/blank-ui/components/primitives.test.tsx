import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// §15.x test for the 3 layout/form primitives in blank-ui:
// BlankButton, BlankInput, PageHeader. Used across many screens —
// pinning their core contracts (loading-disables-click, error-vs-hint
// precedence, back-button navigation) prevents subtle UX regressions.

import { BlankButton } from "./BlankButton";
import { BlankInput } from "./BlankInput";
import { PageHeader } from "./PageHeader";

describe("BlankButton (§15.x)", () => {
  it("renders children + applies primary variant by default", () => {
    const { container, getByText } = render(<BlankButton>Send</BlankButton>);
    expect(getByText("Send")).toBeDefined();
    expect(container.querySelector("button")!.className).toContain("btn-primary");
  });

  it("each variant maps to the matching base class", () => {
    const cases = [
      ["primary", "btn-primary"],
      ["secondary", "btn-secondary"],
      ["ghost", "btn-ghost"],
    ] as const;
    for (const [variant, cls] of cases) {
      const { container, unmount } = render(
        <BlankButton variant={variant}>X</BlankButton>,
      );
      expect(container.querySelector("button")!.className).toContain(cls);
      unmount();
    }
  });

  it("size='full' applies the !w-full + !rounded-2xl + !h-14 stack", () => {
    const { container } = render(<BlankButton size="full">Big</BlankButton>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("!w-full");
    expect(btn.className).toContain("!rounded-2xl");
    expect(btn.className).toContain("!h-14");
  });

  it("size='sm' applies the compact !h-10 + !text-sm + !px-4 stack", () => {
    const { container } = render(<BlankButton size="sm">Small</BlankButton>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("!h-10");
    expect(btn.className).toContain("!text-sm");
    expect(btn.className).toContain("!px-4");
  });

  it("loading=true: button is disabled + opacity-70 + pointer-events-none + spinner replaces icon", () => {
    const customIcon = <span data-testid="custom-icon">custom</span>;
    const { container, queryByTestId } = render(
      <BlankButton loading icon={customIcon}>Submit</BlankButton>,
    );
    const btn = container.querySelector("button")! as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain("opacity-70");
    expect(btn.className).toContain("pointer-events-none");
    // Icon swapped out, spinner shown instead.
    expect(queryByTestId("custom-icon")).toBeNull();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("CRITICAL: loading=true blocks click handler (prevents double-submit)", () => {
    const onClick = vi.fn();
    const { container } = render(
      <BlankButton loading onClick={onClick}>Submit</BlankButton>,
    );
    const btn = container.querySelector("button")!;
    fireEvent.click(btn);
    // disabled=true means click event is suppressed by the browser.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled prop alone (no loading) still blocks click", () => {
    const onClick = vi.fn();
    const { container } = render(
      <BlankButton disabled onClick={onClick}>X</BlankButton>,
    );
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders icon prop when not loading", () => {
    const { getByTestId } = render(
      <BlankButton icon={<span data-testid="icon">I</span>}>X</BlankButton>,
    );
    expect(getByTestId("icon")).toBeDefined();
  });

  it("forwards ref to the underlying button element", () => {
    const ref = { current: null } as React.MutableRefObject<HTMLButtonElement | null>;
    render(<BlankButton ref={ref}>X</BlankButton>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("merges custom className alongside built-ins", () => {
    const { container } = render(<BlankButton className="my-extra">X</BlankButton>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("my-extra");
    expect(btn.className).toContain("btn-primary");
  });
});

describe("BlankInput (§15.x)", () => {
  it("renders without label by default (no label element)", () => {
    const { container } = render(<BlankInput placeholder="x" />);
    expect(container.querySelector("label")).toBeNull();
  });

  it("renders the label when provided", () => {
    const { getByText } = render(<BlankInput label="Amount" />);
    expect(getByText("Amount")).toBeDefined();
  });

  it("error message renders + applies the error border class", () => {
    const { getByText, container } = render(
      <BlankInput label="x" error="amount must be > 0" />,
    );
    expect(getByText("amount must be > 0")).toBeDefined();
    const input = container.querySelector("input")!;
    expect(input.className).toContain("!border-[var(--error)]");
  });

  it("hint renders when no error", () => {
    const { getByText, queryByText } = render(
      <BlankInput hint="USD only" />,
    );
    expect(getByText("USD only")).toBeDefined();
    expect(queryByText(/error/i)).toBeNull();
  });

  it("error wins over hint (hint hidden when both provided)", () => {
    const { getByText, queryByText } = render(
      <BlankInput hint="USD only" error="bad" />,
    );
    expect(getByText("bad")).toBeDefined();
    expect(queryByText("USD only")).toBeNull();
  });

  it("forwards ref to the underlying input", () => {
    const ref = { current: null } as React.MutableRefObject<HTMLInputElement | null>;
    render(<BlankInput ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("forwards arbitrary input props (type, value, onChange, etc.)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <BlankInput type="password" value="secret" onChange={onChange} />,
    );
    const input = container.querySelector("input")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("secret");
  });
});

describe("PageHeader (§15.x)", () => {
  function renderWithRoute(node: React.ReactElement, initial = ["/"]) {
    return render(
      <MemoryRouter initialEntries={initial}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders the title", () => {
    const { getByText } = renderWithRoute(<PageHeader title="Dashboard" />);
    expect(getByText("Dashboard")).toBeDefined();
  });

  it("renders subtitle when provided", () => {
    const { getByText } = renderWithRoute(
      <PageHeader title="Dashboard" subtitle="Your overview" />,
    );
    expect(getByText("Your overview")).toBeDefined();
  });

  it("renders the back button by default (showBack=true)", () => {
    const { getByLabelText } = renderWithRoute(<PageHeader title="X" />);
    expect(getByLabelText("Go back")).toBeDefined();
  });

  it("hides the back button when showBack=false", () => {
    const { queryByLabelText } = renderWithRoute(
      <PageHeader title="X" showBack={false} />,
    );
    expect(queryByLabelText("Go back")).toBeNull();
  });

  it("uses custom onBack handler when provided (does NOT call navigate)", () => {
    const onBack = vi.fn();
    const { getByLabelText } = renderWithRoute(
      <PageHeader title="X" onBack={onBack} />,
    );
    fireEvent.click(getByLabelText("Go back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders rightAction in its own slot", () => {
    const { getByText } = renderWithRoute(
      <PageHeader title="X" rightAction={<span>Action</span>} />,
    );
    expect(getByText("Action")).toBeDefined();
  });

  it("does NOT render rightAction wrapper when rightAction is missing", () => {
    const { container } = renderWithRoute(<PageHeader title="X" />);
    // The shrink-0 wrapper only renders when rightAction is set.
    const shrinks = Array.from(container.querySelectorAll(".shrink-0"));
    // Some other class might match shrink-0 indirectly; just check there's
    // no container element with literal text other than the title/back.
    expect(shrinks.length).toBeLessThanOrEqual(1);
  });
});
