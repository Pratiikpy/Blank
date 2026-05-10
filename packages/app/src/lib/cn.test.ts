import { describe, it, expect } from "vitest";
import { cn } from "./cn";

// §15.x test for cn. It's the smallest util but every component uses
// it. The reason it exists over plain clsx: twMerge resolves Tailwind
// class conflicts so `cn("p-4", "p-8")` returns "p-8" (later wins) not
// "p-4 p-8" (both render, the later overrides via CSS specificity).
// The bug surface is silent — without twMerge the component still
// "works", but conditional + base-style stacks get unpredictable.

describe("cn (§15.x)", () => {
  it("joins literal class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("filters out falsy values", () => {
    expect(cn("foo", null, undefined, false, "", "bar")).toBe("foo bar");
  });

  it("supports clsx object syntax (truthy keys win)", () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe("foo baz");
  });

  it("flattens nested arrays", () => {
    expect(cn(["foo", ["bar", "baz"]], "qux")).toBe("foo bar baz qux");
  });

  it("returns empty string for no args", () => {
    expect(cn()).toBe("");
  });

  it("returns empty string when ALL args are falsy", () => {
    expect(cn(null, undefined, false, "")).toBe("");
  });

  it("twMerge: later padding class wins over earlier (p-4 + p-8 → p-8)", () => {
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  it("twMerge: keeps non-conflicting classes from both args", () => {
    expect(cn("p-4 text-red-500", "rounded-lg")).toBe("p-4 text-red-500 rounded-lg");
  });

  it("twMerge resolves conditional override (base + variant)", () => {
    const isActive = true;
    expect(cn("text-neutral-500", isActive && "text-accent")).toBe("text-accent");
  });

  it("twMerge keeps DIFFERENT-axis utilities (px-4 + py-2 don't conflict)", () => {
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("preserves arbitrary class names that aren't tailwind utilities", () => {
    expect(cn("custom-cls", "another-thing")).toBe("custom-cls another-thing");
  });

  it("merges complex real-world className composition (component-style)", () => {
    const variant = "secondary";
    const disabled = false;
    const className = "custom";
    const out = cn(
      "inline-flex items-center px-4 py-2 rounded-md",
      variant === "secondary" && "bg-white/5 text-white",
      disabled && "opacity-50 pointer-events-none",
      className,
    );
    expect(out).toContain("inline-flex");
    expect(out).toContain("bg-white/5");
    expect(out).toContain("custom");
    expect(out).not.toContain("opacity-50");
  });
});
