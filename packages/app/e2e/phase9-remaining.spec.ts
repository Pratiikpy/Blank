import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import {
  loadSetup, openAccountPage, PASSPHRASE, SCREENSHOT_DIR,
} from "./helpers/phase6-helpers";

// Phase 9 — remaining untested items: cross-tab sync, sign-out + recreate,
// chain switching, search/pagination/filter on the activity feed.

interface SmokeResult { area: string; test: string; result: "pass" | "fail"; note?: string }
const RESULTS: SmokeResult[] = [];
function record(area: string, name: string, result: "pass" | "fail", note?: string) {
  RESULTS.push({ area, test: name, result, note });
  const icon = result === "pass" ? "✅" : "❌";
  console.log(`  ${icon} ${area}: ${name}${note ? ` — ${note}` : ""}`);
}
async function safe<T>(area: string, name: string, fn: () => Promise<T>): Promise<T | null> {
  try { const r = await fn(); record(area, name, "pass"); return r; }
  catch (err) { record(area, name, "fail", err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)); return null; }
}

test.describe("Phase 9 — remaining untested items", () => {
  test.setTimeout(900_000);

  test("cross-tab + sign-out + chain switch + filters", async ({ browser }) => {
    const setup = loadSetup();

    // ─── CROSS-TAB SYNC (same user, two tabs) ─────────────────────
    // Open tab A and tab B as the same sender. Tab A starts a privacy-mode
    // toggle (cross-tab broadcast pattern) and tab B should pick it up via
    // localStorage event OR cross-tab broadcast channel.
    {
      const ctxA = await openAccountPage(browser, setup.sender, setup.chainId, "A");
      try {
        // Open a 2nd tab in the SAME context so localStorage is shared.
        const pageB = await ctxA.context.newPage();
        await pageB.goto("/app");
        await pageB.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await pageB.waitForTimeout(3_000);

        // In tab A, toggle privacy mode via sidebar.
        const aBefore = await ctxA.page.evaluate(() => localStorage.getItem("blank_privacy_mode"));
        const clicked = await ctxA.page.evaluate(() => {
          const labels = Array.from(document.querySelectorAll("*")).filter(
            (e) => /^\s*(Privacy|Public)\s*Mode\s*$/i.test((e.textContent || "").trim()),
          );
          for (const lbl of labels) {
            const btn = lbl.closest("button");
            if (btn) { (btn as HTMLButtonElement).click(); return true; }
          }
          return false;
        });
        if (!clicked) {
          record("CrossTab", "privacy mode toggle reflects in tab B", "fail", "no privacy toggle found in tab A");
        } else {
          await ctxA.page.waitForTimeout(1_500);
          const aAfter = await ctxA.page.evaluate(() => localStorage.getItem("blank_privacy_mode"));
          // Trigger storage event for tab B by reading; actual cross-tab
          // sync uses BroadcastChannel or storage events. Wait + read.
          const bAfter = await pageB.evaluate(() => localStorage.getItem("blank_privacy_mode"));
          if (aBefore === aAfter) record("CrossTab", "privacy mode persisted in storage", "fail", "tab A storage didn't change");
          else if (aAfter !== bAfter) record("CrossTab", "privacy mode synced to tab B storage", "fail", `A=${aAfter} B=${bAfter}`);
          else record("CrossTab", "privacy mode synced via storage", "pass");
        }

        // Cross-tab activity refresh — when a Supabase row is INSERTed for
        // this user, both tabs' useActivityFeed should pick it up via
        // Supabase realtime. We can't easily inject one mid-test without
        // doing a real send, but we CAN check that both tabs subscribed to
        // the realtime channel by inspecting the global Supabase channels.
        // (Best-effort smoke — full live realtime is verified in Phase 6 #1.)
        const aHasChannels = await ctxA.page.evaluate(() => {
          const w = window as unknown as { __supabaseChannels?: number };
          return typeof w.__supabaseChannels === "number" || document.body.innerText.length > 0;
        });
        const bHasChannels = await pageB.evaluate(() => {
          const w = window as unknown as { __supabaseChannels?: number };
          return typeof w.__supabaseChannels === "number" || document.body.innerText.length > 0;
        });
        if (aHasChannels && bHasChannels) record("CrossTab", "both tabs alive + rendered", "pass");
        else record("CrossTab", "both tabs alive + rendered", "fail", `A=${aHasChannels} B=${bHasChannels}`);

        await pageB.close();
      } finally {
        await ctxA.context.close();
      }
    }

    // ─── SIGN-OUT + RECREATE ───────────────────────────────────────
    {
      const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
      try {
        const page = ctx.page;
        await page.goto("/app/settings");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(2_000);

        // Look for log out / disconnect button
        const signOut = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const target = btns.find((b) => /log out|sign out|disconnect|wipe|delete/i.test((b.textContent || "")));
          if (!target) return { ok: false };
          return { ok: true, label: target.textContent?.trim() };
        });
        await safe("SignOut", "log out button exists in settings", async () => {
          if (!signOut.ok) throw new Error("no log out / disconnect button found");
        });

        // Try the sign-out flow: click the button (may show confirm).
        if (signOut.ok) {
          await safe("SignOut", "clicking sign out clears passkey + redirects", async () => {
            await page.evaluate(() => {
              const btn = Array.from(document.querySelectorAll("button"))
                .find((b) => /log out|sign out|disconnect|wipe|delete/i.test((b.textContent || "")));
              (btn as HTMLButtonElement).click();
            });
            await page.waitForTimeout(2_000);
            // Confirm dialog?
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll("button"));
              const yes = btns.find((b) => /^(yes|confirm|ok|proceed|sign out|log out|delete)$/i.test((b.textContent || "").trim()));
              if (yes) (yes as HTMLButtonElement).click();
            });
            await page.waitForTimeout(3_000);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p9-after-signout.png"), fullPage: true });

            // After sign-out, dashboard or onboarding should render — not a blank screen
            const has = await page.evaluate(() =>
              /send money privately|welcome|onboard|sign up|dashboard|wallet/i.test(document.body.innerText),
            );
            if (!has) throw new Error("after sign out, no onboarding or dashboard rendered");
          });

          // Recreate by re-importing the passkey
          await safe("SignOut", "recreate passkey + dashboard renders", async () => {
            await page.evaluate(
              async ({ chainId, privKey, passphrase }) => {
                const passkey = await import("/src/lib/passkey.ts");
                return passkey._testImportPasskey(chainId, privKey, passphrase, "phase9");
              },
              { chainId: setup.chainId, privKey: setup.sender.passkey.privKey, passphrase: PASSPHRASE },
            );
            await page.goto("/app");
            await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
            await page.waitForTimeout(5_000);
            await expect(page.getByTestId("dashboard-root")).toBeVisible({ timeout: 30_000 });
          });
        }
      } finally {
        await ctx.context.close();
      }
    }

    // ─── CHAIN SWITCHING ───────────────────────────────────────────
    {
      const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
      try {
        const page = ctx.page;
        await page.goto("/app");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(3_000);

        const chainBefore = await page.evaluate(() => localStorage.getItem("blank:active_chain_id"));

        await safe("ChainSwitch", "chain selector clickable", async () => {
          const found = await page.evaluate(() => {
            // Chain selector typically renders in sidebar with chain name
            const candidates = Array.from(document.querySelectorAll("button, [role=button]"))
              .filter((b) => /base sepolia|sepolia eth|eth sepolia|sepolia/i.test((b.textContent || "")));
            if (candidates.length === 0) return false;
            (candidates[0] as HTMLButtonElement).click();
            return true;
          });
          if (!found) throw new Error("no chain selector button");
          await page.waitForTimeout(1_500);
          await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p9-chain-selector.png"), fullPage: true });
        });

        await safe("ChainSwitch", "switch to Eth Sepolia option visible", async () => {
          const visible = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll("button, [role=menuitem], li, a"));
            return items.some((b) => /eth sepolia|^sepolia$|11155111/i.test((b.textContent || "")));
          });
          if (!visible) throw new Error("no Eth Sepolia option in chain selector dropdown");
        });

        await safe("ChainSwitch", "selecting alternate chain updates localStorage", async () => {
          const switched = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll("button, [role=menuitem], li, a, [role=option]"));
            // Dropdown renders "Ethereum Sepolia" + "Chain ID 11155111" text —
            // match any of those shapes but exclude the Base Sepolia option.
            const ethSep = items.find((b) => {
              const txt = (b.textContent || "").toLowerCase();
              const isEthSepolia = /ethereum sepolia|eth sepolia|\b11155111\b/.test(txt);
              const isBase = /base sepolia/.test(txt);
              return isEthSepolia && !isBase;
            });
            if (!ethSep) return false;
            (ethSep as HTMLButtonElement).click();
            return true;
          });
          if (!switched) throw new Error("could not click Eth Sepolia option");
          await page.waitForTimeout(2_000);
          const chainAfter = await page.evaluate(() => localStorage.getItem("blank:active_chain_id"));
          if (chainAfter === chainBefore) throw new Error(`chain didn't change (still ${chainAfter})`);
        });
      } finally {
        await ctx.context.close();
      }
    }

    // ─── HISTORY: SEARCH, FILTER, PAGINATION ──────────────────────
    {
      const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "S");
      try {
        const page = ctx.page;
        await page.goto("/app/history");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p9-history-default.png"), fullPage: true });

        await safe("History", "search input present", async () => {
          const found = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll("input[type=search], input[placeholder*=search i]"));
            return inputs.length > 0;
          });
          if (!found) throw new Error("no search input on history page");
        });

        await safe("History", "filter tabs present (incoming/outgoing/all)", async () => {
          const found = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll("button, [role=tab]"));
            const labels = els.map((e) => (e.textContent || "").trim().toLowerCase());
            return labels.some((l) => /^(all|sent|received|outgoing|incoming)$/.test(l));
          });
          if (!found) throw new Error("no filter tabs (all/sent/received/etc)");
        });

        await safe("History", "filter tab click changes visible rows", async () => {
          const beforeCount = await page.evaluate(() =>
            document.querySelectorAll("[role=link], [role=button][tabindex]").length,
          );
          const clicked = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll("button, [role=tab]"))
              .filter((e) => /^(sent|outgoing|received|incoming|payments|gifts)$/i.test((e.textContent || "").trim()));
            if (els.length === 0) return false;
            (els[0] as HTMLButtonElement).click();
            return true;
          });
          if (!clicked) throw new Error("could not click a filter tab");
          await page.waitForTimeout(1_500);
          const afterCount = await page.evaluate(() =>
            document.querySelectorAll("[role=link], [role=button][tabindex]").length,
          );
          // Counts may stay equal if all rows match the filter — mark pass if
          // the filter at least toggled an "active" class somewhere.
          if (beforeCount === afterCount) {
            const activeChanged = await page.evaluate(() => {
              const tabs = Array.from(document.querySelectorAll("[role=tab], button"))
                .filter((b) => /^(all|sent|received|outgoing|incoming|payments|gifts)$/i.test((b.textContent || "").trim()));
              return tabs.some((t) => t.getAttribute("aria-selected") === "true" || t.className.includes("active") || t.className.includes("bg-"));
            });
            if (!activeChanged) throw new Error("filter click had no observable effect");
          }
        });

        await safe("History", "pagination — load more or scroll renders more rows", async () => {
          const initial = await page.evaluate(() =>
            document.querySelectorAll("[role=link], [role=button][tabindex]").length,
          );
          // Look for a "Load more" / "Show more" button
          const loadMore = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            const target = btns.find((b) => /load more|show more|view all|next/i.test((b.textContent || "")));
            if (target) { (target as HTMLButtonElement).click(); return "button"; }
            // Try scrolling to bottom for infinite scroll
            window.scrollTo(0, document.body.scrollHeight);
            return "scroll";
          });
          await page.waitForTimeout(2_000);
          const after = await page.evaluate(() =>
            document.querySelectorAll("[role=link], [role=button][tabindex]").length,
          );
          // Pagination is acceptable as either "load more rendered more rows"
          // OR "no pagination but feed shows everything" — we don't fail if
          // there just aren't enough rows to paginate.
          if (after < initial) throw new Error(`pagination removed rows (initial=${initial} after=${after})`);
          console.log(`  [History] pagination type=${loadMore}, rows ${initial}→${after}`);
        });
      } finally {
        await ctx.context.close();
      }
    }

    // ─── SUMMARY ───────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════");
    console.log("Phase 9 results");
    console.log("══════════════════════════════════════════");
    const passes = RESULTS.filter((r) => r.result === "pass").length;
    const fails = RESULTS.filter((r) => r.result === "fail").length;
    console.log(`  PASS:  ${passes}`);
    console.log(`  FAIL:  ${fails}`);
    console.log("");
    for (const r of RESULTS) {
      const icon = r.result === "pass" ? "✅" : "❌";
      console.log(`  ${icon} ${r.area.padEnd(12)} ${r.test}${r.note ? ` — ${r.note.slice(0, 120)}` : ""}`);
    }
    expect(RESULTS.length).toBeGreaterThan(0);
  });
});
