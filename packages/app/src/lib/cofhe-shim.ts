/**
 * CoFHE shim — single import boundary for the Fhenix CoFHE SDK.
 *
 * IMPORT BOUNDARY
 * ---------------
 * Every consumer that needs to encrypt, decrypt, manage permits, or hold a
 * cofhe-aware client should import from THIS file (or `@cofhe/react` aliased
 * here via vite.config.ts). Do not import from `@cofhe/sdk` or `@cofhe/react`
 * directly anywhere else in src/. The `pnpm check:imports` script enforces
 * this rule — adding a direct import elsewhere will fail CI once that
 * script is wired into the ci pipeline (P3 added it as a tool; P4+ will
 * wire it once existing offenders migrate).
 *
 * Why: a v0.6 SDK release with renamed exports (`useCofheEncrypt` →
 * `useEncryptInputs` etc.) becomes a one-file change here instead of a
 * 21-file refactor across hooks/screens. This file also preserves a
 * pass-through fallback for environments where the WASM init fails
 * (Cross-Origin-Embedder-Policy mismatches, SharedArrayBuffer disabled).
 *
 * What this re-exports:
 * - useCofheConnection: reports connected=true when wallet is on correct chain
 * - useCofheEncrypt: real SDK encryption when available, pass-through fallback
 * - useCofheReadContractAndDecrypt: read + decrypt (when SDK available)
 * - useCofheActivePermit: permit management
 * - CofheProvider: attempts SDK init, no-op if fails
 * - createCofheConfig: config creation
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAccount, usePublicClient, useWalletClient, useReadContract } from "wagmi";
import type { Abi, Chain } from "viem";
import {
  blankSmartWalletViemAdapter,
  type CofheSmartAccountClient,
} from "./smart-account-cofhe-bridge";
import {
  SUPPORTED_CHAIN_ID,
  BASE_SEPOLIA_ID,
  ETH_SEPOLIA_ID,
  type SupportedChainId,
} from "./constants";
import { log } from "./log";

// ─── Active chain for SDK init (set by CofheProvider) ──────────────
// Module-level state because `loadSdk()` runs outside React. Defaults to
// whatever `constants.ts` resolved at module load; `CofheProvider` calls
// `_setActiveChainForShim` whenever the app's active chain changes so the
// NEXT `loadSdk()` after a reset targets the new chain's verifier + TN.
let _activeChainIdForShim: SupportedChainId = SUPPORTED_CHAIN_ID;

export function _setActiveChainForShim(id: SupportedChainId) {
  _activeChainIdForShim = id;
}

// ─── Dynamic SDK Loading ───────────────────────────────────────────
// SDK is loaded lazily to avoid top-level WASM/SharedArrayBuffer crashes
// in production environments that don't support them.

let _sdkLoaded = false;
let _sdkFailed = false;
let _sdkLoadPromise: Promise<boolean> | null = null;
let _sdkModules: {
  FheTypes: any;
  Encryptable: any;
  createCofheConfig: any;
  createCofheClient: any;
  activeChain: any;
} | null = null;
let _sdkClient: any = null;

// R5-B: connection source tracking. When a smart-wallet binder is active,
// useCofheConnection defers to it (smart-wallet connect wins); when null,
// the EOA path drives the connect. Prevents the two code paths from
// racing to re-connect the SDK with different walletClients.
//
// Values:
//   null           — nothing bound yet; useCofheConnection may run
//   "wagmi"        — last connect came from EOA path
//   "smart-account"— last connect used the cofhe-sdk smartWalletViemAdapter;
//                    useCofheConnection MUST skip so it doesn't overwrite it
let _activeConnectionSource: "wagmi" | "smart-account" | null = null;

// #312: module-level variables are not reactive — hooks that read
// `_sdkLoaded` / `_sdkClient` inside a useEffect never re-run when the SDK
// finishes loading async after mount. Expose a subscription so consumers
// can bump a render tick when the SDK's load/connect state transitions.
const _sdkStateListeners = new Set<() => void>();

function _notifySdkStateChange() {
  for (const fn of _sdkStateListeners) {
    try { fn(); } catch { /* listener threw — don't break other subscribers */ }
  }
}

/** Subscribe to SDK load/reset events. Returns an unsubscribe function. */
export function _subscribeSdkState(fn: () => void): () => void {
  _sdkStateListeners.add(fn);
  return () => { _sdkStateListeners.delete(fn); };
}

/** React hook that returns a tick counter incremented on SDK state changes.
 *  Include in a useEffect's deps to re-run the effect when the SDK loads
 *  or resets. */
function useSdkStateTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => _subscribeSdkState(() => setTick((t) => t + 1)), []);
  return tick;
}

/**
 * Reset the SDK singletons so a subsequent loadSdk() call re-initializes
 * against the new chain's verifier + threshold network endpoints.
 *
 * Called by CofheProvider on chain change. Without this, encrypt/decrypt
 * calls after a chain switch would target the OLD chain's TN, and
 * contracts would reject proofs as belonging to the wrong circuit.
 */
export function _resetSdkForChainChange() {
  _sdkClient = null;
  _sdkModules = null;
  _sdkLoaded = false;
  _sdkFailed = false;
  _sdkLoadPromise = null;
  _notifySdkStateChange();
}

async function loadSdk(): Promise<boolean> {
  if (_sdkLoaded) return true;
  if (_sdkFailed) return false;

  if (_sdkLoadPromise) return _sdkLoadPromise;

  _sdkLoadPromise = (async () => {
    try {
      const [sdkCore, sdkWeb, sdkChains] = await Promise.all([
        import("@cofhe/sdk"),
        import("@cofhe/sdk/web"),
        import("@cofhe/sdk/chains"),
      ]);

      // Pick the cofhe SDK chain that matches the session's active chain.
      // The SDK exports `sepolia` and `baseSepolia` (and more) — each carries
      // the correct CoFHE verifier/TN endpoints for that network. We read the
      // module-level `_activeChainIdForShim` which is synced by `CofheProvider`
      // on every chain change (before `_resetSdkForChainChange` fires).
      const activeChain =
        _activeChainIdForShim === BASE_SEPOLIA_ID ? sdkChains.baseSepolia : sdkChains.sepolia;

      _sdkModules = {
        FheTypes: sdkCore.FheTypes,
        Encryptable: sdkCore.Encryptable,
        createCofheConfig: sdkWeb.createCofheConfig,
        createCofheClient: sdkWeb.createCofheClient,
        activeChain,
      };

      const config = _sdkModules.createCofheConfig({
        supportedChains: [_sdkModules.activeChain],
        react: { autogeneratePermits: true },
      });
      _sdkClient = _sdkModules.createCofheClient(config);

      _sdkLoaded = true;
      log.debug("cofhe-shim.sdk.loaded");
      _notifySdkStateChange();
      return true;
    } catch (err) {
      log.warn("cofhe-shim.sdk.loadFailed.usingFallback", err instanceof Error ? err : new Error(String(err)));
      _sdkFailed = true;
      _notifySdkStateChange();
      return false;
    }
  })();

  return _sdkLoadPromise;
}

// Kick off loading immediately (non-blocking)
loadSdk();

// ─── useCofheConnection ─────────────────────────────────────────────

export function useCofheConnection() {
  const { isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // R5-D: react to connection-source changes so passkey-only users flip
  // to `connected: true` the moment the smart-wallet binder activates.
  const sdkTick = useSdkStateTick();
  const walletReady =
    isConnected &&
    !!chain &&
    !!publicClient &&
    !!walletClient &&
    (chain.id === ETH_SEPOLIA_ID || chain.id === BASE_SEPOLIA_ID);

  useEffect(() => {
    if (!walletReady || !publicClient || !walletClient) return;
    // R5-B: defer to the smart-wallet binding if one is active. Without
    // this, our EOA connect would overwrite the smart-account connection
    // on every wagmi walletClient refresh, and permits would re-sign as
    // the EOA (mismatching the ACL-bound smart account identity).
    if (_activeConnectionSource === "smart-account") return;

    let cancelled = false;

    (async () => {
      const loaded = await loadSdk();
      if (cancelled) return;

      if (loaded && _sdkClient) {
        try {
          await _sdkClient.connect(publicClient, walletClient);
          _activeConnectionSource = "wagmi";
        } catch (err) {
          log.warn("cofhe-shim.sdk.providerConnect.failed", err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [walletReady, publicClient, walletClient]);

  // R5-D: `connected` is true if EITHER the EOA path is ready OR the
  // smart-wallet binder has connected the SDK. sdkTick is in scope so
  // this recomputes when the binder flips the source.
  const smartWalletBound = _activeConnectionSource === "smart-account";
  // Read sdkTick so the lint warning and the closure-capture-trick are
  // both satisfied; its only purpose is to force a re-render on source
  // changes (see _notifySdkStateChange callers).
  void sdkTick;

  return {
    // Report connected even without SDK — wallet on correct chain is enough for UI
    connected: walletReady || smartWalletBound,
    connecting: isConnected && !walletReady && !smartWalletBound,
  };
}

// ─── R5-B: smart-account-aware SDK connection ─────────────────────────
//
// Wrapped in a hook so callers can pass a CofheSmartAccountClient (built
// from BlankAccount + passkey + relayer via `buildBlankSmartAccountClient`
// in ./smart-account-cofhe-bridge). The cofhe-sdk ships
// `smartWalletViemAdapter(publicClient, smartAccountClient)` for this
// exact purpose — see node_modules/@cofhe/sdk/adapters/smartWallet.ts
// line 58: "Sign typed data via the smart account (EIP-1271 flow)".
//
// When a non-null client is provided:
//  - we dynamically import the adapter (keeps cold-start small)
//  - wrap the publicClient + client into a viem-shaped WalletClient
//  - call _sdkClient.connect(publicClient, walletClient)
//  - set `_activeConnectionSource = "smart-account"` so useCofheConnection
//    skips its own connect and doesn't overwrite ours
// When null (smart wallet turned off / chain switch):
//  - clear the source flag so useCofheConnection reclaims the connection
//    on its next effect run
export function useCofheSmartWalletBinding(
  client: CofheSmartAccountClient | null,
  chainId?: number,
): { bound: boolean; error: Error | null } {
  // R5-D fix: caller MUST pass chainId for passkey-only mode (no EOA → no
  // wagmi-resolved chain context). The SmartAccountCofheBinder is the
  // canonical caller and has activeChainId from ChainProvider — pass it.
  const { chain: wagmiChain } = useAccount();
  const effectiveChainId = chainId ?? wagmiChain?.id;
  const publicClient = usePublicClient({ chainId: effectiveChainId });
  const chain: { id: number } | undefined = wagmiChain ?? (effectiveChainId ? { id: effectiveChainId } : undefined);
  const sdkTick = useSdkStateTick();
  const [bound, setBound] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !publicClient || !chain) {
      // R5-B: unbind — allow useCofheConnection to take over on next tick.
      if (_activeConnectionSource === "smart-account") {
        _activeConnectionSource = null;
        _notifySdkStateChange();
      }
      setBound(false);
      setError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadSdk();
        if (cancelled) return;
        if (!loaded || !_sdkClient) {
          throw new Error("cofhe SDK not loaded");
        }
        // Our own inlined adapter — the cofhe-sdk ships the source but
        // doesn't export it from the compiled public API. See
        // smart-account-cofhe-bridge.ts for why we own this.
        const { walletClient: adaptedWalletClient } = blankSmartWalletViemAdapter(
          publicClient,
          client,
          { chain: chain as Chain },
        );
        await _sdkClient.connect(publicClient, adaptedWalletClient);
        if (cancelled) return;
        _activeConnectionSource = "smart-account";
        _notifySdkStateChange();
        setBound(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setBound(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // sdkTick included so we re-connect after a chain-change reset.
  }, [client, publicClient, chain, sdkTick]);

  return { bound, error };
}

// ─── useCofheEncrypt (CipherPay pattern — wagmi clients, no fresh viem) ──

export function useCofheEncrypt() {
  const [isEncrypting, setIsEncrypting] = useState(false);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  // R5-D fix: in passkey-only mode the wagmi walletClient is undefined,
  // so the eager connect below would silently skip. Subscribe to SDK state
  // so we can also wait for the SmartAccountCofheBinder to do its thing.
  const sdkStateTickEnc = useSdkStateTick();

  // Wave 4 task #245 — pass an optional step callback through to the
  // SDK builder so callers can drive a real-step progress UI off the
  // 5 phases the SDK reports (initTfhe → fetchKeys → pack → prove → verify).
  // The callback signature matches @cofhe/sdk's EncryptStepCallbackFunction.
  const encryptInputsAsync = useCallback(async (
    items: unknown[],
    onStep?: (step: unknown, ctx?: { isStart?: boolean; isEnd?: boolean; duration?: number }) => void,
  ) => {
    setIsEncrypting(true);
    try {
      log.debug("cofhe-shim.encryptInputsAsync.called", { itemCount: items.length });

      const sdkReady = await loadSdk();

      // Connect path A: smart-account binder already connected
      // (passkey-only mode). Nothing to do — the binder's connect call
      // populated _sdkClient with the smart-wallet-aware walletClient.
      if (sdkReady && _sdkClient && _sdkClient.connected && _activeConnectionSource === "smart-account") {
        log.debug("cofhe-shim.sdk.alreadyBound");
      }
      // Connect path B: wagmi EOA path — eager connect from the encrypt call.
      else if (sdkReady && _sdkClient && !_sdkClient.connected && publicClient && walletClient) {
        try {
          log.debug("cofhe-shim.sdk.connect.start");
          await _sdkClient.connect(publicClient as any, walletClient as any);
          _activeConnectionSource = "wagmi";
          log.debug("cofhe-shim.sdk.connect.success", { via: "wagmi" });
        } catch (connectErr) {
          log.warn("cofhe-shim.sdk.connect.failed", connectErr instanceof Error ? connectErr : new Error(String(connectErr)));
        }
      }
      // Connect path C: passkey-only mode but binder hasn't fired yet.
      // Wait briefly for it (binder runs as soon as smart account is
      // ready+deployed, which is async after mount).
      else if (sdkReady && _sdkClient && !_sdkClient.connected && !walletClient) {
        log.debug("cofhe-shim.binder.waiting");
        const start = Date.now();
        while (Date.now() - start < 15_000) {
          if (_sdkClient.connected) {
            log.debug("cofhe-shim.binder.connected");
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!_sdkClient.connected) {
          log.warn("cofhe-shim.binder.timeout", { thresholdMs: 15000 });
        }
      }
      // Touch sdkStateTickEnc so React re-renders when SDK state changes.
      void sdkStateTickEnc;

      if (sdkReady && _sdkClient) {
        try {
          // Read the SDK's actual connection state via its public getter.
          // On-chain MockTaskManager.extractSigner packs (ctHash, utype,
          // securityZone, sender, block.chainid). Encryption's signature
          // must match. If the SDK's state.account was wrong at connect()
          // time, recovery yields a garbage signer → InvalidSigner revert.
          const snap = (_sdkClient as { connection?: { account?: string; chainId?: number; walletClient?: { account?: { address?: string } } } }).connection;
          const sdkAccount = snap?.account;
          const sdkChainId = snap?.chainId;
          const walletClientAccount = snap?.walletClient?.account?.address;
          log.debug("cofhe-shim.sdk.stateBeforeEncrypt", { sdkAccount, sdkChainId, walletClientAccount });

          // Explicit belt-and-suspenders setAccount — guarantees the SDK
          // signs for the address whose ERC-1271 on-chain identity will
          // match msg.sender when the contract calls FHE.asEuint64.
          const authoritativeAccount = walletClientAccount ?? sdkAccount;

          // Hypothesis (see TESTING_STATUS.md): CoFHE's zkVerify backend
          // produces valid encrypted-input signatures for a smart-account
          // address only after observing a self-permit from it. Old accounts
          // worked because they produced self-permits implicitly earlier; new
          // accounts fail with `InvalidSigner` until this runs once. The only
          // other smart-account + FHE project (z0tz-cctp-bridge) calls
          // `permits.createSelf` before every encrypted op. We call it once
          // per (address, chainId), piggybacking on the already-unlocked
          // passphrase session so we don't prompt the user twice.
          if (
            _activeConnectionSource === "smart-account" &&
            authoritativeAccount &&
            sdkChainId
          ) {
            const warmupKey = `blank:cofhe_warmup:${authoritativeAccount.toLowerCase()}:${sdkChainId}`;
            const alreadyWarm = typeof localStorage !== "undefined" && localStorage.getItem(warmupKey) === "1";
            if (!alreadyWarm) {
              try {
                log.debug("cofhe-shim.permits.warmup.start", { account: authoritativeAccount });
                await (_sdkClient as { permits: { createSelf: (args: { issuer: string }) => Promise<unknown> } })
                  .permits.createSelf({ issuer: authoritativeAccount });
                if (typeof localStorage !== "undefined") localStorage.setItem(warmupKey, "1");
                log.debug("cofhe-shim.permits.warmup.success");
              } catch (warmupErr) {
                log.warn("cofhe-shim.permits.warmup.failed", warmupErr instanceof Error ? warmupErr : new Error(String(warmupErr)));
              }
            }
          }

          log.debug("cofhe-shim.encrypt.start", { account: authoritativeAccount });
          const builder = _sdkClient.encryptInputs(items);
          if (authoritativeAccount && typeof builder.setAccount === "function") {
            builder.setAccount(authoritativeAccount);
          }
          // Wave 4 task #245 — wire SDK step callbacks through to the
          // caller's progress UI. Best-effort: builder.onStep was added in
          // @cofhe/sdk PR #239 / package patch 0.5.x — guard with typeof
          // so older bundles don't throw.
          if (onStep && typeof (builder as { onStep?: unknown }).onStep === "function") {
            (builder as { onStep: (cb: typeof onStep) => unknown }).onStep(onStep);
          }
          const encrypted = await builder.execute();
          log.debug("cofhe-shim.encrypt.success");
          return encrypted;
        } catch (err) {
          // Audit Top-28 #1 (most dangerous finding): the previous behaviour
          // logged the failure and fell through to `return items` — i.e. the
          // raw plaintext encryption requests were handed back as if they
          // were a successful EncryptedInput[]. Callers then submitted those
          // to contract calls expecting real signatures. If any contract is
          // missing the matching `FHE.allowThis()` (audit Top-28 #2 covers
          // those), the on-chain ops execute against unsigned plaintext —
          // a privacy leak. Fail-closed instead: throw, let callers surface
          // a clear error to the user, and never let plaintext masquerade
          // as ciphertext.
          log.error("cofhe-shim.encrypt.failed", err instanceof Error ? err : new Error(String(err)));
          throw new Error(
            err instanceof Error
              ? `Encryption failed: ${err.message}`
              : "Encryption failed",
          );
        }
      }

      // SDK isn't ready (still loading, or failed to load on this browser).
      // Refusing here is the only safe option — see the throw above for
      // why returning plaintext would be a privacy leak.
      throw new Error(
        "Encryption service is still starting. Please wait a moment and try again.",
      );
    } finally {
      setIsEncrypting(false);
    }
  }, [publicClient, walletClient]);

  return {
    encryptInputsAsync,
    isEncrypting,
  };
}

// ─── useCofheDecryptForTx (v0.1.3 new decrypt flow) ────────────────
// Fetches the off-chain decryption result + Threshold Network signature
// for a publicly-decryptable ctHash. The signature is what the contract
// passes to FHE.publishDecryptResult on-chain.
//
// Caller must have already triggered FHE.allowPublic(ctHash) on-chain
// before calling this. Returns null on failure (caller decides retry).

export function useCofheDecryptForTx() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const decryptForTx = useCallback(async (
    ctHash: bigint,
    fheType: "uint64" | "ebool" = "uint64"
  ): Promise<{ decryptedValue: bigint | boolean; signature: `0x${string}` } | null> => {
    const sdkReady = await loadSdk();
    if (!sdkReady || !_sdkClient) {
      log.warn("cofhe-shim.decryptForTx.sdkNotReady");
      return null;
    }

    if (!_sdkClient.connected && publicClient && walletClient) {
      try {
        await _sdkClient.connect(publicClient as any, walletClient as any);
      } catch (connectErr) {
        log.warn("cofhe-shim.decryptForTx.connectFailed", connectErr instanceof Error ? connectErr : new Error(String(connectErr)));
      }
    }

    try {
      const fheTypeMap: Record<string, number> = {
        ebool: 0,
        uint64: 5,
      };
      const fheTypeId = fheTypeMap[fheType] ?? 5;

      log.debug("cofhe-shim.decryptForTx.requesting", { ctHash: ctHash.toString() });
      const result = await _sdkClient
        .decryptForTx(ctHash, fheTypeId)
        .withoutPermit()
        .execute();
      log.debug("cofhe-shim.decryptForTx.success");
      return {
        decryptedValue: result.decryptedValue,
        signature: result.signature as `0x${string}`,
      };
    } catch (err) {
      log.error("cofhe-shim.decryptForTx.failed", err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }, [publicClient, walletClient]);

  return { decryptForTx };
}

// ─── useCofheDecryptForView (public-decryptable handles) ───────────
// For ctHashes where the contract called FHE.allowGlobal — anyone can
// decrypt the value. The SDK still needs a self-permit (it's the one
// piece of plumbing decryptForView requires regardless of ACL state),
// so we lazily create one for the connected wallet.

export function useCofheDecryptForView() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { address } = useAccount();

  const decryptForView = useCallback(async (
    ctHash: bigint,
    fheType: "uint64" | "ebool" = "uint64",
  ): Promise<bigint | boolean | null> => {
    const sdkReady = await loadSdk();
    if (!sdkReady || !_sdkClient) return null;

    if (!_sdkClient.connected && publicClient && walletClient) {
      try {
        await _sdkClient.connect(publicClient as any, walletClient as any);
      } catch (err) {
        log.warn("cofhe-shim.decryptForView.connectFailed", err instanceof Error ? err : new Error(String(err)));
        return null;
      }
    }

    // Ensure a self-permit exists (decryptForView requires one even for
    // globally-allowed handles — it's an SDK plumbing constraint, not an
    // on-chain ACL constraint).
    if (address) {
      try {
        const active = _sdkClient.permits?.getActivePermit?.();
        if (!active) {
          await _sdkClient.permits?.getOrCreateSelfPermit?.();
        }
      } catch {
        // permit creation fails silently — decryptForView will surface the real error
      }
    }

    try {
      const fheTypeMap: Record<string, number> = { ebool: 0, uint64: 5 };
      const fheTypeId = fheTypeMap[fheType] ?? 5;
      const result = await _sdkClient.decryptForView(ctHash, fheTypeId).execute();
      return result;
    } catch (err) {
      log.warn("cofhe-shim.decryptForView.failed", err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }, [publicClient, walletClient, address]);

  return { decryptForView };
}

// §1.6 of BEST_VERSION_FULL_PLAN: useCofheEncryptAndWriteContract was a
// non-functional stub that threw on call. Removed entirely. All Wave 4
// hooks (useClaimLinks, useCrowdfund, useEncryptedEscrow, useStorefront)
// already use useUnifiedWrite which accepts InEuint64 values directly.
// useInheritance + useSendPayment migrated to the same shape.

// ─── useCofheReadContractAndDecrypt ─────────────────────────────────
// #281: was a non-functional stub that returned all-undefined regardless
// of input. Any hook that depended on it (useEncryptedBalance via
// USE_REAL_DECRYPT) silently rendered "Encrypted" forever even with a
// valid permit. Now composes the real primitives:
//   1. wagmi useReadContract → fetches the encrypted euint64/ebool handle
//   2. decryptForView (SDK) → off-chain decrypt via threshold network
// and exposes the legacy shape the consumer expects.

type FheType = "uint64" | "ebool";

interface ReadAndDecryptConfig {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  requiresPermit?: boolean;
  fheType?: FheType;
}

interface ReadAndDecryptOptions {
  readQueryOptions?: {
    enabled?: boolean;
    refetchOnMount?: boolean;
    refetchInterval?: number | false;
  };
}

export function useCofheReadContractAndDecrypt(
  config: ReadAndDecryptConfig,
  options: ReadAndDecryptOptions = {},
) {
  const sdkTick = useSdkStateTick();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const fheType: FheType = config.fheType ?? "uint64";
  const readEnabled = options.readQueryOptions?.enabled ?? true;

  // Step 1: read the encrypted handle from the contract via wagmi
  const read = useReadContract({
    address: config.address,
    abi: config.abi,
    functionName: config.functionName,
    args: config.args as readonly unknown[] | undefined,
    query: {
      enabled: readEnabled,
      refetchOnMount: options.readQueryOptions?.refetchOnMount ?? true,
      refetchInterval: options.readQueryOptions?.refetchInterval,
    },
  });

  // Step 2: decrypt the handle via the SDK (off-chain TN call)
  const [decrypted, setDecrypted] = useState<bigint | boolean | undefined>(undefined);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<Error | null>(null);

  useEffect(() => {
    const handle = read.data as bigint | undefined;
    if (handle === undefined) {
      setDecrypted(undefined);
      setDecryptError(null);
      return;
    }
    if (!_sdkLoaded || !_sdkClient) {
      // SDK not ready yet — wait for sdkTick to fire.
      setDecrypted(undefined);
      return;
    }

    let cancelled = false;
    (async () => {
      setIsDecrypting(true);
      setDecryptError(null);
      try {
        if (!_sdkClient.connected && publicClient && walletClient) {
          try {
            await _sdkClient.connect(publicClient as any, walletClient as any);
          } catch (connectErr) {
            if (cancelled) return;
            throw connectErr instanceof Error ? connectErr : new Error(String(connectErr));
          }
        }
        const fheTypeId = fheType === "ebool" ? 0 : 5;
        const value = await _sdkClient.decryptForView(handle, fheTypeId).execute();
        if (cancelled) return;
        setDecrypted(value);
      } catch (err) {
        if (cancelled) return;
        setDecryptError(err instanceof Error ? err : new Error(String(err)));
        setDecrypted(undefined);
      } finally {
        if (!cancelled) setIsDecrypting(false);
      }
    })();

    return () => { cancelled = true; };
  }, [read.data, publicClient, walletClient, fheType, sdkTick]);

  // #283: `disabledDueToMissingValidPermit` is the signal consumers use to fall
  // back to the encrypted placeholder. A missing permit is the common case,
  // but also cover SDK-failed and SDK-not-loaded so the fallback fires
  // correctly under those conditions too.
  const disabledDueToMissingValidPermit =
    config.requiresPermit === true &&
    (!_sdkLoaded || _sdkFailed || !_sdkClient || !_sdkClient.connected);

  return {
    encrypted: { data: read.data, isFetching: read.isFetching },
    decrypted: { data: decrypted, isFetching: isDecrypting, error: decryptError },
    disabledDueToMissingValidPermit,
  };
}

// ─── useCofheActivePermit ───────────────────────────────────────────
// #312: previously had deps of just `[address]`, but the effect reads the
// module-level `_sdkLoaded` / `_sdkClient` that change async after mount.
// Subscribe to SDK state transitions via useSdkStateTick so the effect
// re-runs the moment the SDK finishes connecting.

export function useCofheActivePermit() {
  const [permitData, setPermitData] = useState<{ isValid: boolean; permit: any } | null>(null);
  const { address } = useAccount();
  const creatingRef = useRef(false);
  const sdkTick = useSdkStateTick();

  useEffect(() => {
    if (!_sdkLoaded || !_sdkClient || !_sdkClient.connected || !address) {
      setPermitData(null);
      return;
    }

    try {
      const active = _sdkClient.permits?.getActivePermit?.();
      if (active) {
        const now = Math.floor(Date.now() / 1000);
        setPermitData({ isValid: active.expiration > now, permit: active });
      } else if (!creatingRef.current) {
        creatingRef.current = true;
        _sdkClient.permits?.getOrCreateSelfPermit?.()
          .then((permit: any) => {
            const now = Math.floor(Date.now() / 1000);
            setPermitData({ isValid: permit.expiration > now, permit });
          })
          .catch((err: any) => {
            log.warn("cofhe-shim.permits.autoCreate.failed", err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => { creatingRef.current = false; });
      }
    } catch {
      setPermitData(null);
    }
  }, [address, sdkTick]);

  return permitData;
}

// ─── useCofheNavigateToCreatePermit ────────────────────────────────
// Real SDK exports this as navigation into a built-in modal; we don't use
// their modal UI so we expose it as an imperative function that directly
// calls `permits.getOrCreateSelfPermit()`. One EIP-712 signature popup,
// then the permit lands in the SDK's permit store and every
// `useCofheActivePermit` subscriber re-renders.
//
// Returned callback accepts an unused `cause` arg to match the real SDK's
// signature `({ cause }?) => void` so call sites can be swapped 1:1.
export function useCofheNavigateToCreatePermit() {
  return useCallback(async (_opts?: { cause?: unknown }) => {
    if (!_sdkLoaded || !_sdkClient || !_sdkClient.connected) {
      log.warn("cofhe-shim.navigateToCreatePermit.sdkNotConnected");
      return;
    }
    try {
      await _sdkClient.permits?.getOrCreateSelfPermit?.();
      _notifySdkStateChange();
    } catch (err) {
      log.error("cofhe-shim.navigateToCreatePermit.failed", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, []);
}

// ─── useCoingeckoUsdPrice ───────────────────────────────────────────

export function useCoingeckoUsdPrice(_config?: unknown) {
  return {
    data: 1.0,
    isLoading: false,
    error: null,
  };
}

// ─── CofheProvider (no-op — SDK loads lazily) ──────────────────────

export function CofheProvider({ children }: { children: React.ReactNode }) {
  return children;
}

// ─── createCofheConfig ──────────────────────────────────────────────

export function createCofheConfig(_config: unknown) {
  return {};
}

// ─── Re-exports ─────────────────────────────────────────────────────
// These are used by hooks that import { Encryptable } from "@cofhe/react"
// Re-export from the real SDK if loaded, otherwise provide stubs

export const Encryptable = new Proxy({} as any, {
  get(_target, prop) {
    if (_sdkModules?.Encryptable) {
      return _sdkModules.Encryptable[prop];
    }
    // Fallback: create objects matching InEuint64 ABI tuple: { ctHash, securityZone, utype, signature }
    // FheTypes enum from @cofhe/sdk/core/types.ts: Bool=0, Uint4=1, Uint8=2, Uint16=3, Uint32=4, Uint64=5, Uint128=6, Uint160=7
    const utypeMap: Record<string, number> = {
      bool: 0, uint8: 2, uint16: 3, uint32: 4, uint64: 5, uint128: 6, address: 7,
    };
    return (value: any) => ({
      ctHash: BigInt(value),
      securityZone: 0,
      utype: utypeMap[String(prop)] ?? 4,
      signature: "0x",
    });
  },
});

export const FheTypes = new Proxy({} as any, {
  get(_target, prop) {
    if (_sdkModules?.FheTypes) {
      return _sdkModules.FheTypes[prop];
    }
    // Fallback enum values — must match @cofhe/sdk/core/types.ts FheTypes enum exactly
    const map: Record<string, number> = {
      Bool: 0, Uint4: 1, Uint8: 2, Uint16: 3, Uint32: 4, Uint64: 5, Uint128: 6, Uint160: 7, Uint256: 8, Address: 7,
    };
    return map[String(prop)] ?? 0;
  },
});
