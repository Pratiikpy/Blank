// Single-pool Uniswap v3 swap hook on top of `lib/uniswap.ts`.
//
// Surface:
//   • `quote(args)` — eth_call against QuoterV2 to preview the trade.
//     Safe to call frequently; QuoterV2 is non-state-mutating despite the
//     `nonpayable` ABI tag (it intentionally reverts mid-execution to
//     return data — the SDK pattern is to call via eth_call).
//   • `swap(args)` — approve (if needed) + exactInputSingle. Same signing
//     path as the rest of the app via `unifiedWriteAndWait` so AA users
//     batch via paymaster and EOA users go through their wallet.
//
// Privacy boundary: this hook touches plaintext token amounts. FHE-encrypted
// balances must be unshielded BEFORE calling `swap`, and reshielded after if
// the user wants the output in encrypted form. We keep that orchestration
// in the calling UI rather than baking it in here so the privacy hop is
// explicit.

import { useCallback, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import {
  QuoterV2Abi,
  SwapRouter02Abi,
  UNISWAP_QUOTER_V2,
  UNISWAP_SWAP_ROUTER_02,
  applySlippage,
  buildExactInputSingleArgs,
  DEFAULT_SLIPPAGE_BPS,
  POOL_FEE,
  type PoolFee,
  type QuoteRequest,
  type QuoteResult,
} from "@/lib/uniswap";

export type SwapStep =
  | "idle"
  | "approving"
  | "swapping"
  | "complete"
  | "error";

export interface UseUniswapSwapReturn {
  step: SwapStep;
  error: string | null;
  /** Last successful quote — UI uses for slippage display. */
  lastQuote: QuoteResult | null;
  /** Tx hashes from the most recent run. */
  approveTxHash: `0x${string}` | null;
  swapTxHash: `0x${string}` | null;
  quote: (args: QuoteRequest) => Promise<QuoteResult>;
  swap: (args: SwapInput) => Promise<void>;
  reset: () => void;
}

export interface SwapInput {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Pool fee tier; defaults to 0.3%. */
  fee?: PoolFee;
  /** Slippage in basis points (e.g. 50 = 0.5%). */
  slippageBps?: number;
  /** Recipient — defaults to the user's effective address. */
  recipient?: Address;
}

export function useUniswapSwap(): UseUniswapSwapReturn {
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWriteAndWait } = useUnifiedWrite();

  const [step, setStep] = useState<SwapStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastQuote, setLastQuote] = useState<QuoteResult | null>(null);
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | null>(null);
  const [swapTxHash, setSwapTxHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setLastQuote(null);
    setApproveTxHash(null);
    setSwapTxHash(null);
  }, []);

  /** Read-only quote via simulateContract on QuoterV2.
   *  Returns ALL four output fields so the UI can render gas + tick depth. */
  const quote = useCallback(
    async (args: QuoteRequest): Promise<QuoteResult> => {
      if (!publicClient) {
        throw new Error("Public client unavailable");
      }
      const fee = args.fee ?? POOL_FEE.MEDIUM;
      const quoter = UNISWAP_QUOTER_V2[args.chainId];
      if (!quoter) throw new Error(`Token swap is not available on chain ${args.chainId}`);
      const { result } = await publicClient.simulateContract({
        address: quoter,
        abi: QuoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: args.tokenIn,
            tokenOut: args.tokenOut,
            amountIn: args.amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] =
        result as readonly [bigint, bigint, number, bigint];
      const r: QuoteResult = {
        amountOut,
        sqrtPriceX96After,
        initializedTicksCrossed,
        gasEstimate,
      };
      setLastQuote(r);
      return r;
    },
    [publicClient],
  );

  /** Approve (if needed) + exactInputSingle. */
  const swap = useCallback(
    async (args: SwapInput) => {
      if (!effectiveAddress) {
        throw new Error("Connect a wallet first");
      }
      if (!publicClient) {
        throw new Error("Public client unavailable");
      }

      setError(null);
      setApproveTxHash(null);
      setSwapTxHash(null);

      const fee = args.fee ?? POOL_FEE.MEDIUM;
      const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
      const recipient = (args.recipient ?? effectiveAddress) as Address;
      const router = UNISWAP_SWAP_ROUTER_02[activeChainId];
      if (!router) throw new Error(`Token swap is not available on chain ${activeChainId}`);

      try {
        // ── Step 1: quote so we can compute amountOutMinimum ─────────
        const q = await quote({
          chainId: activeChainId,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee,
        });
        const amountOutMinimum = applySlippage(q.amountOut, slippageBps);

        // ── Step 2: ERC20 approve when needed ────────────────────────
        const allowance = (await publicClient.readContract({
          address: args.tokenIn,
          abi: erc20Abi,
          functionName: "allowance",
          args: [effectiveAddress as Address, router],
        })) as bigint;

        if (allowance < args.amountIn) {
          setStep("approving");
          // Max-approve so subsequent swaps don't pay gas to re-approve.
          const MAX = (1n << 256n) - 1n;
          const approveTx = await unifiedWriteAndWait({
            address: args.tokenIn,
            abi: erc20Abi,
            functionName: "approve",
            args: [router, MAX],
            gas: BigInt(120_000),
          });
          setApproveTxHash(approveTx.hash);
        }

        // ── Step 3: exactInputSingle ────────────────────────────────
        setStep("swapping");
        const swapArgs = buildExactInputSingleArgs({
          chainId: activeChainId,
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee,
          recipient,
          amountIn: args.amountIn,
          amountOutMinimum,
        });
        const swapResult = await unifiedWriteAndWait({
          address: router,
          abi: SwapRouter02Abi,
          functionName: "exactInputSingle",
          args: swapArgs,
          gas: BigInt(400_000),
        });
        setSwapTxHash(swapResult.hash);
        setStep("complete");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep("error");
        throw err;
      }
    },
    [effectiveAddress, publicClient, activeChainId, unifiedWriteAndWait, quote],
  );

  return {
    step,
    error,
    lastQuote,
    approveTxHash,
    swapTxHash,
    quote,
    swap,
    reset,
  };
}
