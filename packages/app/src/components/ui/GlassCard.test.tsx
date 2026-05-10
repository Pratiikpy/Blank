import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GlassCard } from "./GlassCard";

// §15.x test for GlassCard. The default container for every Wave 4
// surface (Dashboard panels, Settings cards, modals). Pin the
// variant class binding + the children pass-through + the noPadding
// override.

describe("GlassCard (§15.x)", () => {
  it("renders children inside the card", () => {
    const { getByText } = render(
      <GlassCard>
        <span>card-child</span>
      </GlassCard>,
    );
    expect(getByText("card-child")).toBeDefined();
  });

  it("default variant applies the default class set", () => {
    const { container } = render(
      <GlassCard>
        <span>x</span>
      </GlassCard>,
    );
    const el = container.firstChild as HTMLElement;
    // default uses backdrop-blur-2xl + border-white/[0.06].
    expect(el.className).toContain("backdrop-blur-2xl");
    expect(el.className).toContain("rounded-2xl");
  });

  it("interactive variant adds cursor-pointer", () => {
    const { container } = render(
      <GlassCard variant="interactive">
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "cursor-pointer",
    );
  });

  it("elevated variant uses backdrop-blur-3xl (heaviest blur)", () => {
    const { container } = render(
      <GlassCard variant="elevated">
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "backdrop-blur-3xl",
    );
  });

  it("outlined variant uses transparent bg", () => {
    const { container } = render(
      <GlassCard variant="outlined">
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "bg-transparent",
    );
  });

  it("heavy variant uses opaque (#060608/85) bg", () => {
    const { container } = render(
      <GlassCard variant="heavy">
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "bg-[#060608]/85",
    );
  });

  it("default applies p-5 sm:p-6 padding", () => {
    const { container } = render(
      <GlassCard>
        <span>x</span>
      </GlassCard>,
    );
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain("p-5");
  });

  it("noPadding=true removes the default padding classes", () => {
    const { container } = render(
      <GlassCard noPadding>
        <span>x</span>
      </GlassCard>,
    );
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).not.toContain("p-5");
    expect(cls).not.toContain("p-6");
  });

  it("highlight=true adds glass-highlight class", () => {
    const { container } = render(
      <GlassCard highlight>
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "glass-highlight",
    );
  });

  it("custom className is merged onto the element", () => {
    const { container } = render(
      <GlassCard className="custom-marker">
        <span>x</span>
      </GlassCard>,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-marker",
    );
  });
});
