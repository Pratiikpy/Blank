import { describe, it, expect } from "vitest";
import {
  NAV_REGISTRY,
  filterByMode,
  desktopSidebarItems,
  mobileBottomItems,
  mobileMoreItems,
} from "./nav-registry";
import { WORKSPACE_MODES } from "./workspace-mode";

describe("nav-registry", () => {
  describe("invariants", () => {
    it("every item lists at least one mode (no orphans hidden everywhere)", () => {
      for (const item of NAV_REGISTRY) {
        expect(
          item.modes.length,
          `${item.path} declares zero modes — would never appear in nav`,
        ).toBeGreaterThan(0);
      }
    });

    it("every item declares modes that are valid", () => {
      const valid = new Set(WORKSPACE_MODES);
      for (const item of NAV_REGISTRY) {
        for (const m of item.modes) {
          expect(
            valid.has(m),
            `${item.path} references unknown mode "${m}"`,
          ).toBe(true);
        }
      }
    });

    it("paths are unique", () => {
      const seen = new Set<string>();
      for (const item of NAV_REGISTRY) {
        expect(seen.has(item.path), `duplicate path ${item.path}`).toBe(false);
        seen.add(item.path);
      }
    });

    it("Full mode is a superset — every nav item appears in Full", () => {
      for (const item of NAV_REGISTRY) {
        expect(
          item.modes.includes("full"),
          `${item.path} missing from Full mode`,
        ).toBe(true);
      }
    });
  });

  describe("filterByMode", () => {
    it("Full returns every item", () => {
      expect(filterByMode("full").length).toBe(NAV_REGISTRY.length);
    });

    it("Freelancer is a strict subset of Full", () => {
      const freelancer = new Set(filterByMode("freelancer").map((i) => i.path));
      const full = new Set(filterByMode("full").map((i) => i.path));
      for (const path of freelancer) {
        expect(full.has(path)).toBe(true);
      }
      // …and is smaller (otherwise the mode is meaningless).
      expect(freelancer.size).toBeLessThan(full.size);
    });

    it("Business is a strict subset of Full", () => {
      const business = new Set(filterByMode("business").map((i) => i.path));
      const full = new Set(filterByMode("full").map((i) => i.path));
      for (const path of business) {
        expect(full.has(path)).toBe(true);
      }
      expect(business.size).toBeLessThan(full.size);
    });

    it("Privacy is a strict subset of Full", () => {
      const privacy = new Set(filterByMode("privacy").map((i) => i.path));
      const full = new Set(filterByMode("full").map((i) => i.path));
      for (const path of privacy) {
        expect(full.has(path)).toBe(true);
      }
      expect(privacy.size).toBeLessThan(full.size);
    });

    it("Account essentials (Profile/Wallet/Settings/Help) appear in every mode", () => {
      const essentials = ["/app/profile", "/app/wallet", "/app/settings", "/app/help"];
      for (const mode of WORKSPACE_MODES) {
        const paths = filterByMode(mode).map((i) => i.path);
        for (const e of essentials) {
          expect(
            paths.includes(e),
            `${e} missing from ${mode} mode — every mode needs core account screens`,
          ).toBe(true);
        }
      }
    });

    it("Dashboard, Send, History always appear (core)", () => {
      const core = ["/app", "/app/send", "/app/history"];
      for (const mode of WORKSPACE_MODES) {
        const paths = filterByMode(mode).map((i) => i.path);
        for (const c of core) {
          expect(
            paths.includes(c),
            `${c} missing from ${mode} mode — core surface must always show`,
          ).toBe(true);
        }
      }
    });

    it("Freelancer mode focuses on payments + receivables", () => {
      const paths = filterByMode("freelancer").map((i) => i.path);
      expect(paths).toContain("/app/business");  // invoices
      expect(paths).toContain("/app/contacts");
      expect(paths).toContain("/app/requests");
      // Hides payroll-heavy + privacy-leading features
      expect(paths).not.toContain("/app/groups");
      expect(paths).not.toContain("/app/stealth");
      expect(paths).not.toContain("/app/burners");
    });

    it("Business mode adds payroll/escrow/groups/analytics", () => {
      const paths = filterByMode("business").map((i) => i.path);
      expect(paths).toContain("/app/business");
      expect(paths).toContain("/app/groups");
      expect(paths).toContain("/app/analytics");
      expect(paths).toContain("/app/swap");
    });

    it("Privacy mode leads with stealth/burners/inheritance/proofs", () => {
      const paths = filterByMode("privacy").map((i) => i.path);
      expect(paths).toContain("/app/stealth");
      expect(paths).toContain("/app/burners");
      expect(paths).toContain("/app/inheritance");
      expect(paths).toContain("/app/proofs");
      expect(paths).toContain("/app/privacy");
    });
  });

  describe("desktopSidebarItems", () => {
    it("only returns items with desktopPrimary=true", () => {
      for (const mode of WORKSPACE_MODES) {
        for (const item of desktopSidebarItems(mode)) {
          expect(item.desktopPrimary).toBe(true);
        }
      }
    });
  });

  describe("mobileBottomItems / mobileMoreItems", () => {
    it("are disjoint within a mode (no item shows both as a bottom tab and in More)", () => {
      for (const mode of WORKSPACE_MODES) {
        const bottom = new Set(mobileBottomItems(mode).map((i) => i.path));
        for (const m of mobileMoreItems(mode)) {
          expect(
            bottom.has(m.path),
            `${m.path} duplicated in bottom-nav and More for mode=${mode}`,
          ).toBe(false);
        }
      }
    });

    it("union covers every visible item (nothing inaccessible from mobile)", () => {
      for (const mode of WORKSPACE_MODES) {
        const visible = new Set(filterByMode(mode).map((i) => i.path));
        const reachable = new Set([
          ...mobileBottomItems(mode).map((i) => i.path),
          ...mobileMoreItems(mode).map((i) => i.path),
        ]);
        for (const path of visible) {
          expect(
            reachable.has(path),
            `${path} visible in mode=${mode} but not reachable from mobile nav`,
          ).toBe(true);
        }
      }
    });
  });
});

// §15.x extension: NavItem structural invariants + mobile bottom-nav
// cap + category coverage + desktop sidebar order + size floors. The
// registry drives every navigation surface (desktop sidebar + mobile
// bottom tabs + mobile More sheet) so a malformed entry would break
// the whole nav of the matching mode. The mobile bottom-nav has a
// HARD constraint of max 4 tabs (the 5th slot is reserved for "More")
// per iOS / Material design — a regression that overflowed this would
// produce a scrollable bottom-nav which is a UX failure mode.

const VALID_CATEGORIES = ["core", "payments", "privacy", "tools", "account"] as const;
const MOBILE_BOTTOM_NAV_MAX = 4;

describe("nav-registry — NavItem structural invariants", () => {
  it("every item has a non-empty label", () => {
    for (const item of NAV_REGISTRY) {
      expect(item.label, `${item.path} has empty label`).toBeTruthy();
      expect(typeof item.label).toBe("string");
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("every item declares a category in the documented union (core/payments/privacy/tools/account)", () => {
    for (const item of NAV_REGISTRY) {
      expect(
        VALID_CATEGORIES,
        `${item.path} has unknown category "${item.category}"`,
      ).toContain(item.category);
    }
  });

  it("every item has a non-null icon (lucide component function)", () => {
    for (const item of NAV_REGISTRY) {
      expect(item.icon, `${item.path} has null icon`).toBeTruthy();
      // Lucide icons are React components; they must be callable.
      expect(typeof item.icon === "function" || typeof item.icon === "object").toBe(true);
    }
  });

  it("path format: either empty (Dashboard's '/app' index) or starts with '/'", () => {
    for (const item of NAV_REGISTRY) {
      // The actual path is /app prepended by the consumer; the
      // registry's path entries either equal "/app" (the bare root)
      // or start with "/app/".
      expect(item.path === "/app" || item.path.startsWith("/app/")).toBe(true);
    }
  });

  it("every category appears at least once (no orphaned category in the type union)", () => {
    const seen = new Set(NAV_REGISTRY.map((i) => i.category));
    for (const cat of VALID_CATEGORIES) {
      expect(seen, `category "${cat}" has zero items`).toContain(cat);
    }
  });
});

describe("nav-registry — mobile bottom-nav 4-tab cap", () => {
  it("EVERY mode produces at most 4 mobile bottom-nav items (the 5th slot is 'More')", () => {
    for (const mode of WORKSPACE_MODES) {
      const bottomCount = mobileBottomItems(mode).length;
      expect(
        bottomCount,
        `mode=${mode} has ${bottomCount} bottom-nav items — overflows the 4-tab cap`,
      ).toBeLessThanOrEqual(MOBILE_BOTTOM_NAV_MAX);
    }
  });

  it("EVERY mode produces at least 1 mobile bottom-nav item (don't ship an empty bottom-nav)", () => {
    for (const mode of WORKSPACE_MODES) {
      expect(
        mobileBottomItems(mode).length,
        `mode=${mode} has zero bottom-nav items`,
      ).toBeGreaterThan(0);
    }
  });

  it("mobile bottom-nav items all have mobilePrimary=true (source of truth lives on the NavItem)", () => {
    for (const mode of WORKSPACE_MODES) {
      for (const item of mobileBottomItems(mode)) {
        expect(
          item.mobilePrimary,
          `${item.path} in bottom-nav for mode=${mode} but mobilePrimary is falsy`,
        ).toBe(true);
      }
    }
  });

  it("Dashboard ('/app') is always the FIRST mobile bottom-nav item across all modes (the home anchor)", () => {
    for (const mode of WORKSPACE_MODES) {
      const bottom = mobileBottomItems(mode);
      expect(bottom[0]?.path, `mode=${mode} doesn't start with Dashboard`).toBe("/app");
    }
  });
});

describe("nav-registry — mode size floors (sentinel for accidental category drops)", () => {
  it("every mode has at least 8 visible items (don't ship a near-empty nav)", () => {
    for (const mode of WORKSPACE_MODES) {
      expect(
        filterByMode(mode).length,
        `mode=${mode} has fewer than 8 items — likely an accidental category drop`,
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it("Full mode has at least 15 items (the maximalist mode)", () => {
    expect(filterByMode("full").length).toBeGreaterThanOrEqual(15);
  });
});

describe("nav-registry — desktop sidebar invariants", () => {
  it("Dashboard appears in the desktop sidebar in every mode", () => {
    for (const mode of WORKSPACE_MODES) {
      const paths = desktopSidebarItems(mode).map((i) => i.path);
      expect(
        paths,
        `mode=${mode} desktop sidebar missing Dashboard`,
      ).toContain("/app");
    }
  });

  it("desktop sidebar is a subset of filterByMode (only mode-visible items can appear)", () => {
    for (const mode of WORKSPACE_MODES) {
      const visible = new Set(filterByMode(mode).map((i) => i.path));
      for (const sidebarItem of desktopSidebarItems(mode)) {
        expect(
          visible,
          `${sidebarItem.path} in desktop sidebar but not visible in mode=${mode}`,
        ).toContain(sidebarItem.path);
      }
    }
  });

  it("desktop sidebar has at least 5 items per mode (don't ship a 1-link sidebar)", () => {
    for (const mode of WORKSPACE_MODES) {
      expect(
        desktopSidebarItems(mode).length,
        `mode=${mode} desktop sidebar has fewer than 5 items`,
      ).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("nav-registry — category-of-path expectations (UX consistency)", () => {
  // Spot-check that path-to-category mapping makes editorial sense.
  // A regression that recategorized /app/send as "account" or
  // /app/profile as "payments" would silently scramble the sidebar
  // grouping with no visible compile error.
  const PATH_CATEGORY_PINS: ReadonlyArray<{ path: string; category: string }> = [
    { path: "/app", category: "core" },
    { path: "/app/send", category: "core" },
    { path: "/app/history", category: "core" },
    { path: "/app/profile", category: "account" },
    { path: "/app/wallet", category: "account" },
    { path: "/app/settings", category: "account" },
    { path: "/app/help", category: "account" },
  ];

  it("known paths map to their expected categories", () => {
    for (const pin of PATH_CATEGORY_PINS) {
      const item = NAV_REGISTRY.find((i) => i.path === pin.path);
      expect(item, `${pin.path} not found in registry`).toBeTruthy();
      expect(
        item!.category,
        `${pin.path} category drift (expected ${pin.category}, got ${item!.category})`,
      ).toBe(pin.category);
    }
  });
});
