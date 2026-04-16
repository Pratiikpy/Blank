import { createConfig } from "wagmi";
import { fallback, http } from "viem";
import { sepolia, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";
import { getRpcUrls } from "./rpc";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";

// Multi-RPC transport per chain. viem's `fallback({ rank: true })` health-checks
// every endpoint and automatically routes around throttled/slow ones. This is
// what keeps the UI alive when one RPC provider is rate-limiting us under
// heavy load — we fall over to the next healthy endpoint instead of hanging.
//
// Per-request HTTP timeout is tight (10s) so a slow RPC doesn't block the UI
// waiting for a response that will never come; rank-based routing then demotes
// it. Two retries per URL catches transient network blips without cascading.
function makeTransport(chainId: typeof ETH_SEPOLIA_ID | typeof BASE_SEPOLIA_ID) {
  const urls = getRpcUrls(chainId);
  return fallback(
    urls.map((url) => http(url, { timeout: 10_000, retryCount: 2, retryDelay: 150 })),
    { rank: { interval: 60_000 } },
  );
}

// Wagmi supports both chains simultaneously — the active chain for contract
// reads/writes is still driven by SUPPORTED_CHAIN_ID (localStorage-backed),
// but wallets can switch between them via the chain selector without having
// to reconnect.
export const wagmiConfig = createConfig({
  chains: [sepolia, baseSepolia],
  connectors: [
    injected(),
    coinbaseWallet({ appName: "Blank" }),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [sepolia.id]: makeTransport(ETH_SEPOLIA_ID),
    [baseSepolia.id]: makeTransport(BASE_SEPOLIA_ID),
  },
});
