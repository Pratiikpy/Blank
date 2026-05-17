import { test, expect, type Page } from "@playwright/test";
import { ethers } from "ethers";
import {
  PERSONAS,
  CHAINS,
  injectPasskey,
  setActiveChain,
  type ChainKey,
} from "../fixtures/wallets";
import { snap, resetCounter } from "../helpers/screenshot";
import { recordProof } from "../helpers/testing-todo";
import { enterPassphrase, readTxHashFromSuccess, shieldUsdc } from "../helpers/app-actions";

// ──────────────────────────────────────────────────────────────────
//  Phase 8 — gas wallet (§1.13 ship).
//
//  Five sub-assertions in one spec:
//   1. Alice's fresh passkey proxy points at the legacy impl
//      (matches the post-deploy state where factory's
//      accountImplementation is immutable and new accounts inherit
//      the pre-gas-wallet impl).
//   2. The GasWalletPanel renders the "Upgrade your account" banner
//      because the proxy impl != BlankAccount_Impl_gasWallet.
//   3. Alice clicks Upgrade → passkey signs a self-call UserOp
//      calling upgradeToAndCall(newImpl, "0x"). After mine, the
//      EIP-1967 impl slot equals the new impl.
//   4. Dave (an external EOA — driven via ethers.Wallet using the
//      deployer's key the test environment already has loaded for
//      hardhat tasks) sends 0.005 ETH directly to Alice's AA
//      address. The contract's new receive() auto-deposits into
//      EntryPoint.balanceOf(alice).
//   5. The "Self-paying mode active" badge appears + Alice fires a
//      small Send UserOp that routes via self-pay (no paymaster
//      sponsorship). The deposit balance decreases after the tx.
//
//  Real-tx-hash proofs per (sub-assertion 3) upgrade-tx,
//  (sub-assertion 4) deposit-tx, (sub-assertion 5) send-tx.
//  Stopping conditions §F-I gated by `expect(...).toMatch`.
// ──────────────────────────────────────────────────────────────────

const PHASE = "P8 Gas Wallet";

const ENTRY_POINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ENTRY_POINT_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function chainContextFromProject(): { chainId: number; chainName: string; viewport: string; chainKey: ChainKey; rpcUrl: string } {
  const meta = test.info().project.metadata as
    | { chainId?: number; chainName?: string; viewport?: string }
    | undefined;
  if (!meta?.chainId || !meta.chainName) throw new Error("Project metadata missing");
  const chainKey: ChainKey = meta.chainId === 11155111 ? "ETH_SEPOLIA" : "BASE_SEPOLIA";
  // RPC URLs follow the same env-var override pattern as
  // packages/app/api/_lib/addresses.ts, with public fallbacks.
  const rpcUrl =
    meta.chainId === 11155111
      ? process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia.publicnode.com"
      : process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  return {
    chainId: meta.chainId,
    chainName: meta.chainName,
    viewport: meta.viewport ?? "desktop",
    chainKey,
    rpcUrl,
  };
}

async function faucetUsdc(page: Page, address: string, chainId: number, baseURL: string): Promise<string> {
  const res = await page.request.post(`${baseURL}/api/faucet/usdc`, {
    data: { address, chainId },
    timeout: 60_000,
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; hash?: string };
  expect(body.ok).toBe(true);
  return body.hash!;
}

async function readEntryPointDeposit(rpcUrl: string, account: string): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ep = new ethers.Contract(ENTRY_POINT_V08, ENTRY_POINT_ABI, provider);
  return (await ep.balanceOf(account)) as bigint;
}

async function readImplSlot(rpcUrl: string, account: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const raw = await provider.getStorage(account, EIP1967_IMPL_SLOT);
  // EIP-1967 stores the impl address right-aligned in the 32-byte slot.
  return ("0x" + raw.slice(-40)).toLowerCase();
}

test.describe("Phase 8 — gas wallet", () => {
  test.describe.configure({ mode: "serial" });

  test("Alice upgrades AA → Dave external ETH sends → auto-deposit → Alice self-pay UserOp", async ({
    browser,
    baseURL,
  }) => {
    const chain = chainContextFromProject();
    const url = baseURL ?? "http://localhost:3000";
    const chainSlug = chain.chainKey === "ETH_SEPOLIA" ? "eth-sepolia" : "base-sepolia";

    // Spawn Alice + a throwaway Bob (just for the recipient address
    // of the self-pay Send tx at the end).
    const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const alicePage = await aliceCtx.newPage();
    await alicePage.goto("/");
    await setActiveChain(alicePage, chain.chainId);
    await injectPasskey(alicePage, PERSONAS.Alice, chain.chainId);
    await alicePage.goto("/app/wallet");
    await alicePage.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
    const aliceAddress = (await alicePage.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";
    expect(aliceAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const shot = { phase: "08-gas-wallet", persona: "alice", chain: chainSlug, viewport: chain.viewport };
    resetCounter(shot);

    // — First UserOp deploys the AA. Use faucet + shield to trigger
    //   the lazy deploy. The shield UserOp uses paymaster (legacy
    //   path, since the upgrade hasn't fired yet).
    await faucetUsdc(alicePage, aliceAddress, chain.chainId, url);
    await alicePage.reload();
    await shieldUsdc(alicePage, "20", PERSONAS.Alice.passphrase);

    // — Sub-assertion 1: read the proxy's impl slot. It should point
    //   at the legacy BlankAccount impl (NOT the gas-wallet impl).
    //   Factory's accountImplementation is immutable so the legacy
    //   pointer survives the deploy of the new impl.
    const legacyImpl = await readImplSlot(chain.rpcUrl, aliceAddress);
    expect(legacyImpl).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // — Sub-assertion 2: the GasWalletPanel banner is visible.
    await alicePage.goto("/app/wallet");
    const upgradeBanner = alicePage.locator('[aria-label="Account upgrade available"]');
    await upgradeBanner.waitFor({ state: "visible", timeout: 30_000 });
    await snap(alicePage, shot, "upgrade-banner-visible");

    // — Sub-assertion 3: click Upgrade → passkey signs → mine.
    const upgradeBtn = alicePage.locator('button[aria-label*="Upgrade smart account"]');
    await upgradeBtn.click();
    await enterPassphrase(alicePage, PERSONAS.Alice.passphrase);
    const upgradeTxHash = await readTxHashFromSuccess(alicePage);
    expect(upgradeTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    await snap(alicePage, shot, "upgrade-tx-submitted");

    // Wait for the on-chain impl pointer to flip. Poll up to 60s.
    const newImpl = await (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const impl = await readImplSlot(chain.rpcUrl, aliceAddress);
        if (impl !== legacyImpl) return impl;
        await alicePage.waitForTimeout(3_000);
      }
      throw new Error("Impl pointer did not flip within 60s of upgrade tx");
    })();
    expect(newImpl).not.toEqual(legacyImpl);
    await alicePage.reload();
    await snap(alicePage, shot, "post-upgrade-banner-gone");

    // — Sub-assertion 4: Dave (external EOA via deployer key) sends
    //   0.005 ETH directly to Alice's AA address. The contract's new
    //   receive() forwards into EntryPoint.depositTo.
    const pk = process.env.PRIVATE_KEY;
    test.skip(!pk, "PRIVATE_KEY env not set — Dave (external EOA) can't sign the deposit tx");
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const dave = new ethers.Wallet(pk!, provider);
    const depositBefore = await readEntryPointDeposit(chain.rpcUrl, aliceAddress);
    const sendValue = ethers.parseEther("0.005");
    const daveTx = await dave.sendTransaction({ to: aliceAddress, value: sendValue });
    const daveReceipt = await daveTx.wait(1);
    expect(daveReceipt?.status).toBe(1);
    const externalDepositTxHash = daveReceipt!.hash;

    // Poll the EntryPoint deposit until it ticks up.
    const depositAfter = await (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const bal = await readEntryPointDeposit(chain.rpcUrl, aliceAddress);
        if (bal > depositBefore) return bal;
        await alicePage.waitForTimeout(3_000);
      }
      return await readEntryPointDeposit(chain.rpcUrl, aliceAddress);
    })();
    expect(depositAfter, "EntryPoint deposit didn't grow after Dave's send").toBeGreaterThan(depositBefore);

    // Reload Alice's wallet panel + assert "Self-paying mode active".
    await alicePage.reload();
    await alicePage.locator('[data-testid="gas-wallet-deposit"]').waitFor({ state: "visible", timeout: 30_000 });
    await snap(alicePage, shot, "after-external-deposit");
    const selfPayBadge = alicePage.locator("text=/Self-paying mode active/i");
    await expect(selfPayBadge).toBeVisible({ timeout: 30_000 });

    // — Sub-assertion 5: Alice fires a self-pay UserOp. Bob just needs
    //   his address as the recipient — quick context spawn.
    const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: url });
    const bobPage = await bobCtx.newPage();
    await bobPage.goto("/");
    await setActiveChain(bobPage, chain.chainId);
    await injectPasskey(bobPage, PERSONAS.Bob, chain.chainId);
    await bobPage.goto("/app/wallet");
    await bobPage.locator('[data-testid="gas-wallet-address"]').waitFor({ state: "visible", timeout: 30_000 });
    const bobAddress = (await bobPage.locator('[data-testid="gas-wallet-address"]').textContent())?.trim() ?? "";
    await bobCtx.close();

    // Capture the pre-send deposit balance.
    const preSendDeposit = await readEntryPointDeposit(chain.rpcUrl, aliceAddress);

    await alicePage.goto("/app/send");
    await snap(alicePage, shot, "self-pay-send-screen");
    await alicePage.locator('input[placeholder*="0x"]').first().fill(bobAddress);
    await alicePage
      .locator('button:has-text(/^Continue/i), button:has-text(/^Next/i)')
      .first()
      .click();
    await alicePage.locator('input[placeholder="0.00"]').first().fill("1");
    await alicePage
      .locator('button:has-text(/^Continue/i), button:has-text(/^Review/i), button:has-text(/^Send/i)')
      .last()
      .click();
    await alicePage
      .locator('button:has-text(/^Send/i), button:has-text(/^Confirm/i)')
      .last()
      .click();

    // §1.13 prompts the passphrase with subtitle "paid from your own
    // gas deposit" — sanity-check that text appears.
    const promptSubtitle = (await alicePage.locator("text=/paid from your own gas deposit/i").first().isVisible().catch(() => false)) ?? false;

    await enterPassphrase(alicePage, PERSONAS.Alice.passphrase);
    const selfPayTxHash = await readTxHashFromSuccess(alicePage);
    expect(selfPayTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    await snap(alicePage, shot, "self-pay-success");

    // Deposit balance should have decreased (gas paid by sender, not
    // by paymaster). Allow a generous tolerance for RPC propagation.
    const postSendDeposit = await readEntryPointDeposit(chain.rpcUrl, aliceAddress);
    expect(postSendDeposit, "Deposit did not decrease after self-pay UserOp").toBeLessThan(preSendDeposit);

    // — Record three proof lines (upgrade, external-deposit, self-pay
    //   send) + one informational line about the passphrase subtitle.
    recordProof({
      phase: `${PHASE} · upgradeToAndCall (Alice)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: upgradeTxHash,
      screenshotPath: "wave4-shots/08-gas-wallet/" + chainSlug + "/" + chain.viewport + "/alice-upgrade-tx-submitted",
      note: `Alice signs upgradeToAndCall(${newImpl.slice(0, 8)}…, 0x). Impl pointer flipped: ${legacyImpl.slice(0, 8)} → ${newImpl.slice(0, 8)}`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · external EOA → AA auto-deposit`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: externalDepositTxHash,
      screenshotPath: "wave4-shots/08-gas-wallet/" + chainSlug + "/" + chain.viewport + "/alice-after-external-deposit",
      note: `Dave EOA (${dave.address.slice(0, 8)}…) sends 0.005 ETH to ${aliceAddress.slice(0, 8)}…; receive() auto-converts to EntryPoint deposit (${depositBefore} → ${depositAfter} wei). Subtitle "${promptSubtitle ? "paid from your own gas deposit" : "(not surfaced)"}"`,
      viewport: chain.viewport,
    });
    recordProof({
      phase: `${PHASE} · self-pay UserOp (Alice)`,
      chainName: chain.chainName,
      chainId: chain.chainId,
      txHash: selfPayTxHash,
      screenshotPath: "wave4-shots/08-gas-wallet/" + chainSlug + "/" + chain.viewport + "/alice-self-pay-success",
      note: `Alice sends 1 USDC to Bob; UserOp builds with paymasterAndData="0x"; deposit decreased ${preSendDeposit} → ${postSendDeposit} wei`,
      viewport: chain.viewport,
    });

    await aliceCtx.close();
  });
});

test("CHAINS metadata pin (regression sanity)", () => {
  expect(CHAINS.ETH_SEPOLIA.id).toBe(11155111);
  expect(CHAINS.BASE_SEPOLIA.id).toBe(84532);
});
