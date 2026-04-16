import { useAccount } from "wagmi";
import { useCoingeckoUsdPrice } from "@cofhe/react";
import { useChain } from "@/providers/ChainProvider";

/**
 * USD price hook.
 *
 * #103: previously defaulted to SUPPORTED_CHAIN_ID, which is captured at
 * module load from localStorage. If a user manually switched chains in their
 * wallet (not via our ChainSelector), this hook would keep pricing against
 * the old chain even though balances came from the new one. We now prefer
 * wagmi's live `chain.id` and fall back to the app's active chain (via
 * ChainProvider) only when disconnected.
 */
export function useUsdPrice(
  tokenAddress?: `0x${string}`,
  chainId?: number
) {
  const { activeChainId, contracts } = useChain();
  const { chain } = useAccount();
  const effectiveAddress = tokenAddress ?? contracts.TestUSDC;
  const effectiveChainId = chainId ?? chain?.id ?? activeChainId;

  const { data: price, isLoading, error } = useCoingeckoUsdPrice({
    chainId: effectiveChainId,
    tokenAddress: effectiveAddress,
    enabled: true,
  });

  // USDC is ~$1 — use real price when available, fall back to 1.0.
  // CoinGecko likely has no data for testnet tokens, so the fallback
  // will be the common case during development.
  return {
    usdPrice: price ?? 1.0,
    isLoading,
    hasRealPrice: price !== null && price !== undefined,
    error,
  };
}

/**
 * Convenience: format a raw token amount (in smallest units) as USD string.
 */
export function formatAsUsd(
  rawAmount: number | bigint,
  decimals = 6,
  usdPrice = 1.0
): string {
  const value = Number(rawAmount) / 10 ** decimals;
  const usd = value * usdPrice;
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
