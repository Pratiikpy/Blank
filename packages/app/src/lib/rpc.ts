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
// Verified working from a browser (CORS-permissive) without API keys
// as of 2026-04-29. NOTE: drpc.org and a few other public providers
// reject browser requests due to missing Access-Control-Allow-Origin
// headers — those are kept ONLY in api/relay.ts (server-side, where CORS
// doesn't apply) and excluded here. When one provider rate-limits, viem's
// fallback() rotates to the next within ~1.5s.
//
// 2026-05-18 update: rpc.sepolia.org started failing CORS preflight from
// browser origins (observed in Playwright + manual repro). Removed from
// the browser-side fallback list; viem's fallback still has publicnode +
// 1rpc covering the same chain. Server-side relay (api/relay.ts) keeps
// the wider provider pool because Node fetch is CORS-exempt.
const PUBLIC_RPCS: Record<SupportedChainId, string[]> = {
  [ETH_SEPOLIA_ID]: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://1rpc.io/sepolia",
  ],
  [BASE_SEPOLIA_ID]: [
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.gateway.tenderly.co",
    // 2026-05-18: sepolia.base.org returns HTTP 403 to browser requests
    // (observed in Playwright diagnostic). Removed; publicnode +
    // tenderly cover the same chain. Server-side relay still has the
    // wider pool. Keep tenderly despite the known eth_call-lag on
    // post-upgrade contracts — it's a viable secondary for reads.
  ],
};

function envRpc(chainId: SupportedChainId): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = chainId === ETH_SEPOLIA_ID
    ? env.VITE_SEPOLIA_RPC_URL
    : env.VITE_BASE_SEPOLIA_RPC_URL;
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length === 0) return undefined;
  // Alchemy doesn't allow browser CORS — skip in browser context. The
  // server-side relay can still use Alchemy via /api/relay (Node fetch
  // bypasses CORS). Browser falls through to public RPCs.
  if (typeof window !== "undefined" && /alchemy\.com/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
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
