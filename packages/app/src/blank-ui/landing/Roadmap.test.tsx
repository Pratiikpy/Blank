import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Roadmap from "./Roadmap";

// §15.x test for Roadmap. Pin the 3-block structure (Shipped /
// Next / Blocked) and the explicit "Blocked by" dependency lists.
// The Mainnet entry's blockers (Fhenix CoFHE mainnet + third-party
// audit + threshold operator decentralization) are the load-bearing
// part — what makes "no dates" read as understanding rather than
// stalling.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Roadmap — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("Roadmap — hero (§15.x)", () => {
  it("eyebrow reads 'Roadmap'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Roadmap");
  });

  it("CRITICAL headline frames 3-block structure: shipped / next / waiting-on-someone-else", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("What's shipped");
    expect(container.textContent).toContain("What's next");
    expect(container.textContent).toContain("What's waiting on someone else");
  });

  it("subline articulates the no-dates honesty stance", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("don't publish dates");
    expect(container.textContent).toContain("turn out to be wrong");
  });
});

describe("Roadmap — Shipped block (§15.x)", () => {
  it("renders 'Shipped' status badge label", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Shipped");
  });

  it("section heading: 'Shipped. Live on testnet today.'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Shipped. Live on testnet today");
  });

  it("section lead claims 'Twenty-one product surfaces, one encrypted vault, two chains'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Twenty-one product surfaces");
    expect(container.textContent).toContain("two chains");
  });

  it("renders all 10 shipped item titles", () => {
    const { container } = withRouter(<Roadmap />);
    const text = container.textContent ?? "";
    const shipped = [
      "Encrypted P2P payments",
      "Private invoice escrow",
      "Workspace modes",
      "Stealth payments + meta-addresses",
      "Group expenses + gift envelopes",
      "Confidential payroll",
      "Verifiable balance proofs",
      "Passkey smart wallets + paymaster",
      "Dead-man's-switch inheritance",
      "Dual-chain (Base + Eth Sepolia)",
    ];
    for (const item of shipped) {
      expect(text).toContain(item);
    }
  });
});

describe("Roadmap — Next block (§15.x)", () => {
  it("renders 'Next up' status badge label", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Next up");
  });

  it("section heading: 'Next up. Product hardening.'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Next up. Product hardening");
  });

  it("renders all 7 next-up item titles", () => {
    const { container } = withRouter(<Roadmap />);
    const text = container.textContent ?? "";
    const next = [
      "Design system extraction",
      "Trust layer",
      "Complete notification delivery",
      "SDK + embeddable checkout",
      "X-Ray reveal in-app",
      "Optimistic balance + caching",
      "Universal /receive page",
    ];
    for (const item of next) {
      expect(text).toContain(item);
    }
  });

  it("Trust layer description includes /security + bug bounty + audit booking", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("/security page");
    expect(container.textContent).toContain("bug bounty");
    expect(container.textContent).toContain("audit booking");
  });
});

describe("Roadmap — Blocked block (§15.x)", () => {
  it("renders 'Blocked on dependencies' status badge", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Blocked on dependencies");
  });

  it("section heading: 'Blocked. We can't ship these yet.'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("We can't ship these yet");
  });

  it("renders 3 blocked item titles", () => {
    const { container } = withRouter(<Roadmap />);
    const text = container.textContent ?? "";
    expect(text).toContain("Mainnet");
    expect(text).toContain("More chains beyond Base + Eth Sepolia");
    expect(text).toContain("Mobile app (native)");
  });

  it("CRITICAL: Mainnet entry lists all 3 blockers (Fhenix CoFHE mainnet + audit + decentralization)", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Fhenix CoFHE mainnet release");
    expect(container.textContent).toContain("Third-party audit");
    expect(container.textContent).toContain("Decentralization of the threshold operator set");
  });

  it("Cross-chain blockers mention sustained traction + threshold-decrypt presence", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Sustained traction");
    expect(container.textContent).toContain("Threshold-decrypt operator presence");
  });

  it("Mobile app blockers mention real demand + Fhenix SDK for React Native / iOS / Android", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Real demand from current users");
    expect(container.textContent).toContain("React Native or native iOS/Android");
  });

  it("each Blocked item gets its own 'Blocked by' header", () => {
    const { container } = withRouter(<Roadmap />);
    const blockedByCount = (container.textContent?.match(/Blocked by/g) ?? []).length;
    // 3 blocked items × 1 "Blocked by" header each = 3 occurrences.
    expect(blockedByCount).toBe(3);
  });
});

describe("Roadmap — CTA (§15.x)", () => {
  it("CTA section title asks if reader wants update notifications", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("Want to know when something moves");
  });

  it("CTA copy promises 'No newsletter sign-up, no notification spam'", () => {
    const { container } = withRouter(<Roadmap />);
    expect(container.textContent).toContain("No newsletter sign-up");
    expect(container.textContent).toContain("no notification spam");
  });

  it("'Read the blog' CTA links to /blog", () => {
    const { container } = withRouter(<Roadmap />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Read the blog"),
    );
    expect(cta?.getAttribute("href")).toBe("https://blog.myblank.app");
  });
});
