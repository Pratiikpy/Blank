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
  sepoliaChain: any;
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

      _sdkModules = {
        FheTypes: sdkCore.FheTypes,
        Encryptable: sdkCore.Encryptable,
        createCofheConfig: sdkWeb.createCofheConfig,
        createCofheClient: sdkWeb.createCofheClient,
        sepoliaChain: sdkChains.sepolia,
      };

      const config = _sdkModules.createCofheConfig({
        supportedChains: [_sdkModules.sepoliaChain],
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
  const walletReady = isConnected && chain?.id === 11155111 && !!publicClient && !!walletClient;

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

// ─── useCofheEncrypt ────────────────────────────────────────────────

export function useCofheEncrypt() {
  const [isEncrypting, setIsEncrypting] = useState(false);

  const encryptInputsAsync = useCallback(async (items: unknown[]) => {
    setIsEncrypting(true);
    try {
      console.log("[cofhe-shim] encryptInputsAsync called with", items.length, "items");
      console.log("[cofhe-shim] SDK state: loaded=", _sdkLoaded, "failed=", _sdkFailed, "client=", !!_sdkClient);

      // Wait for SDK to load if not yet ready
      const sdkReady = await loadSdk();
      console.log("[cofhe-shim] SDK ready:", sdkReady, "client connected:", _sdkClient?.connected);

      // Try to connect client if not connected
      if (sdkReady && _sdkClient && !_sdkClient.connected) {
        try {
          console.log("[cofhe-shim] Attempting SDK connect via window.ethereum...");
          const { createPublicClient, createWalletClient, custom } = await import("viem");
          const { sepolia } = await import("viem/chains");
          if (typeof window !== "undefined" && (window as any).ethereum) {
            const pc = createPublicClient({ chain: sepolia, transport: custom((window as any).ethereum) });
            const wc = createWalletClient({ chain: sepolia, transport: custom((window as any).ethereum) });
            await _sdkClient.connect(pc, wc);
            console.log("[cofhe-shim] SDK connected successfully");
          } else {
            console.warn("[cofhe-shim] No window.ethereum available");
          }
        } catch (connectErr) {
          console.warn("[cofhe-shim] SDK connect during encrypt FAILED:", connectErr);
        }
      }

      // Try real SDK encryption
      if (sdkReady && _sdkClient) {
        try {
          console.log("[cofhe-shim] Starting REAL encryption with SDK...");
          console.log("[cofhe-shim] Items to encrypt:", JSON.stringify(items, (_, v) => typeof v === 'bigint' ? v.toString() : v));
          const encrypted = await _sdkClient.encryptInputs(items).execute();
          console.log("[cofhe-shim] REAL encryption SUCCESS:", JSON.stringify(encrypted, (_, v) => typeof v === 'bigint' ? v.toString() : v).substring(0, 200));
          return encrypted;
        } catch (err) {
          console.error("[cofhe-shim] REAL encryption FAILED:", err);
          console.error("[cofhe-shim] Error details:", (err as any)?.message, (err as any)?.code, (err as any)?.cause);
        }
      } else {
        console.warn("[cofhe-shim] SDK not available for encryption. loaded:", sdkReady, "client:", !!_sdkClient);
      }

      // Fallback: return items as-is (will cause contract revert without real signature)
      console.warn("[cofhe-shim] ⚠️ USING FALLBACK — no real encryption. Transaction WILL revert on-chain.");
      return items;
    } finally {
      setIsEncrypting(false);
    }
  }, []);

  return {
    encryptInputsAsync,
    isEncrypting,
  };
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
