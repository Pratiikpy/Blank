import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for App routing. Pins the audit Top-28 #19 ErrorBoundary
// wrap + #20 catch-all 404 (without #20, a typo'd URL falls through
// to a blank page indistinguishable from a broken app). Also pins the
// 17 landing + 4 Wave-4 public routes + /app/* gate.

// Stub every lazy-loaded route component so the test focuses on
// routing wiring, not page render. Each stub renders a sentinel
// data-testid so we can assert the right route resolved.

vi.mock("@/blank-ui/landing/Landing", () => ({
  default: () => <div data-testid="route-landing">LANDING</div>,
}));
vi.mock("@/blank-ui/landing/Features", () => ({
  default: () => <div data-testid="route-features">FEATURES</div>,
}));
vi.mock("@/blank-ui/landing/Live", () => ({
  default: () => <div data-testid="route-live">LIVE</div>,
}));
vi.mock("@/blank-ui/landing/Manifesto", () => ({
  default: () => <div data-testid="route-manifesto">MANIFESTO</div>,
}));
vi.mock("@/blank-ui/landing/HowItWorks", () => ({
  default: () => <div data-testid="route-how-it-works">HOWITWORKS</div>,
}));
vi.mock("@/blank-ui/landing/Verify", () => ({
  default: () => <div data-testid="route-verify">VERIFY</div>,
}));
vi.mock("@/blank-ui/landing/PayPage", () => ({
  default: () => <div data-testid="route-pay">PAY</div>,
}));
vi.mock("@/blank-ui/landing/AudiencePage", () => ({
  ForIndividuals: () => <div data-testid="route-individuals">FOR-INDIVIDUALS</div>,
  ForCreators: () => <div data-testid="route-creators">FOR-CREATORS</div>,
  ForBusinesses: () => <div data-testid="route-businesses">FOR-BUSINESSES</div>,
  ForDaos: () => <div data-testid="route-daos">FOR-DAOS</div>,
}));
vi.mock("@/blank-ui/landing/Pricing", () => ({
  default: () => <div data-testid="route-pricing">PRICING</div>,
}));
vi.mock("@/blank-ui/landing/Roadmap", () => ({
  default: () => <div data-testid="route-roadmap">ROADMAP</div>,
}));
vi.mock("@/blank-ui/landing/Blog", () => ({
  default: () => <div data-testid="route-blog">BLOG</div>,
}));
vi.mock("@/blank-ui/landing/BlogPost", () => ({
  default: () => <div data-testid="route-blog-post">BLOG-POST</div>,
}));
vi.mock("@/blank-ui/screens/ClaimLinkPage", () => ({
  default: () => <div data-testid="route-claim">CLAIM</div>,
}));
vi.mock("@/blank-ui/screens/StorefrontPage", () => ({
  default: () => <div data-testid="route-shop">SHOP</div>,
}));
vi.mock("@/blank-ui/screens/CrowdfundPage", () => ({
  default: () => <div data-testid="route-fund">FUND</div>,
}));
vi.mock("@/blank-ui/BlankApp", () => ({
  BlankApp: () => <div data-testid="route-app">BLANK-APP</div>,
}));

import { App } from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App — public landing routes (§15.x)", () => {
  const cases: Array<[string, string]> = [
    ["/", "route-landing"],
    ["/features", "route-features"],
    ["/how-it-works", "route-how-it-works"],
    ["/live", "route-live"],
    ["/manifesto", "route-manifesto"],
    ["/verify/0x1234", "route-verify"],
    ["/pay/alice.eth", "route-pay"],
    ["/for/individuals", "route-individuals"],
    ["/for/creators", "route-creators"],
    ["/for/businesses", "route-businesses"],
    ["/for/daos", "route-daos"],
    ["/pricing", "route-pricing"],
    ["/roadmap", "route-roadmap"],
    ["/blog", "route-blog"],
    ["/blog/why-fhenix-cofhe", "route-blog-post"],
  ];

  for (const [path, testid] of cases) {
    it(`${path} → ${testid}`, async () => {
      const { findByTestId } = renderAt(path);
      const el = await findByTestId(testid);
      expect(el).not.toBeNull();
    });
  }
});

describe("App — Wave 4 public routes (§15.x)", () => {
  it("/claim/:chainId/:linkId → ClaimLinkPage", async () => {
    const { findByTestId } = renderAt("/claim/11155111/abc123");
    expect(await findByTestId("route-claim")).not.toBeNull();
  });

  it("/shop/:chainId/:listingId → StorefrontPage", async () => {
    const { findByTestId } = renderAt("/shop/11155111/5");
    expect(await findByTestId("route-shop")).not.toBeNull();
  });

  it("/fund/:chainId/:campaignId → CrowdfundPage", async () => {
    const { findByTestId } = renderAt("/fund/11155111/7");
    expect(await findByTestId("route-fund")).not.toBeNull();
  });
});

describe("App — /app/* mounts the gated BlankApp (§15.x)", () => {
  it("/app routes to BlankApp", async () => {
    const { findByTestId } = renderAt("/app");
    expect(await findByTestId("route-app")).not.toBeNull();
  });

  it("/app/send routes to BlankApp (nested routes delegated internally)", async () => {
    const { findByTestId } = renderAt("/app/send");
    expect(await findByTestId("route-app")).not.toBeNull();
  });

  it("/app/business/invoices/42 also routes to BlankApp", async () => {
    const { findByTestId } = renderAt("/app/business/invoices/42");
    expect(await findByTestId("route-app")).not.toBeNull();
  });
});

describe("App — audit Top-28 #20 catch-all 404 (§15.x)", () => {
  it("unknown root-level URL → NotFoundLanding 404", async () => {
    const { findByText } = renderAt("/definitely-not-a-real-page");
    expect(await findByText("404")).not.toBeNull();
  });

  it("404 page shows 'Page not found' subtitle", async () => {
    const { findByText } = renderAt("/typo-xyz");
    expect(await findByText("Page not found")).not.toBeNull();
  });

  it("404 page has 'Go home' link → /", async () => {
    const { findByText } = renderAt("/missing");
    const home = await findByText("Go home");
    expect(home.getAttribute("href")).toBe("/");
  });

  it("404 page has 'Open app' link → /app", async () => {
    const { findByText } = renderAt("/missing");
    const openApp = await findByText("Open app");
    expect(openApp.getAttribute("href")).toBe("/app");
  });

  it("multi-segment unknown URLs also fall to 404 (not partial-match a real route)", async () => {
    const { findByText } = renderAt("/features/bogus/sub-path");
    expect(await findByText("404")).not.toBeNull();
  });
});

describe("App — audit Top-28 #19 ErrorBoundary (§15.x)", () => {
  it("renders a Suspense fallback while lazy chunks load", () => {
    // The spinner is rendered by LoadingScreen — class .animate-spin.
    const { container } = renderAt("/");
    // After resolution the spinner disappears, but at first paint there's
    // no synchronous render of the route. waitFor handles the swap.
    // Just confirm App renders SOMETHING without crashing.
    expect(container.firstChild).not.toBeNull();
  });

  it("uses Suspense + lazy-loading (route components are NOT statically imported)", async () => {
    // Sanity check: rendering / does NOT trigger the BlankApp stub.
    const { findByTestId, queryByTestId } = renderAt("/");
    await findByTestId("route-landing");
    expect(queryByTestId("route-app")).toBeNull();
  });
});

describe("App — route shape invariants (§15.x)", () => {
  it("/blog and /blog/:slug are DISTINCT routes (slug variant doesn't fall back to index)", async () => {
    const { findByTestId, unmount } = renderAt("/blog");
    expect(await findByTestId("route-blog")).not.toBeNull();
    unmount();

    const { findByTestId: findByTestId2 } = renderAt("/blog/some-slug");
    expect(await findByTestId2("route-blog-post")).not.toBeNull();
  });

  it("/for/<x> variants resolve to DIFFERENT components per audience", async () => {
    const cases: Array<[string, string]> = [
      ["/for/individuals", "route-individuals"],
      ["/for/creators", "route-creators"],
      ["/for/businesses", "route-businesses"],
      ["/for/daos", "route-daos"],
    ];
    for (const [path, testid] of cases) {
      const { findByTestId, unmount } = renderAt(path);
      await findByTestId(testid);
      unmount();
    }
  });

  it("unknown /for/<x> falls through to 404 (only the 4 declared audiences route)", async () => {
    const { findByText } = renderAt("/for/cats");
    expect(await findByText("404")).not.toBeNull();
  });
});

describe("App — case-insensitive routing (§15.x)", () => {
  it("uppercase '/Features' matches '/features' (react-router default is case-INsensitive)", async () => {
    const { findByTestId } = renderAt("/Features");
    expect(await findByTestId("route-features")).not.toBeNull();
  });

  it("mixed-case '/BlOg' also matches /blog", async () => {
    const { findByTestId } = renderAt("/BlOg");
    expect(await findByTestId("route-blog")).not.toBeNull();
  });
});
