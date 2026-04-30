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
