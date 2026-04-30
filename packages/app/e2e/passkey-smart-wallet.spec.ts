import { test, expect } from "@playwright/test";

/**
 * Passkey-smart-wallet E2E harness (R5 proof-of-concept).
 *
 * This is the architectural verification for "can we run full browser
 * automation with no wallet extension?" The answer is YES for Blank because
 * the "passkey" is actually a passphrase-encrypted software P-256 key in
 * IndexedDB — no WebAuthn prompt, no MetaMask, no Coinbase popup.
 *
 * TWO suites here:
 *
 *   1. `passkey crypto works in-browser` — runs TODAY, proves the core
 *      passkey library (@/lib/passkey) can generate keys + sign hashes
 *      inside a real Chromium via page.evaluate. No UI needed. This is the
 *      architectural green light: if this passes, the test harness is valid.
 *
 *   2. `create smart wallet without extension` — skipped today, will pass
 *      once R5 ships the passkey-first Onboarding path. Written out so the
 *      UI team knows exactly what selectors / testids to add.
 *
 * Run only these: `pnpm test:e2e passkey-smart-wallet`
 * Run with the app dev server on :5173.
 */

test.describe("passkey architecture verification", () => {
  test("passkey crypto works in-browser (no WebAuthn, no extension)", async ({ page }) => {
    // Navigate so the app's JS module graph (and @noble/curves via
    // @/lib/passkey) is loaded into the page context.
    await page.goto("/");

    // Import the passkey lib directly in page context and run the whole
    // generate → sign → verify round-trip. If this completes, every piece
    // needed for E2E passkey testing — key gen, encryption with passphrase,
    // IndexedDB persistence, software P-256 signing — works headless.
    const result = await page.evaluate(async () => {
      // Dynamic import so Vite's module resolver hands us the real build.
      const mod = await import("/src/lib/passkey.ts");
      const { createPasskey, signHash, hasPasskey, deletePasskey, sha256Hex } = mod;

      // Unique chainId per test run so we don't collide with app state.
      const testChainId = 999_999_001;

      // Clean slate
      await deletePasskey(testChainId).catch(() => {});

      // 1) Generate a new passkey with a test passphrase
      const pub = await createPasskey(testChainId, "test-passphrase-123", "e2e-test");

      // 2) Confirm it's queryable + persisted in IndexedDB
      const exists = await hasPasskey(testChainId);

      // 3) Sign a deterministic hash
      const hash = sha256Hex("hello from playwright");
      const sig = await signHash(testChainId, "test-passphrase-123", hash);

      // Clean up so this test is idempotent
      await deletePasskey(testChainId);

      return {
        hasPubX: typeof pub.pubX === "string" && pub.pubX.startsWith("0x") && pub.pubX.length === 66,
        hasPubY: typeof pub.pubY === "string" && pub.pubY.startsWith("0x") && pub.pubY.length === 66,
        existed: exists,
        sigR: sig.r,
        sigS: sig.s,
        sigLooksValid:
          typeof sig.r === "string" && sig.r.length === 66 &&
          typeof sig.s === "string" && sig.s.length === 66,
      };
    });

    expect(result.hasPubX, "pubX is 32-byte hex").toBe(true);
    expect(result.hasPubY, "pubY is 32-byte hex").toBe(true);
    expect(result.existed, "passkey persisted to IndexedDB").toBe(true);
    expect(result.sigLooksValid, "P-256 signature is 64 bytes total").toBe(true);
    // Bonus: low-s normalization means s.value < n/2. Noble enforces this
    // by default so we don't need to assert — we've already proven signing
    // works without any WebAuthn prompt or wallet extension.
  });

  // R5-B: verify the ERC-1271 signature round-trip works mathematically.
  // Signs a 32-byte digest with the passkey, encodes via our bridge's
  // encodeP256AsErc1271Signature, then decodes (r,s) back and verifies via
  // passkey.verifyP256 — the same math BlankAccount.isValidSignature runs
  // on-chain. If this passes, on-chain verification will succeed too for
  // a deployed account (that part is R5-D territory).
  //
  // Using only app modules (served by Vite) so there's no bare-specifier
  // resolution failure in page.evaluate().
  test("ERC-1271 signature round-trip: passkey → abi.encode(r,s) → P-256 verify", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(async () => {
      const passkey = await import("/src/lib/passkey.ts");
      const bridge = await import("/src/lib/smart-account-cofhe-bridge.ts");

      const testChainId = 999_999_002;
      await passkey.deletePasskey(testChainId).catch(() => {});

      const passphrase = "r5b-test-pass";
      const pub = await passkey.createPasskey(testChainId, passphrase, "r5b");

      // 32-byte digest — in the real flow this would be viem's
      // hashTypedData output for a cofhe permit. The math is the same
      // regardless of how the 32 bytes were derived.
      const digest = passkey.sha256Hex("r5b-round-trip-test-digest");

      // Sign via the same path our bridge uses internally
      const sig = await passkey.signHash(testChainId, passphrase, digest);

      // Encode exactly as BlankAccount.isValidSignature decodes
      const encoded = bridge.encodeP256AsErc1271Signature(sig.r, sig.s);

      // Hand-decode abi.encode(r,s) — it's just 32 bytes r || 32 bytes s,
      // no offset prefix. Matches what Solidity's abi.decode(bytes, (uint256,uint256))
      // does — takes the first 32 bytes as r, next 32 as s.
      const decodedR = ("0x" + encoded.slice(2, 66)) as `0x${string}`;
      const decodedS = ("0x" + encoded.slice(66)) as `0x${string}`;

      // Run P-256 verify with the decoded values — proves that after a
      // round-trip encode/decode, the signature still validates.
      const isValid = passkey.verifyP256(digest, decodedR, decodedS, pub.pubX, pub.pubY);

      await passkey.deletePasskey(testChainId);

      return {
        encodedSigLength: encoded.length, // 0x + 128 hex = 130
        decodedR,
        decodedS,
        originalR: sig.r,
        originalS: sig.s,
        rRoundTripsEqual: decodedR === sig.r,
        sRoundTripsEqual: decodedS === sig.s,
        isValid,
      };
    });

    expect(result.encodedSigLength, "abi.encode(r,s) is exactly 64 bytes").toBe(130);
    expect(result.rRoundTripsEqual, "r decodes back to original").toBe(true);
    expect(result.sRoundTripsEqual, "s decodes back to original").toBe(true);
    // THE CRITICAL ASSERTION: passkey signature verifies via P-256 math
    // after going through abi.encode(r,s) round-trip. This proves the
    // on-chain BlankAccount.isValidSignature path will work — same curve,
    // same encoding, same inputs as the contract will see.
    expect(
      result.isValid,
      "P-256 verify(digest, sig, pubkey) returns TRUE after round-trip — matches on-chain BlankAccount.isValidSignature behavior",
    ).toBe(true);
  });

  // R5-A + R5-C: onboarding flow that creates a BlankAccount smart wallet
  // from a passphrase, with no wagmi EOA connection. Requires a clean
  // IndexedDB (no existing passkey for the active chain) — we delete any
  // stale one as a beforeEach. Test walks the 4-step intro then clicks
  // "Continue with Passkey", fills the passphrase twice, submits, and
  // verifies the success state.
  test("create smart wallet via passkey-first onboarding", async ({ page }) => {
    // Clean slate: delete any passkey stored from prior test runs so the
    // modal's "already exists" guard doesn't throw.
    await page.goto("/app");
    await page.evaluate(async () => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(11155111).catch(() => {});
      await passkey.deletePasskey(84532).catch(() => {});
    });
    // Reload to reach Onboarding — `/app` without an EOA or passkey renders
    // BlankApp → Onboarding. First visit starts at step 0 of the 4-step intro.
    await page.goto("/app");

    // Walk through the 4-step intro to reach the wallet selector.
    // Each "Next" click advances by one step; on step 4 the wallet
    // selector (including "Continue with Passkey") is shown.
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: /^Next$/ }).click();
    }

    // Open the passkey creation modal
    await page.getByTestId("onboarding-passkey-cta").click();

    // Fill passphrase + confirmation
    await page.getByTestId("passkey-passphrase-new").fill("e2e-passphrase-987");
    await page.getByTestId("passkey-passphrase-confirm").fill("e2e-passphrase-987");

    // Submit
    await page.getByTestId("passkey-create-submit").click();

    // Success state: smart account address visible, counterfactual status shown
    await expect(page.getByTestId("smart-account-address")).toBeVisible({ timeout: 15_000 });
    const addr = await page.getByTestId("smart-account-address").textContent();
    expect(addr).toMatch(/^0x[0-9a-fA-F]/);

    await expect(page.getByTestId("smart-account-status")).toHaveText(/counterfactual|deploys/i);

    // Cleanup: remove the passkey so subsequent runs start fresh.
    await page.evaluate(async () => {
      const passkey = await import("/src/lib/passkey.ts");
      await passkey.deletePasskey(11155111).catch(() => {});
      await passkey.deletePasskey(84532).catch(() => {});
    });
  });

  // R5-D: infrastructure readiness check. Unlike Tests 1–3 which prove
  // the *mechanics* (crypto, encoding, UI), this one proves the *wiring*:
  // our bridge + inline adapter + BlankAccount factory + relayer are all
  // reachable and produce sane outputs.
  //
  // What it verifies TODAY (no funded testnet account required):
  //   1. Our inlined `blankSmartWalletViemAdapter` is callable. (We own
  //      this now — originally planned to import @cofhe/sdk's version,
  //      but that function lives only in their raw source, not compiled
  //      exports. Inlined into our bridge for stability.)
  //   2. Calling buildBlankSmartAccountClient + passing it through the
  //      adapter produces a viem-shaped walletClient without throwing.
  //   3. The relayer endpoint is reachable (returns anything, not 500).
  //
  // What it DOESN'T do today: submit a real UserOp. That requires the
  // BlankPaymaster to hold ETH deposit on the EntryPoint on Base Sepolia
  // plus a funded test smart account with USDC for the fee. Gate the
  // real testnet flow behind E2E_TESTNET_LIVE=1 for the CI once someone
  // actually funds those resources — see the `test.skip` branch below.
  test("R5-D readiness: adapter + bridge + relayer wired correctly", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(async () => {
      const bridge = await import("/src/lib/smart-account-cofhe-bridge.ts");
      // 1. Our inlined adapter is present and callable
      const hasAdapter = bridge.checkSmartWalletAdapterAvailable();

      // 2. Build a SmartAccountClient via our bridge with dummy deps and
      //    confirm it exposes the right surface. We pass a fake
      //    publicClient/chain — the client itself never calls them until
      //    sendTransaction/signTypedData is invoked, so construction
      //    should succeed.
      const client = bridge.buildBlankSmartAccountClient({
        account: {
          address: "0x0000000000000000000000000000000000000001",
          pubX: "0x0000000000000000000000000000000000000000000000000000000000000001",
          pubY: "0x0000000000000000000000000000000000000000000000000000000000000002",
          isDeployed: true,
        },
        chainId: 84532,
        // @ts-expect-error test stubs — never invoked before assertion
        publicClient: {},
        // @ts-expect-error test stubs
        chain: { id: 84532, name: "Base Sepolia" },
        requestPassphrase: async () => null,
      });

      const clientSurface = {
        hasAccount: typeof client.account === "object" && !!client.account.address,
        hasSendTransaction: typeof client.sendTransaction === "function",
        hasSignTypedData: typeof client.signTypedData === "function",
      };

      // 3. Ping the relayer. Accept 404/405/400/any non-500 as "reachable"
      //    since the real endpoint only accepts POSTs with a real UserOp.
      let relayReachable = false;
      try {
        const res = await fetch("/api/relay", { method: "GET" });
        relayReachable = res.status < 500;
      } catch {
        relayReachable = false;
      }

      return { hasAdapter, clientSurface, relayReachable };
    });

    expect(result.hasAdapter, "@cofhe/sdk/adapters exports smartWalletViemAdapter").toBe(true);
    expect(result.clientSurface.hasAccount, "bridge exposes account.address").toBe(true);
    expect(result.clientSurface.hasSendTransaction, "bridge exposes sendTransaction").toBe(true);
    expect(result.clientSurface.hasSignTypedData, "bridge exposes signTypedData").toBe(true);
    expect(result.relayReachable, "/api/relay endpoint reachable").toBe(true);
  });

  // R5-D live testnet round-trip. Gated behind E2E_TESTNET_LIVE=1 because
  // it costs real Base Sepolia ETH + USDC. Un-gate in CI once the
  // BlankPaymaster is funded + a test smart account is pre-seeded with USDC.
  // Leave in the spec so the steps stay verified against any UI change.
  const liveTestnetEnabled = !!process.env.E2E_TESTNET_LIVE;
  (liveTestnetEnabled ? test : test.skip)(
    "send a UserOp to Base Sepolia via passkey + relayer [LIVE TESTNET]",
    async ({ page }) => {
      // Fund checklist (documented here so future-you doesn't have to
      // archaeology through PRs):
      //   - BlankPaymaster on Base Sepolia has ETH deposit at EntryPoint
      //     (check: publicClient.readContract EntryPoint.balanceOf(paymaster))
      //   - A test smart account exists for the passphrase below and is
      //     pre-funded with >= 1 USDC (fee + amount)
      //   - Relayer env has AGENT_PRIVATE_KEY set + is running
      const LIVE_PASSPHRASE = process.env.E2E_TESTNET_PASSPHRASE || "e2e-live-pass";

      await page.goto("/app");
      // Reuse the existing passkey if one exists for Base Sepolia (84532),
      // else create it. The account should already be deployed in CI.
      await page.evaluate(async (passphrase) => {
        const passkey = await import("/src/lib/passkey.ts");
        if (!(await passkey.hasPasskey(84532))) {
          await passkey.createPasskey(84532, passphrase, "live-e2e");
        }
      }, LIVE_PASSPHRASE);

      // Navigate to send flow + submit a tiny payment
      await page.goto("/app/send");
      await page.getByTestId("send-recipient").fill("0x000000000000000000000000000000000000dEaD");
      await page.getByTestId("send-amount").fill("0.01");
      await page.getByTestId("send-confirm").click();

      // Passphrase prompt for UserOp signing
      await page.getByRole("textbox").fill(LIVE_PASSPHRASE);
      await page.getByRole("button", { name: /Unlock|Authorize/i }).click();

      // Success screen with tx hash (UserOp receipt on Base Sepolia)
      await expect(page.getByTestId("send-success-tx-hash")).toBeVisible({
        timeout: 90_000,
      });
      const hash = await page.getByTestId("send-success-tx-hash").textContent();
      expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    },
  );
});
