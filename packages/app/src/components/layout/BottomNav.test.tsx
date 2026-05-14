import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for BottomNav. The mobile-only bottom-tab nav rail.
// 5 fixed tabs: Home / Send / Receive / Groups / More(Settings).
// Animates a dot under the active tab via framer-motion layoutId
// so the dot smoothly slides between tabs on route change. Used
// as the mobile alternative to the desktop Sidebar — visible only
// at narrow viewports via the parent layout's md: visibility.
//
// CRITICAL pins:
//   - 5-tab fixed layout: Home / Send / Receive / Groups / More
//     mapped to paths '/' / '/send' / '/receive' / '/groups' /
//     '/settings'; a regression that renamed any path would
//     break the link in this rail without touching this file
//     (since the array is the source of truth).
//   - isActive uses STRICT equality (location.pathname === item.
//     path); the BottomNav is the mobile rail and its routes are
//     leaf pages, so startsWith() semantics aren't needed here
//     (unlike the desktop Sidebar's collapsible deep-routes).
//   - aria-current='page' on the active link + undefined on
//     others (NOT 'false' — see Sidebar / DesktopSidebar tests
//     for rationale); screen-readers announce current page only
//     via attribute presence.
//   - aria-label='Main navigation' on the <nav> root for
//     landmark navigation; each Link has aria-label=item.label
//     so the icon-only buttons have an accessible name (the
//     visible label is rendered via the active-dot, NOT as
//     visible text on each tab).
//   - Active-tab dot: framer-motion layoutId='mobile-nav-dot'
//     applied to a single span that follows the active tab; only
//     ONE tab renders the dot at any time; non-active tabs render
//     a transparent h-1 spacer to preserve vertical alignment so
//     the icons don't shift when the dot moves between tabs.
//   - Touch-target accessibility: each tab is min-w-44px + min-
//     h-44px (Apple HIG minimum tap target). Pinned in className
//     so a regression that shrunk the size would fail WCAG
//     touch-target-size criteria + iOS HIG.

beforeEach(() => {
  // framer-motion logs warnings in jsdom (no layout animations possible)
  // — silence for cleaner output.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
    </MemoryRouter>,
  );
}

import { BottomNav } from "./BottomNav";

// ───────────────────────────────────────────────────────────
//  Layout + tab rendering
// ───────────────────────────────────────────────────────────

describe("BottomNav — layout + tabs (§15.x)", () => {
  it("renders <nav> with aria-label='Main navigation'", () => {
    renderAt("/");
    expect(screen.getByLabelText("Main navigation")).toBeInTheDocument();
  });

  it("renders 5 tabs: Home / Send / Receive / Groups / More", () => {
    renderAt("/");
    expect(screen.getByLabelText("Home")).toBeInTheDocument();
    expect(screen.getByLabelText("Send")).toBeInTheDocument();
    expect(screen.getByLabelText("Receive")).toBeInTheDocument();
    expect(screen.getByLabelText("Groups")).toBeInTheDocument();
    expect(screen.getByLabelText("More")).toBeInTheDocument();
  });

  it("total link count is exactly 5", () => {
    renderAt("/");
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("each tab href pinned: '/', '/send', '/receive', '/groups', '/settings'", () => {
    renderAt("/");
    expect(
      (screen.getByLabelText("Home") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/");
    expect(
      (screen.getByLabelText("Send") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/send");
    expect(
      (screen.getByLabelText("Receive") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/receive");
    expect(
      (screen.getByLabelText("Groups") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/groups");
    expect(
      (screen.getByLabelText("More") as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/settings");
  });
});

// ───────────────────────────────────────────────────────────
//  Active state (aria-current + strict equality)
// ───────────────────────────────────────────────────────────

describe("BottomNav — active tab + aria-current (§15.x)", () => {
  it("at '/' -> Home tab has aria-current='page', others null", () => {
    renderAt("/");
    expect(screen.getByLabelText("Home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Send").getAttribute("aria-current")).toBeNull();
    expect(screen.getByLabelText("Receive").getAttribute("aria-current")).toBeNull();
  });

  it("at '/send' -> Send tab is current, Home is NOT", () => {
    renderAt("/send");
    expect(screen.getByLabelText("Send").getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Home").getAttribute("aria-current")).toBeNull();
  });

  it("at '/groups' -> Groups tab is current", () => {
    renderAt("/groups");
    expect(screen.getByLabelText("Groups").getAttribute("aria-current")).toBe("page");
  });

  it("at '/settings' -> More tab (mapped to /settings) is current", () => {
    renderAt("/settings");
    expect(screen.getByLabelText("More").getAttribute("aria-current")).toBe("page");
  });

  it("STRICT equality: at '/send/confirm' -> Send tab is NOT current (sub-route doesn't match)", () => {
    renderAt("/send/confirm");
    // Unlike DesktopSidebar (startsWith), BottomNav uses strict ===
    expect(screen.getByLabelText("Send").getAttribute("aria-current")).toBeNull();
  });

  it("unknown path '/nonexistent' -> NO tab has aria-current", () => {
    renderAt("/nonexistent");
    const allLinks = screen.getAllByRole("link");
    const currentLinks = allLinks.filter(
      (l) => l.getAttribute("aria-current") === "page",
    );
    expect(currentLinks).toHaveLength(0);
  });

  it("aria-current is undefined (not 'false') on non-active tabs", () => {
    renderAt("/send");
    // Use getAttribute() — null means attribute is absent from DOM
    expect(screen.getByLabelText("Home").getAttribute("aria-current")).toBeNull();
    expect(
      screen.getByLabelText("Home").hasAttribute("aria-current"),
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  Active dot (framer-motion layoutId)
// ───────────────────────────────────────────────────────────

describe("BottomNav — active dot (§15.x)", () => {
  it("active tab has a motion span (dot) child", () => {
    const { container } = renderAt("/");
    const homeLink = screen.getByLabelText("Home");
    // The motion.span renders as <span> in jsdom with the layoutId
    // attribute (framer doesn't actually animate without a real layout).
    const dot = homeLink.querySelector("span.w-1.h-1");
    expect(dot).not.toBeNull();
    expect(container).toBeDefined();
  });

  it("non-active tabs render the transparent spacer (NOT the dot)", () => {
    renderAt("/");
    // Send is non-active when at '/'
    const send = screen.getByLabelText("Send");
    const spacer = send.querySelector("span.h-1");
    expect(spacer).not.toBeNull();
    // No dot
    const dot = send.querySelector("span.w-1.h-1.bg-white");
    expect(dot).toBeNull();
  });

  it("only ONE active dot rendered at a time across all 5 tabs", () => {
    const { container } = renderAt("/send");
    // Count visible dots (w-1 h-1 with the white bg)
    const dots = container.querySelectorAll("span.w-1.h-1.bg-white");
    expect(dots).toHaveLength(1);
  });

  it("dot follows active tab: mount at '/' -> dot on Home; mount at '/send' -> dot on Send", () => {
    const { unmount } = renderAt("/");
    expect(
      screen.getByLabelText("Home").querySelector("span.w-1.h-1.bg-white"),
    ).not.toBeNull();
    expect(
      screen.getByLabelText("Send").querySelector("span.w-1.h-1.bg-white"),
    ).toBeNull();
    unmount();

    renderAt("/send");
    expect(
      screen.getByLabelText("Send").querySelector("span.w-1.h-1.bg-white"),
    ).not.toBeNull();
    expect(
      screen.getByLabelText("Home").querySelector("span.w-1.h-1.bg-white"),
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Touch-target accessibility (WCAG / iOS HIG)
// ───────────────────────────────────────────────────────────

describe("BottomNav — touch-target sizing (§15.x)", () => {
  it("each tab has min-w-[44px] + min-h-[44px] classes (Apple HIG minimum)", () => {
    renderAt("/");
    const allLinks = screen.getAllByRole("link");
    for (const link of allLinks) {
      expect(link.className).toContain("min-w-[44px]");
      expect(link.className).toContain("min-h-[44px]");
    }
  });
});
