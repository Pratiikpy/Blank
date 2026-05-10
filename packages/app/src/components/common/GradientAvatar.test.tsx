import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GradientAvatar } from "./GradientAvatar";

// §15.x test for GradientAvatar — the placeholder rendered everywhere
// a user has no profile image. Rendered hundreds of times per session
// (every contact row, every history row); deterministic gradient per
// address means re-renders don't flicker.

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("GradientAvatar (§15.x)", () => {
  it("renders deterministically: same address → same gradient on re-mount", () => {
    const a = render(<GradientAvatar address={ALICE} />);
    const styleA = a.container.firstChild as HTMLElement;
    const grad1 = styleA.style.background;
    a.unmount();

    const b = render(<GradientAvatar address={ALICE} />);
    const styleB = b.container.firstChild as HTMLElement;
    expect(styleB.style.background).toBe(grad1);
  });

  it("renders different gradient for different addresses", () => {
    const a = render(<GradientAvatar address={ALICE} />);
    const b = render(<GradientAvatar address={BOB} />);
    const gradA = (a.container.firstChild as HTMLElement).style.background;
    const gradB = (b.container.firstChild as HTMLElement).style.background;
    expect(gradA).not.toBe(gradB);
  });

  it("uses the first letter of name when provided", () => {
    const { container } = render(
      <GradientAvatar address={ALICE} name="Alice" />,
    );
    expect(container.textContent).toBe("A");
  });

  it("uppercases the name initial", () => {
    const { container } = render(
      <GradientAvatar address={ALICE} name="alice" />,
    );
    expect(container.textContent).toBe("A");
  });

  it("falls back to first 2 hex chars when no name", () => {
    const { container } = render(<GradientAvatar address={ALICE} />);
    // 0xAaaa... → "AA" (uppercased first 2 hex after 0x)
    expect(container.textContent).toBe("AA");
  });

  it("falls back to hex when name is empty / whitespace-only", () => {
    const { container } = render(
      <GradientAvatar address={ALICE} name="  " />,
    );
    expect(container.textContent).toBe("AA");
  });

  it("applies size class for sm/md/lg variants", () => {
    const sm = render(<GradientAvatar address={ALICE} size="sm" />);
    const md = render(<GradientAvatar address={ALICE} size="md" />);
    const lg = render(<GradientAvatar address={ALICE} size="lg" />);

    expect((sm.container.firstChild as HTMLElement).className).toContain("w-8");
    expect((md.container.firstChild as HTMLElement).className).toContain("w-10");
    expect((lg.container.firstChild as HTMLElement).className).toContain("w-16");
  });

  it("defaults to size=md", () => {
    const { container } = render(<GradientAvatar address={ALICE} />);
    expect((container.firstChild as HTMLElement).className).toContain("w-10");
  });

  it("aria-hidden so screen readers skip the decorative avatar", () => {
    const { container } = render(<GradientAvatar address={ALICE} />);
    expect((container.firstChild as HTMLElement).getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
