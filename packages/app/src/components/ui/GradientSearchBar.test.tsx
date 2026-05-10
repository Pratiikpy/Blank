import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { GradientSearchBar } from "./GradientSearchBar";

// §15.x test for GradientSearchBar. The global search affordance.
// Pin the controlled-input contract + Enter-to-submit + the
// keyboard-hint badge.

describe("GradientSearchBar (§15.x)", () => {
  it("renders the input with the given value", () => {
    const { container } = render(
      <GradientSearchBar value="tx 0xabc" onChange={() => {}} />,
    );
    const input = container.querySelector("input")!;
    expect(input.value).toBe("tx 0xabc");
  });

  it("uses the default placeholder when none provided", () => {
    const { container } = render(
      <GradientSearchBar value="" onChange={() => {}} />,
    );
    const input = container.querySelector("input")!;
    expect(input.placeholder).toMatch(/search/i);
  });

  it("respects a custom placeholder", () => {
    const { container } = render(
      <GradientSearchBar
        value=""
        onChange={() => {}}
        placeholder="Find a contact"
      />,
    );
    const input = container.querySelector("input")!;
    expect(input.placeholder).toBe("Find a contact");
  });

  it("calls onChange with the new value on typing", () => {
    const onChange = vi.fn();
    const { container } = render(
      <GradientSearchBar value="" onChange={onChange} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "alice.eth" } });
    expect(onChange).toHaveBeenCalledWith("alice.eth");
  });

  it("calls onSubmit with the current value when Enter is pressed", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <GradientSearchBar
        value="alice.eth"
        onChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("alice.eth");
  });

  it("Enter does NOT crash when onSubmit is not provided", () => {
    const { container } = render(
      <GradientSearchBar value="x" onChange={() => {}} />,
    );
    const input = container.querySelector("input")!;
    expect(() => fireEvent.keyDown(input, { key: "Enter" })).not.toThrow();
  });

  it("non-Enter keys do NOT trigger onSubmit", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <GradientSearchBar value="x" onChange={() => {}} onSubmit={onSubmit} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the shortcut hint inside a <kbd> when provided", () => {
    const { container, getByText } = render(
      <GradientSearchBar
        value=""
        onChange={() => {}}
        shortcutHint="⌘K"
      />,
    );
    expect(getByText("⌘K")).toBeDefined();
    // Specifically inside a <kbd> element.
    const kbd = container.querySelector("kbd")!;
    expect(kbd).not.toBeNull();
    expect(kbd.textContent).toBe("⌘K");
  });

  it("does NOT render <kbd> when no shortcutHint", () => {
    const { container } = render(
      <GradientSearchBar value="" onChange={() => {}} />,
    );
    expect(container.querySelector("kbd")).toBeNull();
  });

  it("disabled=true sets the input's disabled attribute", () => {
    const { container } = render(
      <GradientSearchBar value="" onChange={() => {}} disabled />,
    );
    const input = container.querySelector("input")!;
    expect(input.disabled).toBe(true);
  });

  it("aria-label mirrors the placeholder for screen readers", () => {
    const { container } = render(
      <GradientSearchBar
        value=""
        onChange={() => {}}
        placeholder="Find addresses"
      />,
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-label")).toBe("Find addresses");
  });
});
