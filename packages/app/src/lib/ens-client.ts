// Dedicated mainnet publicClient used only for ENS / Basenames resolution.
//
// ENS names are stable on Ethereum mainnet, and `*.base.eth` (Basenames) are
// resolved via the mainnet Universal Resolver which delegates to Base's L2
// resolver via CCIP-Read (EIP-3668). So even though Blank runs on Sepolia and
// Base Sepolia, lookups happen against mainnet.
//
// Kept out of `wagmi-config.ts` on purpose — mainnet is not a Blank chain, we
// don't want wallets to be invited to switch to it.

import { createPublicClient, fallback, http } from "viem";
import { mainnet } from "viem/chains";

const MAINNET_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
];

function envMainnetRpc(): string | undefined {
  if (typeof import.meta === "undefined") return undefined;
  const env = import.meta.env as Record<string, string | undefined>;
  const trimmed = env.VITE_MAINNET_RPC_URL?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const urls = (() => {
  const primary = envMainnetRpc();
  if (!primary) return MAINNET_RPCS;
  return MAINNET_RPCS.includes(primary) ? MAINNET_RPCS : [primary, ...MAINNET_RPCS];
})();

export const ensClient = createPublicClient({
  chain: mainnet,
  transport: fallback(
    urls.map((url) => http(url, { timeout: 10_000, retryCount: 2, retryDelay: 150 })),
    { rank: { interval: 60_000 } },
  ),
});
