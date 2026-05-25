import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Features from "./Features";

// §15.x test for the Features catalog page. 21 features, each a row
// with copy + a CSS-only Preview card. The Preview component is a
// discriminated union over 8 kinds (receipt/group/badge/invoice/
// stealth/envelope/countdown/swap); adding a future kind without a
// matching `case` branch in the switch would silently render nothing
// for that feature. Pinning all 8 branches catches that regression.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Features — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<Features />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("Features — hero (§15.x)", () => {
  it("kicker reads 'Twenty-one private surfaces' (the landing-page tagline)", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("Twenty-one private surfaces");
  });

  it("CRITICAL headline: 'The payment workflows people expect. With the amounts sealed shut.'", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("The payment workflows people expect");
    expect(container.textContent).toContain("amounts sealed shut");
  });

  it("lead claims 'One encrypted vault' + dual-chain shipping", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("One encrypted vault");
    expect(container.textContent).toContain("Ethereum");
    expect(container.textContent).toContain("Sepolia");
    expect(container.textContent).toContain("Base Sepolia");
  });
});

describe("Features — 21-feature catalog (§15.x)", () => {
  it("renders representative feature names", () => {
    const { container } = withRouter(<Features />);
    const text = container.textContent ?? "";
    const features = [
      "Send",
      "Requests",
      "Group Split",
      "Creator Tips",
      "Invoicing",
      "Batch Payroll",
      "Escrow",
      "Stealth Payments",
      "Gift Envelopes",
      "Inheritance",
      "P2P Exchange",
      "Encrypted Proofs",
      "Claim Links",
      "Storefront",
      "Crowdfund",
      "Bridge",
    ];
    for (const f of features) {
      expect(text).toContain(f);
    }
  });

  it("renders all 21 numbered tags (01. -> 21.)", () => {
    const { container } = withRouter(<Features />);
    const text = container.textContent ?? "";
    for (let i = 1; i <= 21; i++) {
      const tag = `${i.toString().padStart(2, "0")}.`;
      expect(text).toContain(tag);
    }
  });

  it("renders exactly 21 feature rows (one per catalog entry)", () => {
    const { container } = withRouter(<Features />);
    expect(container.querySelectorAll(".ll-feature-row").length).toBe(21);
  });

  it("alternates 'reversed' class on every other row (zebra layout)", () => {
    const { container } = withRouter(<Features />);
    const rows = container.querySelectorAll(".ll-feature-row");
    // Even indices (0, 2, 4...) don't get "reversed"; odd indices (1, 3, 5...) do.
    for (let i = 0; i < rows.length; i++) {
      if (i % 2 === 1) {
        expect(rows[i].className).toContain("reversed");
      } else {
        expect(rows[i].className).not.toContain("reversed");
      }
    }
  });

  it("each feature has a 'Try <name>' CTA linking to its app route", () => {
    const { container } = withRouter(<Features />);
    const ctas = Array.from(container.querySelectorAll(".ll-feature-cta")) as HTMLAnchorElement[];
    expect(ctas.length).toBe(21);
    const routes = ctas.map((a) => a.getAttribute("href"));
    expect(routes).toContain("https://app.myblank.app/send");
    expect(routes).toContain("https://app.myblank.app/requests");
    expect(routes).toContain("https://app.myblank.app/groups");
    expect(routes).toContain("https://app.myblank.app/creators");
    expect(routes).toContain("https://app.myblank.app/business");
    expect(routes).toContain("https://app.myblank.app/stealth");
    expect(routes).toContain("https://app.myblank.app/gifts");
    expect(routes).toContain("https://app.myblank.app/inheritance");
    expect(routes).toContain("https://app.myblank.app/swap");
    expect(routes).toContain("https://app.myblank.app/proofs");
    expect(routes).toContain("https://app.myblank.app/claim-link");
    expect(routes).toContain("https://app.myblank.app/sell");
    expect(routes).toContain("https://app.myblank.app/fundraise");
    expect(routes).toContain("https://app.myblank.app/bridge");
    // Wave 5 entries (17-21).
    expect(routes).toContain("https://app.myblank.app/offramp");
    expect(routes).toContain("https://www.myblank.app/u/alice");
    expect(routes).toContain("https://www.myblank.app/recover/alice");
    expect(routes).toContain("https://app.myblank.app/insights");
    expect(routes).toContain("https://app.myblank.app/proof-of-balance");
  });
});

describe("Features — Preview discriminated-union (§15.x)", () => {
  it("CRITICAL all 8 preview kinds render their distinctive copy (no silent missing branch)", () => {
    const { container } = withRouter(<Features />);
    const text = container.textContent ?? "";

    // receipt: "Transaction" title
    expect(text).toContain("Transaction");
    // group: "Members" label
    expect(text).toContain("Members");
    // badge: "Supporter tier"
    expect(text).toContain("Supporter tier");
    // invoice: "Awaiting payment" status
    expect(text).toContain("Awaiting payment");
    // stealth: "Claim code" title
    expect(text).toContain("Claim code");
    // envelope: "Gift envelope" title
    expect(text).toContain("Gift envelope");
    // countdown: "Dead man's switch"
    expect(text).toContain("Dead man's switch");
    // swap: "Encrypted swap"
    expect(text).toContain("Encrypted swap");
  });

  it("encrypted amount placeholder (████.██) appears across multiple feature previews", () => {
    const { container } = withRouter(<Features />);
    const text = container.textContent ?? "";
    expect(text).toContain("████.██");
  });

  it("payroll preview shows the larger ████████.██ placeholder for batch totals", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("████████.██");
  });

  it("countdown preview shows 'days' + 'until heir can claim'", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("days");
    expect(container.textContent).toContain("until heir can claim");
  });

  it("stealth preview includes the lowercase claim-code shape (3-word-9248 form)", () => {
    const { container } = withRouter(<Features />);
    // Source ships "shield-lotus-9248" as the demo value.
    expect(container.textContent).toContain("shield-lotus-9248");
  });

  it("group preview renders 4 colored member avatars (AL/JM/RK/NS)", () => {
    const { container } = withRouter(<Features />);
    const text = container.textContent ?? "";
    for (const initials of ["AL", "JM", "RK", "NS"]) {
      expect(text).toContain(initials);
    }
  });

  it("envelope preview uses the red-envelope emoji 🧧 as visual anchor", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("🧧");
  });
});

describe("Features — scenarios + pitches (§15.x)", () => {
  it("each feature has a real-world scenario block (rendered with .ll-feature-scenario)", () => {
    const { container } = withRouter(<Features />);
    const scenarios = container.querySelectorAll(".ll-feature-scenario");
    expect(scenarios.length).toBe(21);
  });

  it("Send scenario names 'Sarah pays her freelance designer $800'", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("Sarah pays her freelance designer $800");
  });

  it("Batch Payroll pitch claims 30-employee cap + per-line encryption", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("up to 30 employees");
    expect(container.textContent).toContain("individually encrypted");
  });

  it("Inheritance scenario specifies the 90-day inactivity trigger", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("90-day inactivity trigger");
  });
});

describe("Features — bottom CTA (§15.x)", () => {
  it("CTA section heading: 'One vault. Twenty-one ways in.'", () => {
    const { container } = withRouter(<Features />);
    expect(container.textContent).toContain("One vault. Twenty-one ways in");
  });

  it("'Launch Blank' CTA links to /app", () => {
    const { container } = withRouter(<Features />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Launch Blank"),
    );
    expect(cta?.getAttribute("href")).toBe("https://app.myblank.app");
  });
});
