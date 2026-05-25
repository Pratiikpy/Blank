import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AudiencePage, {
  ForIndividuals,
  ForCreators,
  ForBusinesses,
  ForDaos,
} from "./AudiencePage";

// jsdom doesn't implement window.scrollTo; stub it so the
// useEffect([audience]) scroll-reset doesn't spew Not-Implemented
// errors on every test.
beforeAll(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

// §15.x test for AudiencePage. Pin the per-audience content (headline,
// lead use case, primary CTA destination), the cross-sell grid that
// filters out the current audience (no "see also: yourself"), and the
// 4 wrapper components that map /for/<who> routes to the right
// audience prop.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("AudiencePage — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<AudiencePage audience="individuals" />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("AudiencePage — 4 audiences distinct content (§15.x)", () => {
  it("individuals: 'Your salary is your business' headline + income proof lead use case", () => {
    const { container } = withRouter(<AudiencePage audience="individuals" />);
    expect(container.textContent).toContain("Your salary is your business");
    expect(container.textContent).toContain("Encrypted income proof");
    expect(container.textContent).toContain("ebool");
  });

  it("creators: tier-badges-without-surveillance positioning + FHE.gte stat", () => {
    const { container } = withRouter(<AudiencePage audience="creators" />);
    expect(container.textContent).toContain("Accept tips");
    expect(container.textContent).toContain("Tier badges without surveillance");
    expect(container.textContent).toContain("FHE.gte");
  });

  it("businesses: 'comp bands to your investors' + 30-employee batch claim", () => {
    const { container } = withRouter(<AudiencePage audience="businesses" />);
    expect(container.textContent).toContain("leaking comp bands");
    expect(container.textContent).toContain("Encrypted payroll batches");
    expect(container.textContent).toContain("30");
  });

  it("daos: 'audit. Not surveil.' + FHE.allowGlobal aggregate-public-individual-private", () => {
    const { container } = withRouter(<AudiencePage audience="daos" />);
    expect(container.textContent).toContain("audit. Not surveil");
    expect(container.textContent).toContain("FHE.allowGlobal");
    expect(container.textContent).toContain("Encrypted grant payments");
  });
});

describe("AudiencePage — lead use case CTAs (§15.x)", () => {
  it("individuals lead CTA links to /app/proofs", () => {
    const { container } = withRouter(<AudiencePage audience="individuals" />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Try the proof flow"),
    );
    expect(cta?.getAttribute("href")).toBe("https://app.myblank.app/proofs");
  });

  it("creators lead CTA links to /app/creators", () => {
    const { container } = withRouter(<AudiencePage audience="creators" />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Set up CreatorHub"),
    );
    expect(cta?.getAttribute("href")).toBe("https://app.myblank.app/creators");
  });

  it("businesses lead CTA links to /app/business", () => {
    const { container } = withRouter(<AudiencePage audience="businesses" />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Open BusinessTools"),
    );
    expect(cta?.getAttribute("href")).toBe("https://app.myblank.app/business");
  });

  it("daos lead CTA links to /app/send", () => {
    const { container } = withRouter(<AudiencePage audience="daos" />);
    const cta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Try a payment"),
    );
    expect(cta?.getAttribute("href")).toBe("https://app.myblank.app/send");
  });
});

describe("AudiencePage — bullets + proof stats (§15.x)", () => {
  it("renders exactly 4 'why' bullets per audience", () => {
    for (const aud of ["individuals", "creators", "businesses", "daos"] as const) {
      const { container, unmount } = withRouter(<AudiencePage audience={aud} />);
      const bullets = container.querySelectorAll(".aud-bullet");
      expect(bullets.length).toBe(4);
      unmount();
    }
  });

  it("renders exactly 2 proof-stat cards per audience", () => {
    for (const aud of ["individuals", "creators", "businesses", "daos"] as const) {
      const { container, unmount } = withRouter(<AudiencePage audience={aud} />);
      const cards = container.querySelectorAll(".aud-proof-card");
      expect(cards.length).toBe(2);
      unmount();
    }
  });
});

describe("AudiencePage — primary + secondary CTAs (§15.x)", () => {
  it("every audience's primary CTA links to /app", () => {
    for (const aud of ["individuals", "creators", "businesses", "daos"] as const) {
      const { container, unmount } = withRouter(<AudiencePage audience={aud} />);
      const launchCta = Array.from(container.querySelectorAll("a")).find((a) =>
        a.textContent?.includes("Launch Blank"),
      );
      expect(launchCta?.getAttribute("href")).toBe("https://app.myblank.app");
      unmount();
    }
  });

  it("secondary CTA destinations differ per audience (intentional cross-link)", () => {
    const cases = [
      ["individuals", "How does this work?", "https://www.myblank.app/how-it-works"],
      ["creators", "See features", "https://www.myblank.app/features"],
      ["businesses", "AI agents demo", "https://app.myblank.app/agents"],
      ["daos", "Read the manifesto", "https://www.myblank.app/manifesto"],
    ] as const;
    for (const [aud, label, href] of cases) {
      const { container, unmount } = withRouter(<AudiencePage audience={aud} />);
      const cta = Array.from(container.querySelectorAll("a")).find((a) =>
        a.textContent?.includes(label),
      );
      expect(cta?.getAttribute("href")).toBe(href);
      unmount();
    }
  });
});

describe("AudiencePage — cross-sell grid (§15.x)", () => {
  it("renders exactly 3 cross-sell links (the OTHER 3 audiences, current excluded)", () => {
    for (const current of ["individuals", "creators", "businesses", "daos"] as const) {
      const { container, unmount } = withRouter(<AudiencePage audience={current} />);
      const crossLinks = container.querySelectorAll(".aud-cross-link");
      expect(crossLinks.length).toBe(3);

      const hrefs = Array.from(crossLinks).map((a) => a.getAttribute("href"));
      // Current must NOT appear in cross-sell.
      expect(hrefs).not.toContain(`https://www.myblank.app/for/${current}`);
      unmount();
    }
  });

  it("cross-sell links point to /for/<other-audience>", () => {
    const { container } = withRouter(<AudiencePage audience="individuals" />);
    const hrefs = Array.from(container.querySelectorAll(".aud-cross-link")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("https://www.myblank.app/for/creators");
    expect(hrefs).toContain("https://www.myblank.app/for/businesses");
    expect(hrefs).toContain("https://www.myblank.app/for/daos");
  });

  it("cross-sell card kicker reads 'For <audience>'", () => {
    const { container } = withRouter(<AudiencePage audience="individuals" />);
    const text = container.textContent ?? "";
    expect(text).toContain("For creators");
    expect(text).toContain("For businesses");
    expect(text).toContain("For daos");
  });
});

describe("AudiencePage — wrapper components (§15.x)", () => {
  it("ForIndividuals renders the individuals page", () => {
    const { container } = withRouter(<ForIndividuals />);
    expect(container.textContent).toContain("Your salary is your business");
  });

  it("ForCreators renders the creators page", () => {
    const { container } = withRouter(<ForCreators />);
    expect(container.textContent).toContain("Accept tips");
  });

  it("ForBusinesses renders the businesses page", () => {
    const { container } = withRouter(<ForBusinesses />);
    expect(container.textContent).toContain("leaking comp bands");
  });

  it("ForDaos renders the daos page", () => {
    const { container } = withRouter(<ForDaos />);
    expect(container.textContent).toContain("audit. Not surveil");
  });
});

describe("AudiencePage — kicker copy (§15.x)", () => {
  it("each audience has its own 'For <audience>' kicker", () => {
    const cases = [
      ["individuals", "For individuals"],
      ["creators", "For creators"],
      ["businesses", "For businesses"],
      ["daos", "For DAOs"],
    ] as const;
    for (const [aud, kicker] of cases) {
      const { container, unmount } = withRouter(<AudiencePage audience={aud} />);
      const kickerEl = container.querySelector(".aud-kicker");
      expect(kickerEl?.textContent).toBe(kicker);
      unmount();
    }
  });
});
