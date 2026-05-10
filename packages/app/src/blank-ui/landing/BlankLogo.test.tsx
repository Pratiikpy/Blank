import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BlankLogo } from "./BlankLogo";

// §15.x test for BlankLogo. Pins the 4 variants (wordmark / mark /
// lockup / contained), the accessibility wiring per variant
// (role="img" only for SVG-only variants, bare text wordmark for
// scalability), and the size/wordmarkSize prop forwarding.

describe("BlankLogo (§15.x)", () => {
  it("default variant 'wordmark' renders 'blank.' as text (not SVG)", () => {
    const { container } = render(<BlankLogo />);
    expect(container.textContent).toBe("blank.");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("variant='mark' renders only the SVG glyph (no text)", () => {
    const { container } = render(<BlankLogo variant="mark" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("variant='contained' renders the SVG with rounded square background", () => {
    const { container } = render(<BlankLogo variant="contained" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // Contained variant has a background rect (the rounded black square).
    const rect = svg!.querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("#0A0A0A");
  });

  it("variant='lockup' renders BOTH the SVG mark AND the wordmark text", () => {
    const { container } = render(<BlankLogo variant="lockup" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain("blank.");
  });

  it("size prop controls the SVG width + height for mark variants", () => {
    const { container } = render(<BlankLogo variant="mark" size={48} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.getAttribute("height")).toBe("48");
  });

  it("default size for mark variants is 22", () => {
    const { container } = render(<BlankLogo variant="mark" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("22");
    expect(svg.getAttribute("height")).toBe("22");
  });

  it("MarkGlyph uses currentColor (inherits parent CSS) — NOT a hardcoded fill", () => {
    const { container } = render(<BlankLogo variant="mark" />);
    const fills = Array.from(container.querySelectorAll("svg [fill]")).map(
      (el) => el.getAttribute("fill"),
    );
    // Standalone mark must use currentColor to inherit parent text color.
    expect(fills).toContain("currentColor");
  });

  it("MarkContained uses explicit white fill (provides own silhouette container)", () => {
    const { container } = render(<BlankLogo variant="contained" />);
    const fills = Array.from(container.querySelectorAll("svg [fill]")).map(
      (el) => el.getAttribute("fill"),
    );
    // Contained variant has the inner mark in white (#FFFFFF) on the
    // black square — distinct from the currentColor inheritance pattern.
    expect(fills).toContain("#FFFFFF");
    expect(fills).toContain("#0A0A0A");
  });

  it("mark + contained variants get role='img' + aria-label='Blank' for SR", () => {
    for (const variant of ["mark", "contained"] as const) {
      const { container, unmount } = render(<BlankLogo variant={variant} />);
      const span = container.querySelector("span")!;
      expect(span.getAttribute("role")).toBe("img");
      expect(span.getAttribute("aria-label")).toBe("Blank");
      unmount();
    }
  });

  it("wordmark variant has aria-label but NO role='img' (it IS text, not an image)", () => {
    const { container } = render(<BlankLogo variant="wordmark" />);
    const span = container.querySelector("span")!;
    expect(span.getAttribute("role")).toBeNull();
    expect(span.getAttribute("aria-label")).toBe("Blank");
  });

  it("custom title prop overrides default 'Blank' aria-label on mark variants", () => {
    const { container } = render(<BlankLogo variant="mark" title="My Brand" />);
    const span = container.querySelector("span")!;
    expect(span.getAttribute("aria-label")).toBe("My Brand");
    expect(span.getAttribute("title")).toBe("My Brand");
  });

  it("custom className is forwarded to the wrapper span", () => {
    const { container } = render(
      <BlankLogo variant="wordmark" className="my-extra" />,
    );
    expect(container.querySelector("span")!.className).toContain("my-extra");
  });

  it("lockup variant prepends 'bl-lockup' base class to custom className", () => {
    const { container } = render(<BlankLogo variant="lockup" className="extra" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("bl-lockup");
    expect(wrapper.className).toContain("extra");
  });

  it("wordmarkSize prop applies inline font-size to the wordmark", () => {
    const { container } = render(
      <BlankLogo variant="wordmark" wordmarkSize="2.5rem" />,
    );
    const wordmark = container.querySelector(".bl-wordmark") as HTMLElement;
    expect(wordmark.style.fontSize).toBe("2.5rem");
  });

  it("wordmarkSize is omitted when not provided (no inline font-size)", () => {
    const { container } = render(<BlankLogo variant="wordmark" />);
    const wordmark = container.querySelector(".bl-wordmark") as HTMLElement;
    expect(wordmark.style.fontSize).toBe("");
  });
});
