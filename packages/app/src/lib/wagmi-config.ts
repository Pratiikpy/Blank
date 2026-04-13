import { createConfig, http } from "wagmi";
import { sepolia, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { CHAINS, ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";

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
    [sepolia.id]: http(CHAINS[ETH_SEPOLIA_ID].rpcUrl),
    [baseSepolia.id]: http(CHAINS[BASE_SEPOLIA_ID].rpcUrl),
  },
});
