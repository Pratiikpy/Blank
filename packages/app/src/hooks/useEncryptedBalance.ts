import { useState, useCallback, useRef, useEffect } from "react";
import { useAccount, useReadContract, usePublicClient } from "wagmi";
import {
  useCofheReadContractAndDecrypt,
  useCofheConnection,
  useCofheActivePermit,
} from "@cofhe/react";
import { CONTRACTS, REVEAL_TIMEOUT_MS } from "@/lib/constants";
import { FHERC20VaultAbi } from "@/lib/abis";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Feature flag: set to true to use real cofhe decrypt ─────────────
// When enabled, the hook uses useCofheReadContractAndDecrypt to read the
// encrypted balance handle and auto-decrypt it using the active permit.
// Falls back to the legacy "Encrypted" display when:
//   - cofhe is not connected
//   - no active permit is available
//   - decryption fails
const USE_REAL_DECRYPT = true;

interface EncryptedBalanceState {
  raw: bigint | null;
  formatted: string | null;
  isLoading: boolean;
  isRevealed: boolean;
  error: string | null;
}

/**
 * Hook for managing encrypted balance display with tap-to-reveal.
 *
 * TASK 4 upgrade: Now uses useCofheReadContractAndDecrypt from @cofhe/react
 * for ACTUAL balance decryption when a valid permit is active.
 *
 * The SDK hook:
 * 1. Reads the encrypted balance handle via useCofheReadContract
 * 2. Auto-decrypts using useCofheDecrypt with the active permit
 * 3. Returns the plaintext balance as bigint
 *
 * Falls back to showing "Encrypted" if:
 * - No active cofhe permit
 * - Cofhe SDK not connected
 * - Decryption fails
 */
export function useEncryptedBalance(vaultAddress?: string, decimals = 6) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { connected: cofheConnected } = useCofheConnection();
  const activePermit = useCofheActivePermit();
  const [state, setState] = useState<EncryptedBalanceState>({
    raw: null,
    formatted: null,
    isLoading: false,
    isRevealed: false,
    error: null,
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const vault = (vaultAddress || CONTRACTS.FHERC20Vault_USDC) as `0x${string}`;

  // ─── Real decrypt path (TASK 4) ─────────────────────────────────────
  // useCofheReadContractAndDecrypt reads the on-chain encrypted value and
  // decrypts it via the cofhe threshold network using the active permit.
  //
  // The hook auto-gates on:
  //   - address being defined
  //   - cofhe being connected
  //   - an active permit existing (requiresPermit: true)
  //
  // When any of those conditions are false, the queries are disabled and
  // we fall back to the legacy path below.

  const canUseRealDecrypt = USE_REAL_DECRYPT && cofheConnected && !!activePermit;

  const {
    encrypted: {
      isFetching: isReadingEncrypted,
    },
    decrypted: {
      data: decryptedBalance,
      isFetching: isDecrypting,
      error: decryptError,
    },
    disabledDueToMissingPermit,
  } = useCofheReadContractAndDecrypt(
    {
      address: vault,
      abi: FHERC20VaultAbi,
      functionName: "balanceOf",
      args: address ? [address] : undefined,
      requiresPermit: true,
    },
    {
      readQueryOptions: {
        enabled: canUseRealDecrypt && !!address,
        refetchOnMount: false,
        refetchInterval: 10_000, // Poll every 10s for balance updates
      },
    }
  );

  // ─── Legacy path: read balance handle via wagmi ────────────────────
  // Used when cofhe is not connected or no permit is active.

  const { data: balanceHandle, refetch: refetchHandle } = useReadContract({
    address: vault,
    abi: FHERC20VaultAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !canUseRealDecrypt,
      refetchInterval: 10_000,
    },
  });

  // Read total deposited (plaintext aggregate)
  const { data: totalDeposited, refetch: refetchTotal } = useReadContract({
    address: vault,
    abi: FHERC20VaultAbi,
    functionName: "totalDeposited",
    query: { enabled: true, refetchInterval: 15_000 },
  });

  // Check if user has initialized their encrypted account
  const { data: isInitialized } = useReadContract({
    address: vault,
    abi: FHERC20VaultAbi,
    functionName: "isInitialized",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  // ─── Sync state from SDK decrypt result ──────────────────────────────

  useEffect(() => {
    // Guard: capture address at effect start to prevent stale closures
    const currentAddress = address;
    if (!currentAddress) {
      setState((s) => ({ ...s, raw: null, formatted: null, isLoading: false }));
      return;
    }

    // SDK real decrypt path
    if (canUseRealDecrypt) {
      const isLoading = isReadingEncrypted || isDecrypting;

      if (isLoading) {
        setState((s) => ({
          ...s,
          isLoading: true,
          error: null,
        }));
        return;
      }

      if (decryptError) {
        // Decrypt failed — fall through to showing "Encrypted"
        setState((s) => ({
          ...s,
          raw: null,
          formatted: "Encrypted",
          isLoading: false,
          error: decryptError.message,
        }));
        return;
      }

      if (decryptedBalance !== undefined && decryptedBalance !== null) {
        // Successfully decrypted — decryptedBalance is a bigint from the SDK
        const rawBigint =
          typeof decryptedBalance === "bigint"
            ? decryptedBalance
            : BigInt(String(decryptedBalance));

        const formatted = (Number(rawBigint) / 10 ** decimals).toLocaleString(
          "en-US",
          { minimumFractionDigits: 2, maximumFractionDigits: decimals }
        );

        setState((s) => ({
          ...s,
          raw: rawBigint,
          formatted,
          isLoading: false,
          error: null,
        }));
        return;
      }

      // No data yet but not loading — might be disabled due to missing permit
      if (disabledDueToMissingPermit) {
        setState((s) => ({
          ...s,
          raw: null,
          formatted: "Encrypted",
          isLoading: false,
          error: null,
        }));
        return;
      }

      return;
    }

    // ─── Legacy path (no cofhe / no permit) ─────────────────────────────
    // Type assertion: wagmi returns unknown; balanceOf returns a uint256 handle (bigint)
    const handle = balanceHandle as bigint | undefined;

    if (handle !== undefined && handle > 0n) {
      setState((s) => ({
        ...s,
        raw: handle,
        formatted: "Encrypted",
        isLoading: false,
        error: null,
      }));
    } else if (isInitialized === false) {
      setState((s) => ({
        ...s,
        raw: 0n,
        formatted: "0.00",
        isLoading: false,
        error: null,
      }));
    } else {
      setState((s) => ({
        ...s,
        raw: handle ?? null,
        formatted: handle === 0n ? "0.00" : null,
        isLoading: false,
      }));
    }
  }, [
    address,
    canUseRealDecrypt,
    isReadingEncrypted,
    isDecrypting,
    decryptedBalance,
    decryptError,
    disabledDueToMissingPermit,
    balanceHandle,
    isInitialized,
    decimals,
  ]);

  // ─── Fetch balance manually (force refetch) ──────────────────────────

  const fetchBalance = useCallback(async () => {
    if (!address || !publicClient) return;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      // Invalidate ALL contract read queries (including SDK decrypt path)
      invalidateBalanceQueries();
      await Promise.all([refetchHandle(), refetchTotal()]);
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to fetch balance",
      }));
    }
  }, [address, publicClient, refetchHandle, refetchTotal]);

  // ─── Toggle reveal with auto-hide ────────────────────────────────────

  const toggleReveal = useCallback(() => {
    setState((s) => {
      if (s.raw === null || s.raw === undefined) return s;

      const newRevealed = !s.isRevealed;
      if (newRevealed) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          setState((prev) => ({ ...prev, isRevealed: false }));
        }, REVEAL_TIMEOUT_MS);
      }
      return { ...s, isRevealed: newRevealed };
    });
  }, []);

  // Cleanup
  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return {
    ...state,
    isInitialized: isInitialized ?? false,
    totalDeposited: totalDeposited ? Number(totalDeposited) / 10 ** decimals : 0,
    // Type assertion: wagmi returns unknown; balanceOf returns uint256 (bigint)
    hasBalance:
      canUseRealDecrypt && decryptedBalance !== undefined
        ? (typeof decryptedBalance === "bigint" ? decryptedBalance : BigInt(String(decryptedBalance))) > 0n
        : (balanceHandle as bigint | undefined) !== undefined && (balanceHandle as bigint) > 0n,
    isDecrypted: canUseRealDecrypt && decryptedBalance !== undefined && !decryptError,
    disabledDueToMissingPermit,
    toggleReveal,
    refetch: fetchBalance,
  };
}
