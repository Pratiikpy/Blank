import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for LandingFooter. Shared footer across every
// landing-level page. Minimal footer with primary public links
// (Features / How it works / Pricing / Roadmap / Live / Docs /
// Brand Kit / Blog / Manifesto / Proof deck / Launch app / GitHub /
// Fhenix attribution). The footer is intentionally static so it
// renders identically on every page; the only dynamic part is
// the copyright year via new Date().getFullYear().
//
// CRITICAL pins:
//   - Copyright line: '© {YYYY} Blank. Private by design.'
//     where {YYYY} is the current year via new Date().get
//     FullYear() - the year auto-updates each January 1 without
//     code edits; test pins via mocked Date so the assertion
//     stays stable across years.
//   - 10 internal Link entries: /features, /how-it-works, /pricing,
//     /roadmap, /live, /whitepaper, /brand-kit, /blog, /manifesto,
//     /app - these are the same public destinations as LandingNav's
//     CTAs so a regression that renamed any landing-page route
//     would break BOTH this footer AND the nav at the same
//     time (paired contracts).
//   - 2 external <a> entries: github.com/Pratiikpy/Blank +
//     fhenix.io - both with target='_blank' + rel='noopener
//     noreferrer' for tabnabbing protection.
//   - <footer> semantic tag (NOT <div>) so screen-readers
//     navigate to it as a landmark.
//   - Copy 'Private by design.' (period included) - pinned
//     literally because it's the brand tagline.
//   - 'Built on Fhenix ↗' includes the ↗ arrow Unicode char
//     (U+2197) which signals 'external link' to sighted users;
//     pinned literally so a regression that swapped to a
//     plain '>' or lucide icon would lose the inline visual
//     cue.

beforeEach(() => {
  // Pin the year to 2025 so the test doesn't break on Jan 1.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-06-15T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function renderFooter() {
  return render(
    <MemoryRouter>
      <LandingFooter />
    </MemoryRouter>,
  );
}

import { LandingFooter } from "./LandingFooter";

// ───────────────────────────────────────────────────────────
//  Copyright + tagline
// ───────────────────────────────────────────────────────────

describe("LandingFooter — copyright + tagline (§15.x)", () => {
  it("renders copyright with current year", () => {
    renderFooter();
    expect(
      screen.getByText("© 2025 Blank. Private by design."),
    ).toBeInTheDocument();
  });

  it("year updates when system time changes (auto-bump each January)", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    renderFooter();
    expect(
      screen.getByText("© 2026 Blank. Private by design."),
    ).toBeInTheDocument();
  });

  it("tagline includes the literal 'Private by design.' phrase (with period)", () => {
    renderFooter();
    expect(screen.getByText(/Private by design\./)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Internal Link entries
// ───────────────────────────────────────────────────────────

describe("LandingFooter — internal links (§15.x)", () => {
  it("Features link points to /features", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Features" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/features");
  });

  it("How it works link points to /how-it-works", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "How it works" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/how-it-works");
  });

  it("Pricing link points to /pricing", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Pricing" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/pricing");
  });

  it("Roadmap link points to /roadmap", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Roadmap" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/roadmap");
  });

  it("Live link points to /live", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Live" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/live");
  });

  it("Docs link points to docs.myblank.app", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Docs" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://docs.myblank.app");
  });

  it("Brand Kit link points to brand.myblank.app", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Brand Kit" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://brand.myblank.app");
  });

  it("Blog link points to blog.myblank.app", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Blog" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://blog.myblank.app/blog");
  });

  it("Manifesto link points to /manifesto", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Manifesto" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://www.myblank.app/manifesto");
  });

  it("Launch app link points to app.myblank.app", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Launch app" });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://app.myblank.app");
  });
});

// ───────────────────────────────────────────────────────────
//  2 external <a> entries (target='_blank' + rel security)
// ───────────────────────────────────────────────────────────

describe("LandingFooter — external links (§15.x)", () => {
  it("GitHub link: target='_blank' + rel='noopener noreferrer'", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "GitHub" });
    expect((link as HTMLAnchorElement).href).toContain("github.com");
    expect((link as HTMLAnchorElement).target).toBe("_blank");
    expect((link as HTMLAnchorElement).rel).toContain("noopener");
    expect((link as HTMLAnchorElement).rel).toContain("noreferrer");
  });

  it("Fhenix attribution link includes '↗' arrow char + target='_blank'", () => {
    renderFooter();
    const link = screen.getByText(/Built on Fhenix ↗/);
    expect(link).toBeInTheDocument();
    const anchor = link.closest("a") as HTMLAnchorElement;
    expect(anchor.href).toContain("fhenix.io");
    expect(anchor.target).toBe("_blank");
    expect(anchor.rel).toContain("noopener");
    expect(anchor.rel).toContain("noreferrer");
  });

  it("'↗' Unicode char (U+2197) signals external link to sighted users", () => {
    renderFooter();
    const fhenixLink = screen.getByText(/Built on Fhenix ↗/);
    // The text includes the arrow character literally
    expect(fhenixLink.textContent).toContain("↗");
  });
});

// ───────────────────────────────────────────────────────────
//  Semantic markup + total link count
// ───────────────────────────────────────────────────────────

describe("LandingFooter — semantic markup (§15.x)", () => {
  it("uses <footer> semantic tag (NOT <div>) for landmark navigation", () => {
    const { container } = renderFooter();
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer!.tagName).toBe("FOOTER");
  });

  it("total link count is exactly 13 (11 internal + 2 external)", () => {
    renderFooter();
    expect(screen.getAllByRole("link")).toHaveLength(13);
  });

  it("Proof deck link points to /proof-deck", () => {
    renderFooter();
    const link = screen.getByRole("link", { name: "Proof deck" });
    expect(link.getAttribute("href")).toBe("https://www.myblank.app/proof-deck");
  });
});
