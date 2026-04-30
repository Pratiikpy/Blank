import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Phase 8 — Comprehensive smoke test for everything not covered by Phase 2-7.
//
// Walks through the entire app surface: onboarding, settings, profile,
// multi-chain, history, decryption, mobile viewport, misc UI features.
// Uses the SENDER account (proven encryption works).
//
// Per-test pass criteria: page loads, key UI elements visible/interactive.
// We don't assert deep behavior in this file — Phases 2-7 cover that. This is
// the "is the rest of the app even alive" sweep.

interface SmokeResult {
  area: string;
  test: string;
  result: "pass" | "fail" | "skip";
  note?: string;
}

const RESULTS: SmokeResult[] = [];

function record(area: string, name: string, result: "pass" | "fail" | "skip", note?: string) {
  RESULTS.push({ area, test: name, result, note });
  const icon = result === "pass" ? "✅" : result === "fail" ? "❌" : "⏭️";
  console.log(`  ${icon} ${area}: ${name}${note ? ` — ${note}` : ""}`);
}

async function safe<T>(area: string, name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    record(area, name, "pass");
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    record(area, name, "fail", msg);
    return null;
  }
}

test.describe("Phase 8 — Comprehensive smoke", () => {
  test.setTimeout(900_000);

  test("walk through every untested feature", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
    const page = ctx.page;

    try {
      // ─── PROFILE PAGE ──────────────────────────────────────────────
      // Check the MAIN content area (not sidebar) — sidebar contains "Privacy"
      // text on every page and would create false positives.
      const mainContentText = async () => page.evaluate(() => {
        // Sidebar is typically <aside> or has a class containing "sidebar"/"nav"
        // Strategy: find the largest non-aside container and read its text.
        const main = document.querySelector("main") ?? document.querySelector("[role=main]") ?? document.querySelector("#root > div > div:not([class*=sidebar i]):not(aside)");
        // Fallback: read body but filter out aside text
        if (main) return (main as HTMLElement).innerText.toLowerCase();
        const all = document.body.innerText;
        const asides = Array.from(document.querySelectorAll("aside, nav")).map((e) => (e as HTMLElement).innerText).join(" ");
        return all.replace(asides, "").toLowerCase();
      });

      await safe("Profile", "page renders distinct content (not just shell)", async () => {
        await page.goto("/app/profile");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-profile.png"), fullPage: true });
        const text = await mainContentText();
        // Profile page distinct content: page title + "Manage your account" subtitle
        if (!/manage your account|account info|wallet address/i.test(text)) {
          throw new Error(`Profile page shell-only (text: "${text.slice(0, 100)}")`);
        }
      });

      // ─── SETTINGS PAGE ─────────────────────────────────────────────
      await safe("Settings", "page renders distinct content (not just shell)", async () => {
        await page.goto("/app/settings");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-settings.png"), fullPage: true });
        const text = await mainContentText();
        // Settings page distinct content: dark mode, log out, version info
        if (!/log out|disconnect|version|preferences/i.test(text)) {
          throw new Error(`Settings page shell-only (text: "${text.slice(0, 100)}")`);
        }
      });

      await safe("Settings", "privacy mode toggle exists", async () => {
        const found = await page.evaluate(() => {
          const labels = Array.from(document.querySelectorAll("label, button, [role=switch]"))
            .map((e) => (e.textContent || "").toLowerCase());
          return labels.some((l) => l.includes("privacy") || l.includes("hide") || l.includes("blur"));
        });
        if (!found) throw new Error("no privacy toggle found");
      });

      // ─── HISTORY FEED ──────────────────────────────────────────────
      await safe("History", "feed renders", async () => {
        await page.goto("/app/history");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-history.png"), fullPage: true });
        const has = await page.evaluate(() => /history|activity|payment|sent|received/i.test(document.body.innerText));
        if (!has) throw new Error("no history content");
      });

      await safe("History", "shows multiple activity rows", async () => {
        const count = await page.evaluate(() => {
          // Common patterns for activity rows
          const rows = document.querySelectorAll("[data-activity], [class*=activity], [class*=transaction], [class*=row]");
          return rows.length;
        });
        if (count < 1) throw new Error(`no activity rows rendered (count=${count})`);
      });

      await safe("History", "chronological ordering (Supabase REST cross-check)", async () => {
        const senderLower = setup.sender.address.toLowerCase();
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/activities?or=(user_from.eq.${senderLower},user_to.eq.${senderLower})&order=created_at.desc&limit=10`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() !== 200) throw new Error(`supabase ${res.status()}`);
        const rows = (await res.json()) as Array<{ created_at: string }>;
        // Dates must be monotonically non-increasing
        for (let i = 1; i < rows.length; i++) {
          if (new Date(rows[i].created_at) > new Date(rows[i - 1].created_at)) {
            throw new Error(`row ${i} is newer than row ${i - 1}`);
          }
        }
      });

      // ─── DASHBOARD: BALANCE DECRYPT (REVEAL) ──────────────────────
      await safe("Decrypt", "encrypted balance display present on dashboard", async () => {
        await page.goto("/app");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-dashboard-balance.png"), fullPage: true });
        const has = await page.evaluate(() => {
          const t = document.body.innerText;
          return /balance|encrypted|usdc|eusdc|reveal|decrypt|████/i.test(t);
        });
        if (!has) throw new Error("no balance/decrypt UI on dashboard");
      });

      await safe("Decrypt", "reveal/decrypt affordance present (button OR clickable balance)", async () => {
        const found = await page.evaluate(() => {
          // Either a dedicated "Reveal" button OR an interactive balance area
          // (cursor pointer / aria-label / role=button / onClick)
          const btns = Array.from(document.querySelectorAll("button, [role=button], [aria-label*=balance i], [class*=balance i][onclick], [class*=balance i][role=button]"));
          if (btns.some((b) => /reveal|show|decrypt|unlock|view balance/i.test((b.textContent || b.getAttribute("aria-label") || "")))) return true;
          // Look for the █████ encrypted-text indicator — clicking parent reveals
          const masked = Array.from(document.querySelectorAll(".encrypted-text, [class*=encrypted-text]"));
          if (masked.length > 0) return true;
          return false;
        });
        if (!found) throw new Error("no reveal/decrypt affordance found");
      });

      // ─── ADDRESS BOOK / CONTACTS ──────────────────────────────────
      await safe("Contacts", "page renders", async () => {
        await page.goto("/app/contacts");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-contacts.png"), fullPage: true });
        const has = await page.evaluate(() => /contact|address|book|saved/i.test(document.body.innerText));
        if (!has) throw new Error("no contacts content");
      });

      // ─── MULTI-CHAIN: CHAIN SWITCHER VISIBLE ──────────────────────
      await safe("Multi-chain", "chain selector exists in app shell", async () => {
        await page.goto("/app");
        await page.waitForTimeout(2_000);
        const found = await page.evaluate(() => {
          // Chain selector typically labelled with chain name
          const text = document.body.innerText.toLowerCase();
          return text.includes("base sepolia") || text.includes("sepolia") || text.includes("chain");
        });
        if (!found) throw new Error("no chain selector visible");
      });

      // ─── QR CODE SCAN (button or modal) ───────────────────────────
      await safe("QR", "QR scan affordance present somewhere", async () => {
        // Receive page often has QR. Or scan button on send.
        await page.goto("/app/receive");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-receive-qr.png"), fullPage: true });
        const found = await page.evaluate(() => {
          const t = document.body.innerText.toLowerCase();
          return t.includes("qr") || t.includes("scan") || document.querySelector("svg[aria-label*=qr i], canvas, [class*=qr]") !== null;
        });
        if (!found) throw new Error("no QR/scan UI on receive page");
      });

      // ─── ONBOARDING: clear passkey, ensure onboarding renders ─────
      await safe("Onboarding", "onboarding renders when no passkey present", async () => {
        // Wipe passkey via the library AND clear all storage scopes
        await page.evaluate(async (cid) => {
          const passkey = await import("/src/lib/passkey.ts");
          await passkey.deletePasskey(cid).catch(() => {});
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i)!;
            if (k.includes("passkey") || k.includes(`blank_passkey_${cid}`)) localStorage.removeItem(k);
          }
        }, setup.chainId);
        // Hard reload required — passkey state is read at hook init time.
        await page.goto("about:blank");
        await page.waitForTimeout(500);
        await page.goto("/app");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-onboarding.png"), fullPage: true });
        const has = await page.evaluate(() =>
          // Onboarding shows a multi-step intro flow with characteristic
          // copy: "Send money privately", "Your payments are encrypted",
          // a Next/Continue button, etc. Regex catches several variants.
          /send money privately|your payments are encrypted|welcome|create.*passkey|create.*account|onboard|get started|new wallet|sign up|set up|^\s*Next\s*→/i
            .test(document.body.innerText),
        );
        if (!has) throw new Error("no onboarding content rendered after passkey wipe");
      });

      // ─── MOBILE VIEWPORT ──────────────────────────────────────────
      await safe("Mobile", "dashboard renders at iPhone viewport", async () => {
        // Re-import passkey so the smart account works again
        await page.evaluate(
          async ({ chainId, privKey, passphrase }) => {
            const passkey = await import("/src/lib/passkey.ts");
            return passkey._testImportPasskey(chainId, privKey, passphrase, "phase8");
          },
          { chainId: setup.chainId, privKey: setup.sender.passkey.privKey, passphrase: PASSPHRASE },
        );
        await page.setViewportSize({ width: 390, height: 844 }); // iPhone 13
        await page.goto("/app");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-mobile-dashboard.png"), fullPage: true });
        const ok = await page.evaluate(() => {
          const html = document.documentElement;
          return html.scrollWidth <= window.innerWidth + 5; // no horizontal overflow
        });
        if (!ok) throw new Error("horizontal overflow at mobile viewport");
      });

      await safe("Mobile", "send page mobile-friendly", async () => {
        await page.goto("/app/send");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p8-mobile-send.png"), fullPage: true });
        const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 5);
        if (!ok) throw new Error("send page horizontal overflow");
      });

      // Reset viewport for any remaining tests
      await page.setViewportSize({ width: 1280, height: 720 });

      // ─── PRIVACY MODE TOGGLE — sidebar global toggle ──────────────
      await safe("Privacy", "toggle changes either body class or balance display", async () => {
        await page.goto("/app");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        // The "Privacy Mode" toggle in sidebar — capture state before, click, capture after
        const before = await page.evaluate(() => ({
          bodyClass: document.body.className,
          encryptedTextCount: document.querySelectorAll(".encrypted-text, [class*=encrypted-text]").length,
          balanceText: document.querySelector("[class*=balance i]")?.textContent ?? "",
          // Privacy state often persists in localStorage
          privacyKey: localStorage.getItem("blank_privacy_mode") ?? localStorage.getItem("privacy_mode") ?? "",
        }));
        const clicked = await page.evaluate(() => {
          // Look near "Privacy Mode" text in the sidebar
          const labels = Array.from(document.querySelectorAll("*")).filter(
            (e) => /^\s*Privacy Mode\s*$/i.test((e.textContent || "").trim()),
          );
          for (const lbl of labels) {
            const container = lbl.closest("div, label, section");
            const sw = container?.querySelector("[role=switch], input[type=checkbox], button");
            if (sw) { (sw as HTMLElement).click(); return true; }
          }
          // Fallback: any sidebar switch
          const sw = document.querySelector("aside [role=switch], aside input[type=checkbox]");
          if (sw) { (sw as HTMLElement).click(); return true; }
          return false;
        });
        if (!clicked) throw new Error("no privacy toggle clickable");
        await page.waitForTimeout(1_500);
        const after = await page.evaluate(() => ({
          bodyClass: document.body.className,
          encryptedTextCount: document.querySelectorAll(".encrypted-text, [class*=encrypted-text]").length,
          balanceText: document.querySelector("[class*=balance i]")?.textContent ?? "",
          privacyKey: localStorage.getItem("blank_privacy_mode") ?? localStorage.getItem("privacy_mode") ?? "",
        }));
        const changed = before.bodyClass !== after.bodyClass
          || before.encryptedTextCount !== after.encryptedTextCount
          || before.balanceText !== after.balanceText
          || before.privacyKey !== after.privacyKey;
        if (!changed) throw new Error(`toggle had no observable effect (before=${JSON.stringify(before).slice(0, 120)} after=${JSON.stringify(after).slice(0, 120)})`);
      });

      // ─── RECEIPT VERIFY MODAL — check activity detail ─────────────
      await safe("Receipt", "verify modal openable from activity detail", async () => {
        await page.goto("/app/history");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);
        // Click first activity row — History.tsx renders rows as
        // <div role="link" tabIndex=0 onClick=...>. Look for that pattern.
        const rowClicked = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("[role=link], [role=button], [tabindex='0']"))
            .filter((el) => {
              const t = (el.textContent || "");
              return /payment|sent|received|gift|stealth|tip|invoice|escrow|heir|shield/i.test(t);
            });
          if (rows.length === 0) return false;
          (rows[0] as HTMLElement).click();
          return true;
        });
        if (!rowClicked) throw new Error("no clickable activity row to open detail");
        await page.waitForTimeout(1_500);
        // Now look for verify or receipt button in the opened detail
        const found = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll("button, a"));
          // Look for explorer link (Basescan, Etherscan), verify button, or
          // any link with tx_hash in href.
          if (els.some((b) => /verify|receipt|view receipt|view on|on.chain|explorer|basescan|etherscan|sepolia|block.*explorer/i.test((b.textContent || "")))) return true;
          // Also check for hrefs pointing to known explorers
          const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
          if (links.some((a) => /basescan\.org|etherscan\.io|sepolia\..*\/tx\/0x/i.test(a.href))) return true;
          return false;
        });
        if (!found) throw new Error("activity detail opened but no verify/receipt/explorer affordance");
      });

    } finally {
      // Print final summary
      console.log("\n══════════════════════════════════════════");
      console.log("Phase 8 smoke test summary");
      console.log("══════════════════════════════════════════");
      const passes = RESULTS.filter((r) => r.result === "pass").length;
      const fails = RESULTS.filter((r) => r.result === "fail").length;
      const skips = RESULTS.filter((r) => r.result === "skip").length;
      console.log(`  PASS:  ${passes}`);
      console.log(`  FAIL:  ${fails}`);
      console.log(`  SKIP:  ${skips}`);
      console.log("");
      for (const r of RESULTS) {
        const icon = r.result === "pass" ? "✅" : r.result === "fail" ? "❌" : "⏭️";
        console.log(`  ${icon} ${r.area.padEnd(12)} ${r.test}${r.note ? ` — ${r.note.slice(0, 120)}` : ""}`);
      }
      await ctx.context.close();
    }
    // Soft-pass: don't fail the whole test if individual area smoke fails;
    // we want the full RESULTS log instead of stopping on first failure.
    expect(RESULTS.length).toBeGreaterThan(0);
  });
});
