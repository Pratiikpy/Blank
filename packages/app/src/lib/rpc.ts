// Per-chain RPC URL resolution for the frontend.
//
// Public testnet RPCs throttle aggressively under load. For a production app
// we need multiple endpoints with automatic failover so a single throttled
// provider doesn't take the whole UI down. This file produces an ordered URL
// list for each chain; callers pair it with viem's `fallback()` transport so
// viem handles ranking, retries, and cutovers.
//
// Order: user-configured private RPC (VITE_*_RPC_URL env) first if set, then
// a curated list of public RPCs as fallbacks. Even without a private URL
// configured, multiple public fallbacks give us real resilience.
//
// Security note: VITE_ vars are bundled to the client. Only put a private RPC
// URL here if the provider supports domain allowlisting (Alchemy, QuickNode,
// Infura). Otherwise stick with the public fallbacks.

import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, type SupportedChainId } from "./constants";

// Curated public RPCs for each supported chain. Ordered roughly by observed
// stability on testnet (publicnode first, Tenderly second, official public
// last). Viem's fallback() with `rank: true` will reorder by actual latency
// after the first health-check pass, so exact order matters less than
// having enough distinct providers.
// Observed 2026-Q2: blastapi.io and blockpi.network do not set CORS headers
// from localhost origins, so they permanently fail CORS preflight from the
// app and add ~200ms per request as the browser blocks then the fallback
// transport moves on. Keep them out until we can verify they support CORS.
// Also observed: Tenderly gateway returns `execution reverted` on `eth_call`
// to contract functions added by a recent UUPS upgrade — their node lags
// behind the new-bytecode state for some period after deploy. Dropping
// Tenderly until they converge; publicnode + the official public RPC are
// enough for failover.
const PUBLIC_RPCS: Record<SupportedChainId, string[]> = {
  [ETH_SEPOLIA_ID]: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://1rpc.io/sepolia",
    "https://rpc.sepolia.org",
  ],
  [BASE_SEPOLIA_ID]: [
    "https://base-sepolia-rpc.publicnode.com",
    "https://sepolia.base.org",
  ],
};

function envRpc(chainId: SupportedChainId): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = chainId === ETH_SEPOLIA_ID
    ? env.VITE_SEPOLIA_RPC_URL
    : env.VITE_BASE_SEPOLIA_RPC_URL;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns an ordered list of RPC URLs for `chainId`, primary first. Safe to
 * pass to viem's `fallback()` — the primary is the user-configured private
 * RPC (if any) and the remainder are curated public RPCs.
 */
export function getRpcUrls(chainId: SupportedChainId): string[] {
  const primary = envRpc(chainId);
  const fallbacks = PUBLIC_RPCS[chainId] ?? [];
  if (!primary) return fallbacks;
  // Don't duplicate if the user already set one of the public URLs.
  return fallbacks.includes(primary) ? fallbacks : [primary, ...fallbacks];
}
