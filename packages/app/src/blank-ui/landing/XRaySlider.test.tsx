import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { XRaySlider } from "./XRaySlider";

// §15.x test for XRaySlider. The clip-path math is the load-bearing
// piece: `leftInset = max(0, pct - windowWidth/2)` and `rightInset =
// max(0, 100 - (pct + windowWidth/2))` — the Math.max clamps stop
// near-edge cursors from producing negative insets which would
// either crash clip-path or flip the window direction. Also pins
// the broken-image graceful fallback (1x1 transparent gif when src
// 404s), so the X-ray hover effect doesn't leak the browser's
// broken-image icon.

const BASE_SRC = "/img/base.png";
const REVEAL_SRC = "/img/reveal.png";

// jsdom doesn't lay out elements — getBoundingClientRect returns
// width/height = 0 by default, which breaks the clip-path math.
// Stub it to a deterministic 400×200 viewport.
beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 200,
    width: 400,
    height: 200,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

describe("XRaySlider — chrome (§15.x)", () => {
  it("renders with role='img' + aria-label describing the interaction", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="bill"
        revealSrc={REVEAL_SRC}
        revealAlt="cipher"
      />,
    );
    const slider = container.querySelector(".ll-slider");
    expect(slider?.getAttribute("role")).toBe("img");
    expect(slider?.getAttribute("aria-label")).toContain("Hover to reveal");
  });

  it("renders base + reveal images with the provided src + alt", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="bill alt"
        revealSrc={REVEAL_SRC}
        revealAlt="cipher alt"
      />,
    );
    const base = container.querySelector(".ll-slider-base") as HTMLImageElement;
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;
    expect(base.src).toContain(BASE_SRC);
    expect(base.alt).toBe("bill alt");
    expect(reveal.src).toContain(REVEAL_SRC);
    expect(reveal.alt).toBe("cipher alt");
  });

  it("both images use loading='lazy' (avoids blocking landing-page paint)", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="x"
        revealSrc={REVEAL_SRC}
        revealAlt="y"
      />,
    );
    expect(container.querySelector(".ll-slider-base")?.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector(".ll-slider-reveal")?.getAttribute("loading")).toBe("lazy");
  });

  it("renders the drag-handle column with the ↔ icon char", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const icon = container.querySelector(".ll-slider-handle-icon");
    expect(icon?.textContent).toBe("↔");
  });
});

describe("XRaySlider — hover lifecycle (§15.x)", () => {
  it("reveal image does NOT have 'visible' class before mouse enters", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const reveal = container.querySelector(".ll-slider-reveal");
    expect(reveal?.className).not.toContain("visible");
  });

  it("mouse-enter adds 'visible' class to reveal + handle-icon", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    fireEvent.mouseEnter(slider);
    expect(container.querySelector(".ll-slider-reveal")?.className).toContain("visible");
    expect(container.querySelector(".ll-slider-handle-icon")?.className).toContain("visible");
  });

  it("mouse-leave removes the 'visible' class (hides the X-ray window)", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    fireEvent.mouseEnter(slider);
    fireEvent.mouseLeave(slider);
    expect(container.querySelector(".ll-slider-reveal")?.className).not.toContain("visible");
  });
});

describe("XRaySlider — clip-path math (§15.x)", () => {
  it("centered cursor (50%) produces symmetric insets around the window center", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="x"
        revealSrc={REVEAL_SRC}
        revealAlt="y"
        windowWidthPct={20}
      />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;

    // Cursor at 200/400 = 50% — window is 20% wide → leftInset=40, rightInset=40.
    fireEvent.mouseMove(slider, { clientX: 200, clientY: 100 });
    expect(reveal.style.clipPath).toBe("inset(0% 40% 0% 40%)");
  });

  it("near-left-edge cursor clamps leftInset to 0 (no negative inset)", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="x"
        revealSrc={REVEAL_SRC}
        revealAlt="y"
        windowWidthPct={20}
      />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;

    // Cursor at 0px (left edge) → pct=0, raw leftInset would be -10 → clamped to 0.
    fireEvent.mouseMove(slider, { clientX: 0, clientY: 100 });
    // Inset format: "inset(0% R% 0% L%)" where L is clamped.
    const cp = reveal.style.clipPath;
    expect(cp).toMatch(/inset\(0% \d+% 0% 0%\)/);
  });

  it("near-right-edge cursor clamps rightInset to 0", () => {
    const { container } = render(
      <XRaySlider
        baseSrc={BASE_SRC}
        baseAlt="x"
        revealSrc={REVEAL_SRC}
        revealAlt="y"
        windowWidthPct={20}
      />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;

    fireEvent.mouseMove(slider, { clientX: 400, clientY: 100 });
    const cp = reveal.style.clipPath;
    expect(cp).toMatch(/inset\(0% 0% 0% \d+%\)/);
  });

  it("default windowWidthPct=22 when prop omitted (centered cursor → 39/39 insets)", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;

    fireEvent.mouseMove(slider, { clientX: 200, clientY: 100 });
    // 50% - 22%/2 = 39%; 100% - (50 + 11)% = 39%.
    expect(reveal.style.clipPath).toBe("inset(0% 39% 0% 39%)");
  });

  it("handle.left tracks the cursor as a % of container width", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const handle = container.querySelector(".ll-slider-handle") as HTMLElement;

    fireEvent.mouseMove(slider, { clientX: 100, clientY: 50 });
    // 100/400 = 25%.
    expect(handle.style.left).toBe("25%");
  });

  it("icon.top tracks the cursor's Y position in pixels", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const icon = container.querySelector(".ll-slider-handle-icon") as HTMLElement;

    fireEvent.mouseMove(slider, { clientX: 200, clientY: 75 });
    expect(icon.style.top).toBe("75px");
  });

  it("cursor outside the container (clientX > width) clamps to width — no overflow", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    const handle = container.querySelector(".ll-slider-handle") as HTMLElement;

    fireEvent.mouseMove(slider, { clientX: 9999, clientY: 100 });
    expect(handle.style.left).toBe("100%");
  });
});

describe("XRaySlider — touch lifecycle (§15.x mobile)", () => {
  it("touchstart sets visible + moves to touch position", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    fireEvent.touchStart(slider, { touches: [{ clientX: 100, clientY: 50 }] });
    expect(container.querySelector(".ll-slider-reveal")?.className).toContain("visible");
    const handle = container.querySelector(".ll-slider-handle") as HTMLElement;
    expect(handle.style.left).toBe("25%");
  });

  it("touchend hides the reveal (matches mouse-leave behavior)", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    fireEvent.touchStart(slider, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(slider);
    expect(container.querySelector(".ll-slider-reveal")?.className).not.toContain("visible");
  });

  it("touchmove updates clip-path + handle position", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const slider = container.querySelector(".ll-slider") as HTMLElement;
    fireEvent.touchStart(slider, { touches: [{ clientX: 0, clientY: 0 }] });
    fireEvent.touchMove(slider, { touches: [{ clientX: 300, clientY: 100 }] });
    const handle = container.querySelector(".ll-slider-handle") as HTMLElement;
    expect(handle.style.left).toBe("75%");
  });
});

describe("XRaySlider — broken-image fallback (§15.x)", () => {
  it("base image onError swaps to a 1x1 transparent gif data URI", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const base = container.querySelector(".ll-slider-base") as HTMLImageElement;
    fireEvent.error(base);
    expect(base.src).toContain("data:image/gif;base64");
  });

  it("reveal image onError ALSO swaps to the transparent gif fallback", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const reveal = container.querySelector(".ll-slider-reveal") as HTMLImageElement;
    fireEvent.error(reveal);
    expect(reveal.src).toContain("data:image/gif;base64");
  });

  it("onError handler self-clears (avoids infinite onError loop if fallback also fails)", () => {
    const { container } = render(
      <XRaySlider baseSrc={BASE_SRC} baseAlt="x" revealSrc={REVEAL_SRC} revealAlt="y" />,
    );
    const base = container.querySelector(".ll-slider-base") as HTMLImageElement;
    fireEvent.error(base);
    // Source sets `e.currentTarget.onerror = null` before swapping src.
    expect(base.onerror).toBeNull();
  });
});
