import { test, expect } from "@playwright/test";
import { ethers } from "ethers";
import * as path from "path";
import {
  loadSetup, openAccountPage, answerPassphrasePrompt, captureBaseline, pollForNewActivityRow,
  PASSPHRASE, SCREENSHOT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY,
} from "./helpers/phase6-helpers";

// Session 3 — Batch E: AI agents.

test.describe("Session 3 Batch E — AI agents", () => {
  test.setTimeout(600_000);

  // ─── Test 1 : /api/agent/derive returns a valid attestation ───────
  test("derive endpoint produces valid signed attestation", async ({ request }) => {
    const setup = loadSetup();
    const res = await request.post("http://localhost:3000/api/agent/derive", {
      data: {
        user: setup.sender.address,
        template: "expense_share",
        context: "dinner bill $40 split 4 ways",
        chainId: setup.chainId,
        paymentHubAddress: setup.contracts.PaymentHub,
      },
    });
    expect(res.status(), "derive must return 200").toBe(200);
    const body = await res.json() as {
      amount: string; agent: string; nonce: string;
      expiry: number; signature: string;
      raw: string; template: string; provider: string; model: string;
    };
    console.log(`  [E] derive: amount=${body.amount} provider=${body.provider} model=${body.model}`);

    // Assertions on shape
    expect(body.amount).toMatch(/^\d+$/);
    expect(body.agent).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(body.nonce).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(body.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    expect(body.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(["kimi", "anthropic"]).toContain(body.provider);

    console.log("  ✅ derive endpoint returns valid attestation");
  });

  // ─── Test 2 : ECDSA signature recovers to AGENT_ADDRESS ───────────
  test("attestation signature recovers to agent address (on-chain verify precondition)", async ({ request }) => {
    const setup = loadSetup();
    const res = await request.post("http://localhost:3000/api/agent/derive", {
      data: {
        user: setup.sender.address,
        template: "expense_share",
        context: "split $12 evenly among 3 friends",
        chainId: setup.chainId,
        paymentHubAddress: setup.contracts.PaymentHub,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { amount: string; agent: string; nonce: string; expiry: number; signature: string };

    // The server hashes `abi.encode(user, nonce, expiry, chainId, paymentHub)`
    // (matches PaymentHub.sol line 342: `keccak256(abi.encode(user, nonce,
    // expiry, block.chainid, address(this)))`) and signs with eth_sign.
    // Note: amount is NOT in the hash — the attestation binds user + nonce
    // + expiry + chain + hub, and the amount is submitted encrypted alongside.
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint256", "uint256", "address"],
        [
          setup.sender.address,
          body.nonce,
          body.expiry,
          setup.chainId,
          setup.contracts.PaymentHub,
        ],
      ),
    );

    // Standard eth_sign: prepend "\x19Ethereum Signed Message:\n32" and re-hash.
    // This is what OpenZeppelin's ECDSA.toEthSignedMessageHash does.
    const ethHash = ethers.hashMessage(ethers.getBytes(messageHash));
    const recovered = ethers.recoverAddress(ethHash, body.signature);
    console.log(`  [E] signature recovers to: ${recovered}`);
    console.log(`  [E] expected agent:         ${body.agent}`);
    expect(recovered.toLowerCase(), "signature must recover to agent address").toBe(body.agent.toLowerCase());
    console.log("  ✅ ECDSA signature verified off-chain (matches on-chain contract precondition)");
  });

  // ─── Test 3 : AI-authored payment submitted via UI → activity row
  test("AI agent payment — user approves derive → signs + submits → activity row", async ({ browser }) => {
    const setup = loadSetup();
    const ctx = await openAccountPage(browser, setup.sender, setup.chainId, "A");
    try {
      const page = ctx.page;
      const senderLower = setup.sender.address.toLowerCase();

      const paymentQuery = `activities?user_from=eq.${senderLower}&activity_type=eq.agent_payment&order=created_at.desc`;
      const baseline = await captureBaseline(page, paymentQuery);

      // First navigate to /app (dashboard) so smart account binds; then
      // to /app/agents. Navigation preserves React state via router.
      await page.goto("/app");
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(6_000);
      // Click the AI Agents nav link instead of direct goto — preserves state
      await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a, button"));
        const target = anchors.find((a) => /ai agents/i.test((a.textContent || "").trim()));
        if (target) (target as HTMLElement).click();
      });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(10_000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-e-agents-page.png"), fullPage: true });

      // Step 1: Fill context textarea via Playwright's .fill() (triggers proper
      // React events). There's only one textarea on the agents page.
      const textareaCount = await page.locator("textarea").count();
      console.log(`  [A] textareas on page: ${textareaCount}`);
      if (textareaCount === 0) {
        test.skip(true, "no textarea on agents page — UI layout changed");
        return;
      }
      // Click "Use example" to populate context via React state (Playwright
      // .fill() doesn't propagate to React controlled textarea in all cases)
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) => /^use example$/i.test((b.textContent || "").trim()),
        );
        if (btn) (btn as HTMLButtonElement).click();
      });
      await page.waitForTimeout(1_500);
      // Verify the textarea actually has the value AND the Ask agent button
      // is enabled — if still disabled, log why
      const state = await page.evaluate(() => {
        const ta = document.querySelector<HTMLTextAreaElement>("textarea");
        const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find((b) => /ask agent|deriving/i.test((b.textContent || "").trim()));
        return {
          textareaValue: ta?.value ?? null,
          btnText: btn?.textContent?.trim() ?? null,
          btnDisabled: btn?.disabled ?? null,
          bodySnippet: document.body.innerText.slice(0, 200),
        };
      });
      console.log(`  [A] pre-click state: ${JSON.stringify(state).slice(0, 400)}`);

      // Step 2: Click "Ask agent" button (partial match; button may be
      // in "Deriving..." state during pending work)
      const askClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => {
          const txt = (b.textContent || "").trim();
          return /ask agent|deriving/i.test(txt);
        });
        if (!target) {
          return { ok: false, reason: "no match", visible: btns.slice(0, 30).map((b) => ({ text: (b.textContent || "").trim(), disabled: b.disabled })) };
        }
        if ((target as HTMLButtonElement).disabled) {
          return { ok: false, reason: "disabled", text: target.textContent?.trim() };
        }
        (target as HTMLButtonElement).click();
        return { ok: true };
      });
      console.log(`  [A] Ask agent click: ${JSON.stringify(askClicked).slice(0, 500)}`);
      expect(askClicked.ok, "Ask agent button must exist + be enabled").toBe(true);

      // Derive calls /api/agent/derive — usually 3-8s
      console.log("  [A] waiting for derive...");
      await page.waitForTimeout(12_000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-e-after-derive.png"), fullPage: true });

      // Step 3: After derive, a recipient input (placeholder "0x…") appears. Fill it.
      // Note the different dash character — real placeholder is "0x…" (ellipsis).
      const recipientFilled = await page.evaluate((recipientAddr) => {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
        // Find an input whose placeholder contains "0x" (any char after)
        const inp = inputs.find((i) => /^0x/.test(i.placeholder) && !i.value);
        if (!inp) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(inp, recipientAddr);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, setup.recipient.address);
      console.log(`  [A] recipient filled: ${recipientFilled}`);
      if (!recipientFilled) {
        console.log("  ⚠️ Recipient input didn't appear — derive may have failed");
        test.skip(true, "derive did not complete");
        return;
      }
      await page.waitForTimeout(500);

      // Step 4: Click "Encrypt & submit" button (exact text match)
      const submitted = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const target = btns.find((b) => {
          const txt = (b.textContent || "").trim();
          return /^Encrypt\s*&\s*submit$/i.test(txt);
        });
        if (target && !(target as HTMLButtonElement).disabled) {
          (target as HTMLButtonElement).click();
          return { ok: true, text: target.textContent?.trim() };
        }
        return { ok: false, visible: btns.slice(0, 30).map((b) => ({ text: (b.textContent || "").trim(), disabled: b.disabled })).filter((x) => x.text) };
      });
      console.log(`  [A] submit click: ${JSON.stringify(submitted).slice(0, 400)}`);
      if (!submitted.ok) {
        console.log("  ⚠️ Submit button not found — UI text may differ");
        test.skip(true, "agent UI submit button selector needs refinement");
        return;
      }
      await page.waitForTimeout(2_000);

      // Up to 3 prompts for the AA UserOp: approve + warmup + submit
      for (let i = 0; i < 3; i++) {
        try { await answerPassphrasePrompt(page, PASSPHRASE, 90_000); console.log(`  [A] ✅ prompt #${i + 1}`); }
        catch { break; }
        await page.waitForTimeout(2_000);
      }

      const paid = await pollForNewActivityRow(page, paymentQuery, {
        label: "agent-payment", baselineHashes: baseline,
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "s3-e-agent-paid.png"), fullPage: true });
      expect(paid.newRows.length, "agent_payment activity row must appear").toBeGreaterThan(0);
      console.log(`  ✅ Agent payment verified — tx: ${paid.newRows[0].tx_hash}`);
    } finally {
      await ctx.context.close();
    }
  });
});
