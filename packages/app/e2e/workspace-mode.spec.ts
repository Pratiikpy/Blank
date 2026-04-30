// Workspace mode end-to-end — drives the picker through a real browser
// and asserts the desktop sidebar reshuffles as the registry promises.
//
// What the unit tests already cover:
//   * lib/nav-registry.test.ts — filterByMode / desktopSidebarItems /
//     mobileBottomItems return the correct subsets for each mode.
//   * lib/workspace-mode.test.ts — getMode / setMode / subscribe wire
//     localStorage, cross-tab broadcast, and same-tab dispatch correctly.
//
// What this spec adds: clicking the picker's <button> in Settings
// actually re-renders <DesktopSidebar> with the right nav buttons. The
// unit tests prove the data layer; this proves the React subscription
// + provider wiring keeps the UI in sync.
//
// Auth: piggybacks on the existing phase6 fixture passkey to bypass
// onboarding so /app/settings actually mounts.

import { test, expect, type Page } from "@playwright/test";
import { openAccountPage, loadSetup } from "./helpers/phase6-helpers";

const SETUP = loadSetup();

// Items expected to appear in the desktop sidebar's primary list per mode.
// Source of truth: lib/nav-registry.ts (NAV_REGISTRY entries with
// desktopPrimary: true). If this drifts, the registry changed and either
// this spec or the unit tests need updating.
const SIDEBAR_PRIMARY: Record<string, string[]> = {
  freelancer: [
    "Dashboard",
    "Send & Receive",
    "History",
    "Business Tools",
    "Smart Wallet",
    "Settings",
    "Help & FAQ",
  ],
  business: [
    "Dashboard",
    "Send & Receive",
    "History",
    "Business Tools",
    "Group Expenses",
    "P2P Exchange",
    "Smart Wallet",
    "Settings",
    "Help & FAQ",
  ],
  privacy: [
    "Dashboard",
    "Send & Receive",
    "History",
    "Stealth Payments",
    "Inheritance",
    "Encrypted Proofs",
    "Gift Envelopes",
    "Smart Wallet",
    "Settings",
    "Help & FAQ",
  ],
  full: [
    "Dashboard",
    "Send & Receive",
    "History",
    "Business Tools",
    "Group Expenses",
    "Creator Support",
    "P2P Exchange",
    "Stealth Payments",
    "Inheritance",
    "Encrypted Proofs",
    "Gift Envelopes",
    "AI Agents",
    "Smart Wallet",
    "Settings",
    "Help & FAQ",
  ],
};

// Items hidden from each mode that we explicitly assert should NOT
// appear — these are the ones the registry classifies as out-of-scope
// for the role and are the ones a user picking a mode actually cares
// about not seeing.
const SIDEBAR_HIDDEN: Record<string, string[]> = {
  freelancer: ["Group Expenses", "Stealth Payments", "Creator Support", "AI Agents"],
  business: ["Stealth Payments", "Creator Support", "AI Agents"],
  privacy: ["Business Tools", "Group Expenses", "P2P Exchange", "Creator Support"],
  full: [], // full mode shows everything
};

async function pickMode(page: Page, label: string) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.click();
}

async function assertSidebar(page: Page, mode: keyof typeof SIDEBAR_PRIMARY) {
  const sidebar = page.locator("aside.glass-sidebar");
  for (const label of SIDEBAR_PRIMARY[mode]) {
    await expect(
      sidebar.getByRole("button", { name: label, exact: true }),
      `mode=${mode} expected to show "${label}"`,
    ).toBeVisible();
  }
  for (const label of SIDEBAR_HIDDEN[mode]) {
    await expect(
      sidebar.getByRole("button", { name: label, exact: true }),
      `mode=${mode} expected to hide "${label}"`,
    ).toHaveCount(0);
  }
}

test.describe("Workspace mode end-to-end — sidebar adapts to the picked role", () => {
  // Picker click → re-render needs a full provider chain to wire up;
  // 60s is plenty but cofhe binding adds variance so we relax to 90s.
  test.setTimeout(90_000);

  test("each mode reshuffles the desktop sidebar to its expected nav set", async ({ browser }) => {
    const { context, page } = await openAccountPage(
      browser,
      SETUP.sender,
      SETUP.chainId,
      "ws-mode",
    );

    try {
      await page.goto("/app/settings");
      // The WorkspaceModePicker's <h2>/<p> copy lives inline; wait for any
      // of the four mode buttons to mount before we start clicking.
      await expect(page.getByRole("button", { name: "Freelancer", exact: true })).toBeVisible({
        timeout: 15_000,
      });

      const modes: Array<{ label: string; key: keyof typeof SIDEBAR_PRIMARY }> = [
        { label: "Freelancer", key: "freelancer" },
        { label: "Business", key: "business" },
        { label: "Privacy", key: "privacy" },
        { label: "Full", key: "full" },
      ];

      for (const { label, key } of modes) {
        await pickMode(page, label);
        // localStorage write is the source of truth — confirm before
        // checking the rendered sidebar so a render race doesn't false-fail.
        await expect
          .poll(
            () => page.evaluate(() => localStorage.getItem("blank_workspace_mode")),
            { timeout: 5_000 },
          )
          .toBe(key);
        await assertSidebar(page, key);
      }
    } finally {
      await Promise.race([
        context.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    }
  });
});
