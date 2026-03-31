import { useCoingeckoUsdPrice } from "@cofhe/react";
import { CONTRACTS, SUPPORTED_CHAIN_ID } from "@/lib/constants";

/**
 * TASK 3: USD price hook wrapping @cofhe/react's useCoingeckoUsdPrice.
 *
 * The SDK hook requires chainId + tokenAddress (not a coinId string).
 * It internally maps chainId -> CoinGecko platform ID and fetches
 * the token price via /simple/token_price/{platform}.
 *
 * For USDC on Ethereum Sepolia, CoinGecko may not have testnet pricing.
 * Falls back to $1.00 since USDC is a stablecoin.
 *
 * @param tokenAddress - Override token address (defaults to TestUSDC)
 * @param chainId - Override chain ID (defaults to Ethereum Sepolia 11155111)
 */
export function useUsdPrice(
  tokenAddress?: `0x${string}`,
  chainId?: number
) {
  const effectiveAddress = tokenAddress ?? CONTRACTS.TestUSDC;
  const effectiveChainId = chainId ?? SUPPORTED_CHAIN_ID;

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
 *
 * @param rawAmount - Amount in smallest units (e.g. 1000000 for 1 USDC)
 * @param decimals - Token decimals (default 6 for USDC)
 * @param usdPrice - USD price per token (default 1.0)
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
