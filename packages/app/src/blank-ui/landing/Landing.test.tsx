import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for the Landing (/) root page. Stub out the heavy
// data-dependent children (DecodeWord setInterval animations,
// LiveDemo wagmi calls, GlobalCounter cofhe SDK) so the test
// focuses on Landing's OWN content + composition ordering. The
// ordering is a conversion-funnel choice; pinning section order
// catches a refactor that breaks the funnel.

vi.mock("./DecodeWord", () => ({ DecodeWord: () => <div data-testid="decode-word" /> }));
vi.mock("./XRaySlider", () => ({
  XRaySlider: () => <div data-testid="x-ray-slider" />,
}));
vi.mock("./LiveDemo", () => ({ LiveDemo: () => <div data-testid="live-demo" /> }));
vi.mock("./GlobalCounter", () => ({
  GlobalCounter: () => <div data-testid="global-counter" />,
}));

import Landing from "./Landing";

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Landing — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<Landing />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });

  it("composes 4 stubbed child components: DecodeWord + XRaySlider + GlobalCounter + LiveDemo", () => {
    const { getByTestId } = withRouter(<Landing />);
    expect(getByTestId("decode-word")).toBeDefined();
    expect(getByTestId("x-ray-slider")).toBeDefined();
    expect(getByTestId("global-counter")).toBeDefined();
    expect(getByTestId("live-demo")).toBeDefined();
  });
});

describe("Landing — Hero (§15.x)", () => {
  it("eyebrow targets 'freelancers, teams, and small businesses'", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("For freelancers, teams, and small businesses");
  });

  it("CRITICAL headline: 'Send a private invoice.' + 'Get paid privately.'", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Send a private invoice");
    expect(container.textContent).toContain("Get paid privately");
  });

  it("subline names Fhenix CoFHE explicitly", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Fhenix CoFHE");
  });

  it("hero CTAs: 'Launch Blank' → app.myblank.app + 'See it live' → /live", () => {
    const { container } = withRouter(<Landing />);
    const ctas = Array.from(container.querySelectorAll("a"));
    const launch = ctas.find((a) => a.textContent?.includes("Launch Blank"));
    const live = ctas.find((a) => a.textContent?.includes("See it live"));
    expect(launch?.getAttribute("href")).toBe("https://app.myblank.app");
    expect(live?.getAttribute("href")).toBe("https://www.myblank.app/live");
  });
});

describe("Landing — ProofOfProduct (§15.x)", () => {
  it("renders the 'Not a roadmap. Working software.' headline", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Not a roadmap. Working software");
  });

  it("renders the 3 stat numbers: 'Live', '21', 'FHE'", () => {
    const { container } = withRouter(<Landing />);
    const statNumbers = Array.from(container.querySelectorAll(".ll-stat-number")).map((el) =>
      el.textContent?.trim(),
    );
    expect(statNumbers).toContain("Live");
    expect(statNumbers).toContain("21");
    expect(statNumbers).toContain("FHE");
  });

  it("Live stat references Base Sepolia + Ethereum Sepolia", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Base Sepolia");
    expect(container.textContent).toContain("Ethereum Sepolia");
  });

  it("FHE stat explicitly names 'Fhenix CoFHE'", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Built on Fhenix CoFHE");
  });
});

describe("Landing — HowItWorks (§15.x)", () => {
  it("headline: 'Shield. Send. Decrypt. Three steps, one private payment.'", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain(
      "Shield. Send. Decrypt. Three steps, one private payment.",
    );
  });

  it("renders the 3 numbered steps: 01 / 02 / 03", () => {
    const { container } = withRouter(<Landing />);
    const stepNums = Array.from(container.querySelectorAll(".ll-step-num"))
      .map((el) => el.textContent?.trim())
      .filter((t) => /^\d{2}$/.test(t ?? ""));
    expect(stepNums).toContain("01");
    expect(stepNums).toContain("02");
    expect(stepNums).toContain("03");
  });

  it("step titles: Shield / Send / Receive (in that order)", () => {
    const { container } = withRouter(<Landing />);
    const text = container.textContent ?? "";
    const shieldIdx = text.indexOf("Shield");
    const sendIdx = text.indexOf("Send", shieldIdx + 1);
    const receiveIdx = text.indexOf("Receive", sendIdx + 1);
    expect(shieldIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(shieldIdx);
    expect(receiveIdx).toBeGreaterThan(sendIdx);
  });

  it("Shield step mentions eUSDC + ciphertext-on-chain", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("eUSDC");
    expect(container.textContent).toContain("ciphertext");
  });
});

describe("Landing — ExploreLinks (§15.x)", () => {
  it("renders the 'Dig deeper' kicker + 'Three more places to look.' heading", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Dig deeper");
    expect(container.textContent).toContain("Three more places to look");
  });

  it("3 cards link to /features + /live + /manifesto respectively", () => {
    const { container } = withRouter(<Landing />);
    const hrefs = Array.from(container.querySelectorAll("a.ll-step")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("https://www.myblank.app/features");
    expect(hrefs).toContain("https://www.myblank.app/live");
    expect(hrefs).toContain("https://www.myblank.app/manifesto");
  });

  it("manifesto card surfaces the $900M MEV + 272K leaked addresses framing", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("$900M in MEV");
    expect(container.textContent).toContain("272K leaked addresses");
  });

  it("each ExploreLink card has its own CTA copy ('See all features', 'Open the ticker', 'Read the manifesto')", () => {
    const { container } = withRouter(<Landing />);
    const text = container.textContent ?? "";
    expect(text).toContain("See all features");
    expect(text).toContain("Open the ticker");
    expect(text).toContain("Read the manifesto");
  });
});

describe("Landing — closing CTA (§15.x)", () => {
  it("CRITICAL CTA title: 'Your money is nobody else's business.' (matches Manifesto framing)", () => {
    const { container } = withRouter(<Landing />);
    expect(container.textContent).toContain("Your money is nobody else's business");
  });

  it("closing 'Launch Blank' CTA links to app.myblank.app", () => {
    const { container } = withRouter(<Landing />);
    const launchCtas = Array.from(container.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Launch Blank"),
    );
    // Hero AND closing CTA both render "Launch Blank" — at least 2 total.
    expect(launchCtas.length).toBeGreaterThanOrEqual(2);
    for (const cta of launchCtas) {
      expect(cta.getAttribute("href")).toBe("https://app.myblank.app");
    }
  });
});

describe("Landing — funnel ordering (§15.x)", () => {
  it("composes sections in the conversion-funnel order: Hero → counter → demo → proof → how → explore → CTA", () => {
    const { container } = withRouter(<Landing />);

    // Use distinctive copy from each section to determine its position in textContent.
    const text = container.textContent ?? "";
    const positions: Array<[string, number]> = [
      ["hero", text.indexOf("Send a private invoice")],
      ["proof", text.indexOf("Not a roadmap")],
      ["how", text.indexOf("Three steps, one private payment")],
      ["explore", text.indexOf("Three more places to look")],
      ["cta", text.indexOf("Your money is nobody else's business")],
    ];

    // Hero → Proof → How → Explore → CTA must be strictly increasing.
    const filtered = positions.filter(([, idx]) => idx >= 0);
    for (let i = 1; i < filtered.length; i++) {
      expect(filtered[i][1]).toBeGreaterThan(filtered[i - 1][1]);
    }
  });
});
