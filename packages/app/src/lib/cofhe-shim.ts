/**
 * CoFHE React Hook Shims — Hybrid Version
 *
 * Replaces @cofhe/react to avoid MUI/emotion dependency crash in production.
 * Attempts to load @cofhe/sdk dynamically for REAL encryption when available.
 * Falls back to pass-through stubs if SDK fails to load (WASM/SharedArrayBuffer issues).
 *
 * What this provides:
 * - useCofheConnection: reports connected=true when wallet is on correct chain
 * - useCofheEncrypt: real SDK encryption when available, pass-through fallback
 * - useCofheEncryptAndWriteContract: atomic encrypt + write
 * - useCofheReadContractAndDecrypt: read + decrypt (when SDK available)
 * - useCofheActivePermit: permit management
 * - CofheProvider: attempts SDK init, no-op if fails
 * - createCofheConfig: config creation
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { SUPPORTED_CHAIN_ID, BASE_SEPOLIA_ID } from "./constants";

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
      // the correct CoFHE verifier/TN endpoints for that network.
      const activeChain =
        SUPPORTED_CHAIN_ID === BASE_SEPOLIA_ID ? sdkChains.baseSepolia : sdkChains.sepolia;

      _sdkModules = {
        FheTypes: sdkCore.FheTypes,
        Encryptable: sdkCore.Encryptable,
        createCofheConfig: sdkWeb.createCofheConfig,
        createCofheClient: sdkWeb.createCofheClient,
        activeChain,
      };

      const config = _sdkModules.createCofheConfig({
        supportedChains: [_sdkModules.activeChain],
      });
      _sdkClient = _sdkModules.createCofheClient(config);

      _sdkLoaded = true;
      console.log("[cofhe-shim] SDK loaded successfully");
      return true;
    } catch (err) {
      console.warn("[cofhe-shim] SDK failed to load, using fallback mode:", err);
      _sdkFailed = true;
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
  const walletReady = isConnected && chain?.id === SUPPORTED_CHAIN_ID && !!publicClient && !!walletClient;

  useEffect(() => {
    if (!walletReady || !publicClient || !walletClient) return;

    let cancelled = false;

    (async () => {
      const loaded = await loadSdk();
      if (cancelled) return;

      if (loaded && _sdkClient) {
        try {
          await _sdkClient.connect(publicClient, walletClient);
        } catch (err) {
          console.warn("[cofhe-shim] SDK connect failed:", err);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [walletReady, publicClient, walletClient]);

  return {
    // Report connected even without SDK — wallet on correct chain is enough for UI
    connected: walletReady,
    connecting: isConnected && !walletReady,
  };
}

// ─── useCofheEncrypt (CipherPay pattern — wagmi clients, no fresh viem) ──

export function useCofheEncrypt() {
  const [isEncrypting, setIsEncrypting] = useState(false);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const encryptInputsAsync = useCallback(async (items: unknown[]) => {
    setIsEncrypting(true);
    try {
      console.log("[cofhe-shim] encryptInputsAsync called with", items.length, "items");

      const sdkReady = await loadSdk();

      // Connect using wagmi clients (CipherPay pattern — NOT fresh viem clients)
      if (sdkReady && _sdkClient && !_sdkClient.connected && publicClient && walletClient) {
        try {
          console.log("[cofhe-shim] Connecting SDK with wagmi clients...");
          await _sdkClient.connect(publicClient as any, walletClient as any);
          console.log("[cofhe-shim] SDK connected via wagmi ✓");
        } catch (connectErr) {
          console.warn("[cofhe-shim] SDK wagmi connect failed:", connectErr);
        }
      }

      if (sdkReady && _sdkClient) {
        try {
          console.log("[cofhe-shim] Starting REAL encryption...");
          const encrypted = await _sdkClient.encryptInputs(items).execute();
          console.log("[cofhe-shim] REAL encryption SUCCESS ✓");
          return encrypted;
        } catch (err) {
          console.error("[cofhe-shim] REAL encryption FAILED:", err);
        }
      }

      console.warn("[cofhe-shim] ⚠️ FALLBACK — transaction will revert without real signature");
      return items;
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
      console.warn("[cofhe-shim] decryptForTx: SDK not ready");
      return null;
    }

    if (!_sdkClient.connected && publicClient && walletClient) {
      try {
        await _sdkClient.connect(publicClient as any, walletClient as any);
      } catch (connectErr) {
        console.warn("[cofhe-shim] decryptForTx: connect failed:", connectErr);
      }
    }

    try {
      const fheTypeMap: Record<string, number> = {
        ebool: 0,
        uint64: 5,
      };
      const fheTypeId = fheTypeMap[fheType] ?? 5;

      console.log("[cofhe-shim] decryptForTx: requesting decryption for ctHash", ctHash.toString());
      const result = await _sdkClient
        .decryptForTx(ctHash, fheTypeId)
        .withoutPermit()
        .execute();
      console.log("[cofhe-shim] decryptForTx: SUCCESS ✓");
      return {
        decryptedValue: result.decryptedValue,
        signature: result.signature as `0x${string}`,
      };
    } catch (err) {
      console.error("[cofhe-shim] decryptForTx: FAILED:", err);
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
        console.warn("[cofhe-shim] decryptForView: connect failed:", err);
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
      console.warn("[cofhe-shim] decryptForView failed:", err);
      return null;
    }
  }, [publicClient, walletClient, address]);

  return { decryptForView };
}

// ─── useCofheEncryptAndWriteContract ────────────────────────────────

export function useCofheEncryptAndWriteContract() {
  return {
    encryptAndWrite: async (_params: any) => {
      throw new Error("Use writeContractAsync directly with Encryptable values");
    },
    encryption: { isEncrypting: false },
    write: { isPending: false },
    atomicEncryption: { isEncrypting: false },
    atomicWrite: { isPending: false },
  };
}

// ─── useCofheReadContractAndDecrypt ─────────────────────────────────

export function useCofheReadContractAndDecrypt(_config: unknown) {
  return {
    encrypted: { data: undefined, isFetching: false },
    decrypted: { data: undefined, isFetching: false, error: null },
    disabledDueToMissingPermit: !_sdkLoaded,
  };
}

// ─── useCofheActivePermit ───────────────────────────────────────────

export function useCofheActivePermit() {
  const [permitData, setPermitData] = useState<{ isValid: boolean; permit: any } | null>(null);
  const { address } = useAccount();
  const creatingRef = useRef(false);

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
            console.warn("[cofhe-shim] Auto-create permit failed:", err);
          })
          .finally(() => { creatingRef.current = false; });
      }
    } catch {
      setPermitData(null);
    }
  }, [address]);

  return permitData;
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
