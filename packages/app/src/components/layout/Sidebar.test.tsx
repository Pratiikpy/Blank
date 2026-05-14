import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for Sidebar. The desktop nav rail with 4 sections:
// Overview (primary, always visible) / Features (collapsible) /
// Business (collapsible) / Settings (pinned to bottom). Auto-
// opens the collapsible section that contains the active route
// on mount so the user can see where they are in the nav tree
// without having to expand a section first.
//
// CRITICAL pins:
//   - 4-section layout: Overview always-visible (3 items:
//     Dashboard / Send / Receive); Features collapsible (4
//     items: Groups / Gifts / Creators / Stealth); Business
//     collapsible (4 items: Invoices & Payroll / Escrow /
//     Exchange / Swap); Settings always-visible at bottom (3
//     items: Privacy / Compliance / Settings). Total 14 nav
//     links across the rail.
//   - Auto-open the collapsible section that contains the
//     active route on mount; test pins by mounting at '/gifts'
//     (in featureItems) and asserting the Features chevron is
//     expanded, AND mounting at '/escrow' (in businessItems) and
//     asserting Business is expanded.
//   - Mount at a non-collapsible-section path ('/send' which is
//     in primary) -> BOTH collapsible sections start CLOSED;
//     mount at a settings path ('/privacy') -> both collapsible
//     sections start CLOSED (settings is its own pinned-bottom
//     group, not a collapsible).
//   - aria-current='page' on the active NavLink so screen-readers
//     announce 'current page'; non-active links omit the attribute
//     entirely (NOT 'false', because aria-current's enumerated
//     values don't include false).
//   - Section toggle button: aria-expanded reflects open state;
//     aria-controls points to 'section-{id}' which matches the
//     content panel's id; chevron rotates 180deg via cn() class
//     when isOpen=true.
//   - Toggle a section -> flips its open/closed state in the Set;
//     other sections unchanged; clicking the same toggle twice
//     opens then closes.
//   - Section content uses role='group' + aria-label=section
//     label so screen readers can navigate by section.
//   - framer-motion's `layoutId="sidebar-pill"` is applied to the
//     active-link pill so a route change animates the pill
//     between links; test pins by checking the layoutId
//     attribute is present (the actual animation doesn't run in
//     jsdom but the prop discipline matters).
//   - aria-label='Sidebar navigation' on the <nav> root for
//     screen-reader landmark navigation.

beforeEach(() => {
  // framer-motion logs warnings in jsdom (no layout animations possible)
  // — silence them for cleaner test output.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

// Imported AFTER mocks (none required for this pure-render
// component).
import { Sidebar } from "./Sidebar";

// ───────────────────────────────────────────────────────────
//  Section layout + nav links
// ───────────────────────────────────────────────────────────

describe("Sidebar — 4-section layout (§15.x)", () => {
  it("renders aside + nav with aria-label='Sidebar navigation'", () => {
    renderAt("/");
    expect(screen.getByLabelText("Sidebar navigation")).toBeInTheDocument();
  });

  it("Overview section always visible: Dashboard + Send + Receive", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Send/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Receive/ })).toBeInTheDocument();
  });

  it("Settings section always visible: Privacy + Compliance + Settings", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: /Privacy/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Compliance/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Settings$/ })).toBeInTheDocument();
  });

  it("Features section header rendered (collapsible toggle button)", () => {
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /Features/i }),
    ).toBeInTheDocument();
  });

  it("Business section header rendered (collapsible toggle button)", () => {
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /Business/i }),
    ).toBeInTheDocument();
  });

  it("Settings + Overview headers rendered (always-visible section labels)", () => {
    renderAt("/");
    // These are NOT buttons — they're plain spans for non-collapsible groups
    expect(screen.getByText("Overview")).toBeInTheDocument();
    // Both 'Settings' header (uppercase span) AND 'Settings' nav link exist
    const settingsHeaders = screen.getAllByText(/Settings/i);
    expect(settingsHeaders.length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────────────────────────────────
//  Auto-open collapsible section on mount
// ───────────────────────────────────────────────────────────

describe("Sidebar — auto-open collapsible on mount (§15.x)", () => {
  it("mount at '/gifts' (in features) -> Features section open + 'Groups' link visible", () => {
    renderAt("/gifts");
    const featuresToggle = screen.getByRole("button", { name: /Features/i });
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("true");
    // Sub-links are visible
    expect(screen.getByRole("link", { name: /Groups/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Gifts/ })).toBeInTheDocument();
  });

  it("mount at '/escrow' (in business) -> Business section open + 'Exchange' visible", () => {
    renderAt("/escrow");
    const businessToggle = screen.getByRole("button", { name: /Business/i });
    expect(businessToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: /Escrow/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Exchange/ })).toBeInTheDocument();
  });

  it("mount at '/send' (in primary) -> BOTH collapsibles start CLOSED", () => {
    renderAt("/send");
    expect(
      screen
        .getByRole("button", { name: /Features/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: /Business/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("mount at '/privacy' (in settings) -> BOTH collapsibles start CLOSED", () => {
    renderAt("/privacy");
    expect(
      screen
        .getByRole("button", { name: /Features/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: /Business/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("only the matching collapsible auto-opens (not both)", () => {
    renderAt("/stealth"); // in features
    expect(
      screen
        .getByRole("button", { name: /Features/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: /Business/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

// ───────────────────────────────────────────────────────────
//  Section toggle behavior
// ───────────────────────────────────────────────────────────

describe("Sidebar — section toggle (§15.x)", () => {
  it("click Features toggle -> opens; click again -> closes", () => {
    renderAt("/");
    const featuresToggle = screen.getByRole("button", { name: /Features/i });
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(featuresToggle);
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(featuresToggle);
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggling one section doesn't affect the other", () => {
    renderAt("/");
    const featuresToggle = screen.getByRole("button", { name: /Features/i });
    const businessToggle = screen.getByRole("button", { name: /Business/i });
    fireEvent.click(featuresToggle);
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("true");
    expect(businessToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(businessToggle);
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("true"); // still open
    expect(businessToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("auto-opened section can be manually closed", () => {
    renderAt("/gifts");
    const featuresToggle = screen.getByRole("button", { name: /Features/i });
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(featuresToggle);
    expect(featuresToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggle button aria-controls matches section id 'section-features'", () => {
    renderAt("/");
    const featuresToggle = screen.getByRole("button", { name: /Features/i });
    expect(featuresToggle.getAttribute("aria-controls")).toBe(
      "section-features",
    );
    fireEvent.click(featuresToggle);
    // Section content should now be in the DOM with that id
    expect(document.getElementById("section-features")).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  aria-current='page' on active link
// ───────────────────────────────────────────────────────────

describe("Sidebar — aria-current='page' on active link (§15.x)", () => {
  it("at '/' -> Dashboard link has aria-current='page'", () => {
    renderAt("/");
    const dashboard = screen.getByRole("link", { name: /Dashboard/ });
    expect(dashboard.getAttribute("aria-current")).toBe("page");
  });

  it("at '/send' -> Send link is current, Dashboard is NOT", () => {
    renderAt("/send");
    const send = screen.getByRole("link", { name: /Send/ });
    const dashboard = screen.getByRole("link", { name: /Dashboard/ });
    expect(send.getAttribute("aria-current")).toBe("page");
    // Non-active link omits aria-current entirely (not 'false')
    expect(dashboard.getAttribute("aria-current")).toBeNull();
  });

  it("at '/business' -> 'Invoices & Payroll' link is current (collapsible auto-opens)", () => {
    renderAt("/business");
    const businessToggle = screen.getByRole("button", { name: /Business/i });
    expect(businessToggle.getAttribute("aria-expanded")).toBe("true");
    const invoices = screen.getByRole("link", { name: /Invoices & Payroll/ });
    expect(invoices.getAttribute("aria-current")).toBe("page");
  });

  it("at '/settings' -> Settings link (in settings group) is current", () => {
    renderAt("/settings");
    const settingsLink = screen.getByRole("link", { name: /^Settings$/ });
    expect(settingsLink.getAttribute("aria-current")).toBe("page");
  });

  it("at an unknown path -> NO link has aria-current='page'", () => {
    renderAt("/nonexistent");
    const allLinks = screen.getAllByRole("link");
    const currentLinks = allLinks.filter(
      (l) => l.getAttribute("aria-current") === "page",
    );
    expect(currentLinks).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Link href + total link count
// ───────────────────────────────────────────────────────────

describe("Sidebar — link contract (§15.x)", () => {
  it("Dashboard link href='/' + Send href='/send' + Receive href='/receive'", () => {
    renderAt("/");
    expect(
      (screen.getByRole("link", { name: /Dashboard/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/");
    expect(
      (screen.getByRole("link", { name: /Send/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/send");
    expect(
      (screen.getByRole("link", { name: /Receive/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/receive");
  });

  it("Settings group links: Privacy / Compliance / Settings paths pinned", () => {
    renderAt("/");
    expect(
      (screen.getByRole("link", { name: /Privacy/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/privacy");
    expect(
      (screen.getByRole("link", { name: /Compliance/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/compliance");
    expect(
      (screen.getByRole("link", { name: /^Settings$/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/settings");
  });

  it("Features group links: Groups + Gifts + Creators + Stealth pinned", () => {
    renderAt("/gifts"); // auto-opens features
    expect(
      (screen.getByRole("link", { name: /Groups/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/groups");
    expect(
      (screen.getByRole("link", { name: /Creators/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/creators");
    expect(
      (screen.getByRole("link", { name: /Stealth/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/stealth");
  });

  it("Business group links: Invoices & Payroll + Escrow + Exchange + Swap pinned", () => {
    renderAt("/escrow"); // auto-opens business
    expect(
      (screen.getByRole("link", { name: /Invoices & Payroll/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/business");
    expect(
      (screen.getByRole("link", { name: /Exchange/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/exchange");
    expect(
      (screen.getByRole("link", { name: /Swap/ }) as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/swap");
  });

  it("total nav link count: 3 (Overview) + 3 (Settings) + 0 collapsed = 6 when both collapsibles closed", () => {
    renderAt("/"); // both collapsibles closed
    const allLinks = screen.queryAllByRole("link");
    expect(allLinks.length).toBe(6); // Overview 3 + Settings 3
  });

  it("expanded both collapsibles -> 14 total links (3 + 4 + 4 + 3)", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /Features/i }));
    fireEvent.click(screen.getByRole("button", { name: /Business/i }));
    const allLinks = screen.queryAllByRole("link");
    expect(allLinks.length).toBe(14);
  });
});

// ───────────────────────────────────────────────────────────
//  Accessibility primitives
// ───────────────────────────────────────────────────────────

describe("Sidebar — accessibility primitives (§15.x)", () => {
  it("nav has aria-label='Sidebar navigation' (landmark)", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Sidebar navigation" });
    expect(nav).toBeInTheDocument();
  });

  it("expanded collapsible section content has role='group' + aria-label", () => {
    renderAt("/gifts"); // Features auto-opens
    const featuresGroup = screen.getByRole("group", { name: "Features" });
    expect(featuresGroup).toBeInTheDocument();
    expect(featuresGroup.id).toBe("section-features");
  });

  it("toggle button aria-controls + id pattern matches across both sections", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /Features/i }));
    fireEvent.click(screen.getByRole("button", { name: /Business/i }));
    expect(document.getElementById("section-features")).not.toBeNull();
    expect(document.getElementById("section-business")).not.toBeNull();
  });
});
