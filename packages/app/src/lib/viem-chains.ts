/**
 * viem-chains — single source of truth for chain-id → viem Chain object.
 *
 * Why this file exists
 * --------------------
 * Hooks that need a viem Chain (e.g. when building a wallet client or
 * calling chain-aware utilities) used to import the chain directly from
 * `viem/chains` and pass it through. That breaks the moment someone
 * switches the active chain at runtime — the hook's hardcoded import
 * doesn't observe `useChain()`. We had drift in `useSendPayment` and
 * `useInheritance` for exactly this reason.
 *
 * Resolve chain via this helper, keyed off `useChain().activeChainId`,
 * so the hook always reaches the right chain.
 *
 * The `lib/check-imports.mjs` script enforces that `from "viem/chains"`
 * appears only in this file (plus `lib/rpc.ts` for RPC bootstrap).
 */
import { sepolia, baseSepolia, mainnet, arbitrumSepolia } from "viem/chains";
import type { Chain } from "viem";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, ARB_SEPOLIA_ID } from "./constants";

const MAINNET_ID = 1;

/** Resolve a viem `Chain` for a chain id Blank actually supports.
 *  Throws on unknown ids — callers that need optional resolution should
 *  use `chainIdToViemChainOrNull`. */
export function chainIdToViemChain(chainId: number): Chain {
  switch (chainId) {
    case ETH_SEPOLIA_ID:
      return sepolia;
    case BASE_SEPOLIA_ID:
      return baseSepolia;
    case ARB_SEPOLIA_ID:
      return arbitrumSepolia;
    case MAINNET_ID:
      return mainnet;
    default:
      throw new Error(`viem-chains: unsupported chain id ${chainId}`);
  }
}

/** Soft variant for code paths that can degrade (e.g. activity feed
 *  rendering when the user is on a chain Blank doesn't yet support). */
export function chainIdToViemChainOrNull(chainId: number): Chain | null {
  try {
    return chainIdToViemChain(chainId);
  } catch {
    return null;
  }
}
