import type { BrowserContext, Page } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 wallet fixtures — 4 deterministic personas.
//
//  Passkeys in Blank are passphrase-encrypted P-256 keys in IndexedDB.
//  This means we can inject a known private key via the existing
//  `_testImportPasskey` test helper and the app sees it as a normal
//  passkey from then on. No WebAuthn, no MetaMask, fully headless.
//
//  Each persona has:
//   • A deterministic 32-byte private key (so the AA address is stable
//     across runs and judges can replay).
//   • A test passphrase (anything, just needs to be consistent within
//     a session).
//   • Per-chain isolation — the same persona on Eth Sepolia and Base
//     Sepolia gets a different IndexedDB record per chainId (Blank's
//     passkey lib is chain-scoped, which mirrors the smart-account
//     factory's per-chain CREATE2 derivation).
//
//  Determinism rationale: judges running `pnpm e2e` need to see the
//  same AA addresses in the artifact log, the same tx hashes, the same
//  share URLs. Random seeds would make replay impossible.
// ──────────────────────────────────────────────────────────────────

export interface WalletPersona {
  /** Display name used in screenshots + WAVE4_TESTING_TODO entries. */
  name: "Alice" | "Bob" | "Carol" | "Dave";
  /** 32-byte private key (no 0x prefix). Deterministic per persona. */
  privKey: string;
  /** Test passphrase used for the passkey AES-GCM encryption. */
  passphrase: string;
  /** Persona label written into the passkey IndexedDB row's `label` field. */
  label: string;
  /** When true, this persona uses MetaMask EOA path (Dave only). */
  isMetaMask?: boolean;
}

// 32-byte deterministic seeds. Generated once + pinned forever.
// Format: "wave4-{name}-passkey-seed-{padding}" hex-encoded, exactly 64 chars.
export const PERSONAS: Record<string, WalletPersona> = {
  Alice: {
    name: "Alice",
    privKey: "7761766534616c6963655f70617373305f73656564000000000000000000a01a",
    passphrase: "wave4-alice-passphrase",
    label: "wave4-e2e-alice",
  },
  Bob: {
    name: "Bob",
    // 64 hex chars = 32 bytes. Previous value was 65 chars (typo);
    // _testImportPasskey rejected it on every Bob run. Clean
    // ASCII-mnemonic-style seed with zero padding.
    privKey: "77617665345f626f625f70617373305f73656564000000000000000000b0b1b2",
    passphrase: "wave4-bob-passphrase",
    label: "wave4-e2e-bob",
  },
  Carol: {
    name: "Carol",
    privKey: "7761766534636361726f6c5f70617373305f73656564000000000000000000c0",
    passphrase: "wave4-carol-passphrase",
    label: "wave4-e2e-carol",
  },
  // Dave is the MetaMask EOA persona — drives the final smoke test
  // (phase 9) and supplies the external ETH for the gas-wallet
  // deposit flow (phase 8). The MM extension setup lives separately
  // in e2e/fixtures/metamask/mm-driver.ts; this entry is just a
  // marker so the suite knows Dave exists.
  Dave: {
    name: "Dave",
    // 64 hex chars (was 65). Same typo class as Bob.
    privKey: "7761766534646176655f6d6d5f656f615f7365656400000000000000000000d0",
    passphrase: "wave4-dave-passphrase",
    label: "wave4-e2e-dave-mm",
    isMetaMask: true,
  },
};

export const CHAINS = {
  ETH_SEPOLIA: { id: 11155111, name: "Ethereum Sepolia", explorerUrl: "https://sepolia.etherscan.io" },
  BASE_SEPOLIA: { id: 84532, name: "Base Sepolia", explorerUrl: "https://sepolia.basescan.org" },
} as const;
export type ChainKey = keyof typeof CHAINS;

/**
 * Inject a known passkey into a browser context's IndexedDB. The app
 * sees it as a normal passkey from then on. Page must be at any URL
 * served by Vite (so the app's module graph is loaded).
 */
export async function injectPasskey(
  page: Page,
  persona: WalletPersona,
  chainId: number,
): Promise<{ pubX: string; pubY: string }> {
  return await page.evaluate(
    async ({ chainId, privKey, passphrase, label }) => {
      const pk = await import("/src/lib/passkey.ts");
      await pk.deletePasskey(chainId).catch(() => {});
      const out = await pk._testImportPasskey(chainId, privKey, passphrase, label);
      return { pubX: out.pubX, pubY: out.pubY };
    },
    { chainId, privKey: persona.privKey, passphrase: persona.passphrase, label: persona.label },
  );
}

/**
 * Set the app's active chain id in localStorage before navigating into
 * /app. Mirrors what the ChainProvider reads at boot.
 */
export async function setActiveChain(page: Page, chainId: number): Promise<void> {
  await page.evaluate(
    (id) => localStorage.setItem("blank_active_chain_id", String(id)),
    chainId,
  );
}

/**
 * Spawn a fresh browser context with a known persona + chain. Returns
 * the page + the smart-account address derived from the passkey pubkey.
 * Each call gives an isolated IndexedDB so multi-party tests don't
 * stomp each other.
 */
export async function spawnWallet(
  browser: { newContext: (opts: object) => Promise<BrowserContext> },
  opts: {
    persona: WalletPersona;
    chainId: number;
    viewport?: { width: number; height: number };
    baseURL?: string;
  },
): Promise<{ context: BrowserContext; page: Page; pubX: string; pubY: string }> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    baseURL: opts.baseURL ?? "http://localhost:3000",
  });
  const page = await context.newPage();
  // Land on / first so Vite resolves the passkey lib's module graph.
  await page.goto("/");
  await setActiveChain(page, opts.chainId);
  const { pubX, pubY } = await injectPasskey(page, opts.persona, opts.chainId);
  return { context, page, pubX, pubY };
}
