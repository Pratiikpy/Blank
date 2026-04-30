import { test, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Phase 6/verify — P2PExchange fillOffer, post-UUPS-upgrade.
//
// The fixture (hardhat setup-p2p-offer) pre-creates a USDT→USDC offer from
// the deployer EOA (maker). This test has the sender smart-account (taker,
// with USDC) fill that offer through the UI. Verifies the UUPS-upgraded
// P2PExchange impl no longer throws InvalidSigner on fillOffer (the
// original leave-behind bug).

const FIXTURE_PATH = path.resolve(
  __dirname, "..", "..", "contracts", "deployments", "base-sepolia-p2p-fixture.json",
);

interface P2PFixture {
  offerId: number;
  expiry: number;
  maker: string;
  give: string;
  want: string;
  tokenGive: string;
  tokenWant: string;
  txHash: string;
}

function loadFixture(): P2PFixture {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `P2P fixture missing — run: cd packages/contracts && npx hardhat setup-p2p-offer --network base-sepolia`,
    );
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

test.describe("P2PExchange fillOffer cross-account (post-upgrade)", () => {
  test.setTimeout(900_000);

  test("smart-account taker fills EOA-maker offer → offer row becomes filled", async ({ browser }) => {
    const setup = loadSetup();
    const fixture = loadFixture();
    const takerCtx = await openAccountPage(browser, setup.sender, setup.chainId, "T");

    try {
      const page = takerCtx.page;
      const takerLower = setup.sender.address.toLowerCase();

      // ─── Baseline: is the fixture offer still "active"? ─────────────
      const baselineRes = await page.request.get(
        `${SUPABASE_URL}/rest/v1/exchange_offers?offer_id=eq.${fixture.offerId}&select=status,taker_address`,
        { headers: { apikey: SUPABASE_ANON_KEY } },
      );
      const baselineRows = baselineRes.status() === 200 ? await baselineRes.json() : [];
      if (baselineRows.length === 0) {
        // Fixture row missing from Supabase — gracefully skip rather than
        // hard-fail. Surface a concrete remediation step so the operator
        // knows how to bring it back. CI runs that don't seed the fixture
        // shouldn't block the rest of the suite.
        test.skip(true, `P2P fixture offer ${fixture.offerId} not in Supabase — run \`pnpm hardhat setup-p2p-offer --network base-sepolia\` to refresh.`);
        return;
      }
      if (baselineRows[0].status !== "active") {
        // Same skip-rather-than-fail rationale as above. The fixture is
        // single-use: once filled, future runs need a fresh offerId.
        test.skip(true, `P2P fixture offer ${fixture.offerId} status="${baselineRows[0].status}" (already consumed) — run \`pnpm hardhat setup-p2p-offer --network base-sepolia\` for a fresh one.`);
        return;
      }
      console.log(`  [T] fixture offer #${fixture.offerId} is active, ready to fill`);

      await page.goto("/app/swap");
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // Swap page fetches offers from Supabase; give it time + force refetch
      await page.waitForTimeout(5_000);
      await page.reload();
      await page.waitForTimeout(8_000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p2p-fill-01-browse.png"), fullPage: true });

      // ─── Switch to the "All Offers" or "Browse" view ──────────────
      // The Swap screen typically defaults to "Create" or "My offers". We
      // need to find a tab/button that surfaces other makers' offers.
      await page.evaluate(() => {
        // Look for any tab/button labelled Browse/All/Available/Offers
        const candidates = Array.from(document.querySelectorAll("button, [role=tab]"));
        const target = candidates.find((b) =>
          /^(browse|all( offers)?|available|view offers|open offers)$/i.test(
            (b.textContent || "").trim(),
          ),
        );
        if (target) (target as HTMLElement).click();
      });
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p2p-fill-02-offers-tab.png"), fullPage: true });

      // ─── Find & click the Fill Offer button for our maker's offer ──
      const clickOk = await page.evaluate((makerAddr) => {
        // UI renders each offer card with maker truncated like "0xb860...c53F".
        // Match by the 6-char prefix to target our specific fixture offer.
        const prefix = makerAddr.slice(0, 6).toLowerCase();
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const b of buttons) {
          if (!/fill offer/i.test((b.textContent || "").trim())) continue;
          // Walk up to find the row, check if it contains our maker prefix.
          let node: Element | null = b;
          for (let i = 0; i < 6 && node; i++) {
            if ((node.textContent || "").toLowerCase().includes(prefix)) {
              (b as HTMLButtonElement).click();
              return { ok: true, matched: "maker+fill", prefix };
            }
            node = node.parentElement;
          }
        }
        // Fallback — any Fill Offer button
        const anyFill = buttons.find((b) => /fill offer/i.test((b.textContent || "").trim()));
        if (anyFill) {
          (anyFill as HTMLButtonElement).click();
          return { ok: true, matched: "first fill-offer button", prefix };
        }
        return {
          ok: false,
          why: "no Fill Offer button",
          available: buttons
            .slice(0, 30)
            .map((b) => (b.textContent || "").trim())
            .filter(Boolean),
        };
      }, fixture.maker);
      console.log("  [T] click result:", JSON.stringify(clickOk).slice(0, 300));
      expect(clickOk.ok, "taker must find Accept/Fill button").toBe(true);
      await page.waitForTimeout(2_000);

      // ─── Sign up to 3 prompts: warmup + approve(USDC vault→P2P) + fillOffer
      console.log("  [T] filling up to 3 prompts (warmup + vault-approve + fillOffer)...");
      for (let i = 0; i < 3; i++) {
        try {
          await answerPassphrasePrompt(page, PASSPHRASE, 90_000);
          console.log(`  [T] ✅ filled prompt #${i + 1}`);
        } catch {
          console.log(`  [T] no prompt #${i + 1} (already warmed / already approved)`);
          break;
        }
        await page.waitForTimeout(2_000);
      }

      // ─── Poll Supabase: offer should transition active → filled ────
      let finalStatus = "active";
      let finalTaker = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await page.request.get(
          `${SUPABASE_URL}/rest/v1/exchange_offers?offer_id=eq.${fixture.offerId}&select=status,taker_address`,
          { headers: { apikey: SUPABASE_ANON_KEY } },
        );
        if (res.status() === 200) {
          const rows = (await res.json()) as Array<{ status: string; taker_address: string }>;
          if (rows[0]?.status !== "active") {
            finalStatus = rows[0].status;
            finalTaker = rows[0].taker_address ?? "";
            break;
          }
        }
        if (attempt % 5 === 0) console.log(`  [T] poll[${attempt}] status still=active`);
        await page.waitForTimeout(3_000);
      }

      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "p2p-fill-03-after.png"), fullPage: true });
      console.log(`  [T] final status: ${finalStatus} taker=${finalTaker}`);
      expect(finalStatus, "offer status must become filled").toBe("filled");
      expect(finalTaker.toLowerCase()).toBe(takerLower);
      console.log("  ✅ P2PExchange.fillOffer verified post-upgrade");
    } finally {
      await takerCtx.context.close();
    }
  });
});
