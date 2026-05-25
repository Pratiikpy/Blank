import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Manifesto from "./Manifesto";

// §15.x test for Manifesto. Smoke + content pin: the long-form
// landing-page copy carries the personal-voice positioning, and a
// silent typo in a key stat ("272,000" addresses leaked, "$900M+"
// MEV) would undermine the whole argument. Pin headline + stats +
// section structure + CTA destinations.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Manifesto — page chrome (§15.x)", () => {
  it("renders without crashing", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.firstChild).not.toBeNull();
  });

  it("includes the LandingNav (with 'Launch app' CTA somewhere)", () => {
    const { container } = withRouter(<Manifesto />);
    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute("aria-label")).toBe("Primary");
  });

  it("includes the LandingFooter", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.querySelector("footer")).not.toBeNull();
  });

  it("wraps the page in a 'blank-landing' container", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });

  it("uses an <article> element for the long-form prose (semantic landmark)", () => {
    const { container } = withRouter(<Manifesto />);
    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    expect(article!.className).toContain("ll-manifesto");
  });
});

describe("Manifesto — headline + intro (§15.x)", () => {
  it("renders the 'Manifesto' kicker label", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("Manifesto");
  });

  it("renders the load-bearing headline 'Your money is nobody else's business.'", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("Your money is nobody else's business");
  });

  it("opens with the 'postcard' framing in the intro", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("postcard");
  });

  it("frames the product as a correction, not a feature", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("It's a correction");
  });
});

describe("Manifesto — stat block (§15.x)", () => {
  it("CRITICAL: $900M+ MEV stat is exact", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("$900M+");
  });

  it("CRITICAL: 272,000 hardware-wallet leaked-address stat is exact", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("272,000");
  });

  it("Zero-enterprise-treasuries claim is present", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("Zero");
    expect(container.textContent).toContain("enterprise treasuries");
  });

  it("DAO contributor salary visibility claim is present", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("DAO");
    expect(container.textContent).toContain("salary");
  });
});

describe("Manifesto — section headings (§15.x)", () => {
  it("renders the 4 section h2 headings", () => {
    const { container } = withRouter(<Manifesto />);
    const h2s = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(h2s).toContain("The bill is coming due for public money");
    expect(h2s).toContain("FHE isn't a buzzword");
    expect(h2s).toContain("Private payments aren't a feature");
    expect(h2s).toContain("What's next");
  });

  it("FHE explainer mentions Fhenix CoFHE", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("Fhenix CoFHE");
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
  });

  it("'sixteen surfaces' surface-area claim is present", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("sixteen surfaces");
    expect(container.textContent).toContain("share one encrypted vault");
  });
});

describe("Manifesto — CTAs (§15.x)", () => {
  it("Launch app CTA links to /app", () => {
    const { container } = withRouter(<Manifesto />);
    const launchCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Launch Blank"),
    );
    expect(launchCta?.getAttribute("href")).toBe("https://app.myblank.app");
  });

  it("'See it live' CTA links to /live", () => {
    const { container } = withRouter(<Manifesto />);
    const liveCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("See it live"),
    );
    expect(liveCta?.getAttribute("href")).toBe("https://www.myblank.app/live");
  });

  it("ends with the team signature line", () => {
    const { container } = withRouter(<Manifesto />);
    expect(container.textContent).toContain("The Blank team");
  });
});
