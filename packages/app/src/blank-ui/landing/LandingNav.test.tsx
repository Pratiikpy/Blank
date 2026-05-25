import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for LandingNav. The shared top nav on every
// landing-level page (/ + /features + /live + /manifesto +
// /pricing + /roadmap + /blog + /for/*). NavLink marks the
// current route via the `active` class. The 'For' dropdown
// surfaces the audience pages (Individuals / Creators /
// Businesses / DAOs) without bloating the top nav. The 'Launch
// app' button takes users into /app.
//
// CRITICAL pins:
//   - Scroll effect: window.scrollY > 8 -> nav gets 'scrolled'
//     class so the header shrinks / blurs. Listener attached
//     PASSIVE so it doesn't block scroll perf; cleanup on
//     unmount. The 8px threshold is small enough that any
//     micro-scroll triggers the transition.
//   - For-dropdown 4 closes: outside click + Escape + route
//     change + toggle-button click. The route-change close
//     fires via useEffect on location.pathname so navigating
//     via a sub-link inside the dropdown auto-closes it.
//   - 'For' trigger has aria-haspopup='true' + aria-expanded
//     reflects open state; the dropdown menu uses role='menu'
//     with role='menuitem' on each link for assistive-tech
//     keyboard navigation.
//   - 'For' trigger gets 'active' class when on any /for/*
//     route (checked via startsWith('/for/')); this matters
//     because the dropdown itself is hidden but the parent
//     button should still highlight when the user is on a
//     descendant audience page.
//   - Blog NavLink uses custom isActive logic: active when
//     /blog OR /blog/* (e.g. /blog/wave-3-shipped) — the
//     route-prefix check ensures blog-post pages also
//     highlight the parent Blog nav entry.
//   - GitHub anchor opens in new tab via target='_blank' +
//     rel='noopener noreferrer' (security); aria-label='GitHub'
//     on the icon-only social anchor.
//   - 'Launch app' button at right -> /app route; styled as
//     primary CTA (ll-btn ll-btn--ink classes).

beforeEach(() => {
  // Silence framer-motion warnings in jsdom (no layout animations)
  vi.spyOn(console, "warn").mockImplementation(() => {});
  window.scrollY = 0;
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LandingNav />
    </MemoryRouter>,
  );
}

// Mock BlankLogo to avoid landing.css side-effects
vi.mock("./BlankLogo", () => ({
  BlankLogo: () => <div data-testid="blank-logo-stub">Logo</div>,
}));

import { LandingNav } from "./LandingNav";

// ───────────────────────────────────────────────────────────
//  Top-level nav links
// ───────────────────────────────────────────────────────────

describe("LandingNav — top-level links (§15.x)", () => {
  it("renders all expected nav links: Features / How it works / For / Pricing / Roadmap / Blog / Live / Manifesto / GitHub / Launch app", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: /Features/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /How it works/ })).toBeInTheDocument();
    // 'For' is a button, not a link
    expect(screen.getByRole("button", { name: /^For/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pricing/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Roadmap/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Blog$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Live$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Manifesto/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Launch app/ })).toBeInTheDocument();
  });

  it("'Launch app' CTA links to app.myblank.app with ll-btn--ink primary class", () => {
    renderAt("/");
    const cta = screen.getByRole("link", { name: /Launch app/ });
    expect((cta as HTMLAnchorElement).getAttribute("href")).toBe("https://app.myblank.app");
    expect(cta.className).toContain("ll-btn");
    expect(cta.className).toContain("ll-btn--ink");
  });

  it("Blog link points to blog.myblank.app", () => {
    renderAt("/");
    const blog = screen.getByRole("link", { name: /^Blog$/ });
    expect((blog as HTMLAnchorElement).getAttribute("href")).toBe("https://blog.myblank.app");
  });

  it("nav has aria-label='Primary' (landmark navigation)", () => {
    renderAt("/");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  GitHub external link (security attributes)
// ───────────────────────────────────────────────────────────

describe("LandingNav — GitHub external link (§15.x)", () => {
  it("icon-only GitHub anchor has aria-label='GitHub' for screen-readers", () => {
    renderAt("/");
    expect(screen.getByLabelText("GitHub")).toBeInTheDocument();
  });

  it("GitHub links open in new tab + rel='noopener noreferrer'", () => {
    renderAt("/");
    const githubLinks = screen.getAllByRole("link", { name: /GitHub/ });
    for (const link of githubLinks) {
      expect((link as HTMLAnchorElement).target).toBe("_blank");
      expect((link as HTMLAnchorElement).rel).toContain("noopener");
      expect((link as HTMLAnchorElement).rel).toContain("noreferrer");
    }
  });
});

// ───────────────────────────────────────────────────────────
//  Active route highlighting
// ───────────────────────────────────────────────────────────

describe("LandingNav — active route highlighting (§15.x)", () => {
  it("at '/features' -> Features nav link has 'active' class", () => {
    renderAt("/features");
    const features = screen.getByRole("link", { name: /Features/ });
    expect(features.className).toContain("active");
  });

  it("at '/pricing' -> Pricing has 'active', Features does NOT", () => {
    renderAt("/pricing");
    expect(
      screen.getByRole("link", { name: /Pricing/ }).className,
    ).toContain("active");
    expect(
      screen.getByRole("link", { name: /Features/ }).className,
    ).not.toContain("active");
  });

  it("at '/blog' -> Blog has 'active'", () => {
    renderAt("/blog");
    expect(screen.getByRole("link", { name: /^Blog$/ }).className).toContain("active");
  });

  it("at '/blog/wave-3-shipped' (sub-route) -> Blog STILL active via startsWith", () => {
    renderAt("/blog/wave-3-shipped");
    expect(screen.getByRole("link", { name: /^Blog$/ }).className).toContain("active");
  });

  it("at '/for/individuals' -> 'For' trigger button has 'active' class", () => {
    renderAt("/for/individuals");
    expect(
      screen.getByRole("button", { name: /^For/ }).className,
    ).toContain("active");
  });

  it("at '/for/creators' -> 'For' button still active (any /for/* path)", () => {
    renderAt("/for/creators");
    expect(
      screen.getByRole("button", { name: /^For/ }).className,
    ).toContain("active");
  });

  it("at '/' -> 'For' trigger button is NOT active", () => {
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /^For/ }).className,
    ).not.toContain("active");
  });
});

// ───────────────────────────────────────────────────────────
//  'For' dropdown
// ───────────────────────────────────────────────────────────

describe("LandingNav — 'For' dropdown (§15.x)", () => {
  it("click 'For' trigger -> dropdown opens + aria-expanded=true", () => {
    renderAt("/");
    const trigger = screen.getByRole("button", { name: /^For/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Menu now visible
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("dropdown renders 4 audience links: Individuals / Creators / Businesses / DAOs", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /^For/ }));
    const menu = screen.getByRole("menu");
    expect(menu.querySelector('a[href="https://www.myblank.app/for/individuals"]')).not.toBeNull();
    expect(menu.querySelector('a[href="https://www.myblank.app/for/creators"]')).not.toBeNull();
    expect(menu.querySelector('a[href="https://www.myblank.app/for/businesses"]')).not.toBeNull();
    expect(menu.querySelector('a[href="https://www.myblank.app/for/daos"]')).not.toBeNull();
  });

  it("each dropdown item has role='menuitem' for assistive tech", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /^For/ }));
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems).toHaveLength(4);
  });

  it("click 'For' trigger again -> dropdown closes", () => {
    renderAt("/");
    const trigger = screen.getByRole("button", { name: /^For/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape key -> dropdown closes", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /^For/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("outside click -> dropdown closes", () => {
    render(
      <MemoryRouter>
        <LandingNav />
        <button data-testid="outside-btn">Outside</button>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^For/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside-btn"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("aria-haspopup='true' on the 'For' trigger button", () => {
    renderAt("/");
    expect(
      screen.getByRole("button", { name: /^For/ }).getAttribute("aria-haspopup"),
    ).toBe("true");
  });

  it("non-Escape keydown does NOT close dropdown (only Escape)", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /^For/ }));
    fireEvent.keyDown(document, { key: "a" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("LandingNav — compact navigation (§15.x)", () => {
  it("opens a compact menu with canonical public routes", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeInTheDocument();
    const menu = screen.getByLabelText("Site navigation");
    expect(menu.querySelector('a[href="https://www.myblank.app/roadmap"]')).not.toBeNull();
    expect(menu.querySelector('a[href="https://blog.myblank.app"]')).not.toBeNull();
  });

  it("closes the compact menu on Escape", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("Site navigation")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Scroll effect
// ───────────────────────────────────────────────────────────

describe("LandingNav — scroll effect (§15.x)", () => {
  it("scrollY=0 (top) -> nav has NO 'scrolled' class", () => {
    window.scrollY = 0;
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toContain("scrolled");
  });

  it("scrollY > 8 -> nav gets 'scrolled' class after scroll event", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toContain("scrolled");

    window.scrollY = 100;
    fireEvent.scroll(window);
    expect(nav.className).toContain("scrolled");
  });

  it("scrollY=8 (boundary) -> NOT scrolled; scrollY=9 -> scrolled", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });

    window.scrollY = 8;
    fireEvent.scroll(window);
    expect(nav.className).not.toContain("scrolled");

    window.scrollY = 9;
    fireEvent.scroll(window);
    expect(nav.className).toContain("scrolled");
  });
});

// ───────────────────────────────────────────────────────────
//  Logo home link
// ───────────────────────────────────────────────────────────

describe("LandingNav — logo home link (§15.x)", () => {
  it("logo link points to the canonical homepage with aria-label='Blank home'", () => {
    renderAt("/");
    const logoLink = screen.getByLabelText("Blank home");
    expect((logoLink as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app");
  });

  it("logo renders the BlankLogo component (stubbed)", () => {
    renderAt("/");
    expect(screen.getByTestId("blank-logo-stub")).toBeInTheDocument();
  });
});
