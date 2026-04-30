// usePaymasterHealth — observes BlankPaymaster's deposit on the ERC-4337
// EntryPoint and exposes a health verdict the rest of the app can branch on.
//
// Why this exists: every AA UserOp on the sponsored path consumes ETH from
// `entryPoint.balanceOf(BlankPaymaster)`. If that drops too low, a UserOp
// fails with `AA31 paymaster deposit too low` (or worse — a generic
// `entrypoint reverted`). The user sees a cryptic toast and has no path
// forward. This hook surfaces the deposit balance up-front so:
//
//   • SendConfirm can pre-emptively switch to the self-pay path (Phase 7.5)
//   • Dashboard can show a degraded-mode banner instead of a silent fail
//   • Operations can alert before users hit the wall
//
// The threshold is configurable via `VITE_PAYMASTER_MIN_DEPOSIT_WEI`
// (default 0.05 ETH = 5e16 wei) and a separate "block-paymaster" floor
// (`VITE_PAYMASTER_FAIL_DEPOSIT_WEI`, default 0.01 ETH). Values between the
// two flag a degraded warning; below the floor we hard-block sponsored
// path so we don't burn UserOps that will revert anyway.

import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { ENTRYPOINT_ABI, ENTRYPOINT_V08 } from "@/lib/userop";

/** Default warn threshold (~0.05 ETH). Set `VITE_PAYMASTER_MIN_DEPOSIT_WEI` to override. */
const DEFAULT_MIN_DEPOSIT_WEI = 50_000_000_000_000_000n;
/** Default hard-fail threshold (~0.01 ETH). Set `VITE_PAYMASTER_FAIL_DEPOSIT_WEI` to override. */
const DEFAULT_FAIL_DEPOSIT_WEI = 10_000_000_000_000_000n;

function readWeiEnv(key: string, fallback: bigint): bigint {
  if (typeof import.meta === "undefined") return fallback;
  const raw = (import.meta.env as Record<string, string | undefined>)[key]?.trim();
  if (!raw) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const MIN_DEPOSIT_WEI = readWeiEnv("VITE_PAYMASTER_MIN_DEPOSIT_WEI", DEFAULT_MIN_DEPOSIT_WEI);
const FAIL_DEPOSIT_WEI = readWeiEnv("VITE_PAYMASTER_FAIL_DEPOSIT_WEI", DEFAULT_FAIL_DEPOSIT_WEI);

export type PaymasterHealthStatus =
  | "healthy"     // deposit >= warn threshold — sponsored path is the default
  | "degraded"    // deposit between fail and warn — sponsored may fail soon
  | "unavailable" // deposit < fail threshold OR paymaster unset — block sponsored
  | "unknown";    // hasn't loaded yet OR RPC error

export interface PaymasterHealth {
  status: PaymasterHealthStatus;
  /** Current deposit balance on the EntryPoint (wei). NULL until the first read completes. */
  depositWei: bigint | null;
  /** Threshold below which we warn the user. Same value as the env var. */
  warnThresholdWei: bigint;
  /** Threshold below which we block the sponsored path entirely. */
  failThresholdWei: bigint;
  /** True if BlankPaymaster is configured for the active chain. */
  configured: boolean;
  /** Last fetch error (if any). Surfaced for debugging; UI doesn't usually need it. */
  error: string | null;
  /** True while the underlying React Query is in flight. */
  isLoading: boolean;
}

/**
 * Reads `entryPoint.balanceOf(BlankPaymaster)` every 60s. Reactively follows
 * the active chain — switching from Sepolia to Base Sepolia automatically
 * re-fetches against the new chain's paymaster + EntryPoint.
 *
 * The hook is safe to call from any component; it shares its underlying
 * query across mounts via React Query, so multiple consumers (Dashboard
 * banner + SendConfirm pre-flight) hit the chain once per minute total.
 */
export function usePaymasterHealth(): PaymasterHealth {
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const paymaster = contracts.BlankPaymaster as Address | undefined;
  const configured = !!paymaster;

  const query = useQuery({
    queryKey: ["paymaster-health", activeChainId, paymaster ?? "none"],
    enabled: !!publicClient && configured,
    queryFn: async () => {
      if (!publicClient || !paymaster) {
        throw new Error("public client or paymaster missing");
      }
      const deposit = (await publicClient.readContract({
        address: ENTRYPOINT_V08,
        abi: ENTRYPOINT_ABI,
        functionName: "balanceOf",
        args: [paymaster],
      })) as bigint;
      return deposit;
    },
    // Poll every 60s. Stale time slightly under that so React Query
    // doesn't show stale data immediately after refetch.
    refetchInterval: 60_000,
    staleTime: 55_000,
    // Network blips shouldn't blank the entire UI — keep last-known value.
    retry: 2,
    refetchOnWindowFocus: false,
  });

  const depositWei = query.data ?? null;
  const status: PaymasterHealthStatus = !configured
    ? "unavailable"
    : depositWei === null
      ? query.isError ? "unknown" : "unknown"
      : depositWei < FAIL_DEPOSIT_WEI
        ? "unavailable"
        : depositWei < MIN_DEPOSIT_WEI
          ? "degraded"
          : "healthy";

  return {
    status,
    depositWei,
    warnThresholdWei: MIN_DEPOSIT_WEI,
    failThresholdWei: FAIL_DEPOSIT_WEI,
    configured,
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
  };
}
