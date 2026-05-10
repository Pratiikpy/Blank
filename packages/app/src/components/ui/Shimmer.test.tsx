import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  Shimmer,
  ShimmerText,
  ShimmerAmount,
  ShimmerCircle,
  ShimmerActivityItem,
  ShimmerCard,
  ShimmerBalance,
} from "./Shimmer";

// §15.x test for Shimmer skeleton primitives. Used as loading
// states everywhere data is async-fetched. Accessibility
// (role=status + sr-only "Loading...") is the load-bearing part;
// without it screen-reader users have no signal that content is
// pending.

describe("Shimmer (§15.x)", () => {
  it("Shimmer base has role=status with aria-label", () => {
    const { getByRole } = render(<Shimmer />);
    const el = getByRole("status");
    expect(el.getAttribute("aria-label")).toBe("Loading");
  });

  it("Shimmer includes sr-only 'Loading...' text for screen readers", () => {
    const { getByText } = render(<Shimmer />);
    expect(getByText("Loading...")).toBeDefined();
  });

  it("Shimmer applies rounded variants", () => {
    const sm = render(<Shimmer rounded="sm" />);
    const md = render(<Shimmer rounded="md" />);
    const lg = render(<Shimmer rounded="lg" />);
    const full = render(<Shimmer rounded="full" />);

    expect((sm.container.firstChild as HTMLElement).className).toContain("rounded ");
    expect((md.container.firstChild as HTMLElement).className).toContain("rounded-lg");
    expect((lg.container.firstChild as HTMLElement).className).toContain("rounded-xl");
    expect((full.container.firstChild as HTMLElement).className).toContain("rounded-full");
  });

  it("ShimmerText renders single line by default (no children stack)", () => {
    const { container } = render(<ShimmerText />);
    // Single shimmer with role=status; no wrapping space-y-2 div.
    expect(container.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("ShimmerText with lines=3 renders 3 shimmer lines", () => {
    const { container } = render(<ShimmerText lines={3} />);
    expect(container.querySelectorAll("[role='status']")).toHaveLength(3);
  });

  it("ShimmerCircle renders with rounded-full and size class", () => {
    const md = render(<ShimmerCircle size="md" />);
    const el = md.container.firstChild as HTMLElement;
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("w-10");
    expect(el.className).toContain("h-10");
  });

  it("ShimmerCircle respects sm/md/lg sizes", () => {
    const sm = render(<ShimmerCircle size="sm" />);
    const lg = render(<ShimmerCircle size="lg" />);
    expect((sm.container.firstChild as HTMLElement).className).toContain("w-8");
    expect((lg.container.firstChild as HTMLElement).className).toContain("w-12");
  });

  it("ShimmerAmount uses font-mono for tabular alignment", () => {
    const { container } = render(<ShimmerAmount />);
    expect((container.firstChild as HTMLElement).className).toContain("font-mono");
  });

  it("ShimmerActivityItem composes circle + 4 text shimmers (matches ActivityItem)", () => {
    const { container } = render(<ShimmerActivityItem />);
    // 1 circle + 2 (left text stack) + 2 (right amount + time) = 5 role=status
    expect(container.querySelectorAll("[role='status']")).toHaveLength(5);
  });

  it("ShimmerCard composes 4 shimmer blocks (title + body + 2 buttons)", () => {
    const { container } = render(<ShimmerCard />);
    expect(container.querySelectorAll("[role='status']")).toHaveLength(4);
  });

  it("ShimmerBalance composes 2 stacked shimmers (amount + subtitle)", () => {
    const { container } = render(<ShimmerBalance />);
    expect(container.querySelectorAll("[role='status']")).toHaveLength(2);
  });
});
