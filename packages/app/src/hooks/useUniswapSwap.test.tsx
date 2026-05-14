import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useUniswapSwap. Single-pool Uniswap v3 swap hook on
// top of lib/uniswap.ts. Two entrypoints: quote (read-only) and swap
// (approve-if-needed + exactInputSingle).
//
// CRITICAL pins:
//   - quote uses simulateContract (eth_call), NOT a write call. QuoterV2
//     is non-state-mutating despite the `nonpayable` ABI tag — it
//     intentionally reverts mid-execution and returns data. The SDK
//     pattern is to call via simulateContract / eth_call, which Viem
//     handles as part of revert decoding. A regression that switched to
//     writeContract would charge gas and revert every quote.
//   - swap step state machine: idle -> (approving)? -> swapping ->
//     complete OR error. The approving step is OPTIONAL — gated on
//     allowance < amountIn. Pre-approved tokens skip directly to
//     swapping.
//   - MAX-uint256 approve: ensures subsequent swaps for the same token
//     don't pay gas to re-approve. Anything less is a per-swap cost
//     regression.
//   - amountOutMinimum derived from quote.amountOut via applySlippage —
//     the swap's own quote drives the slippage budget. Calling swap
//     WITHOUT first quoting (handled internally) would let a stale
//     external quote slip below the trade.
//   - recipient defaults to effectiveAddress when args.recipient omitted.
//     A regression that defaulted to zero-address would burn the
//     output token.
//   - slippageBps defaults to DEFAULT_SLIPPAGE_BPS (50bps = 0.5%) when
//     omitted. Aggressive defaults like 5bps would break thin testnet
//     pools constantly.
//   - fee tier defaults to POOL_FEE.MEDIUM (3000 = 0.3%) when omitted.
//   - quote / swap separately error on missing publicClient and missing
//     effectiveAddress (swap only) — defensive surface for the
//     "wallet disconnected mid-flow" case.
//   - reset() clears step + error + lastQuote + both tx hashes back to
//     idle/null. After a failed swap, the user should be able to retry
//     from a clean state without unmount/remount.
//   - swap error captures err.message (or String(err) for non-Error
//     throws) into setError + flips step to "error" AND re-throws so
//     the caller can decide whether to surface a toast.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));

// Re-use the real uniswap lib (POOL_FEE, applySlippage, builders, ABI
// constants) so the hook's actual code paths exercise the same helpers
// that production calls. Mocking these would shadow the load-bearing
// math + arg-shape behaviour we want to verify.

import { useUniswapSwap } from "./useUniswapSwap";
import {
  UNISWAP_QUOTER_V2,
  UNISWAP_SWAP_ROUTER_02,
  POOL_FEE,
  DEFAULT_SLIPPAGE_BPS,
  applySlippage,
} from "@/lib/uniswap";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN_IN = "0x1111111111111111111111111111111111111111" as const;
const TOKEN_OUT = "0x2222222222222222222222222222222222222222" as const;
const CHAIN_ID = 11155111;

const simulateContractMock = vi.fn();
const readContractMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  simulateContractMock.mockReset();
  readContractMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: CHAIN_ID });
  usePublicClientMock.mockReturnValue({
    simulateContract: simulateContractMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });

  // Default quote: amountIn=100, amountOut=99 (1% slippage already)
  simulateContractMock.mockResolvedValue({
    result: [99n, 0n, 0, 50_000n],
  });
  // Pre-approved by default
  readContractMock.mockResolvedValue((1n << 256n) - 1n);
  unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xtx" });
});

// ----- initial state ----- //

describe("useUniswapSwap — initial state (§15.x)", () => {
  it("returns idle step + null error/lastQuote/txHashes on mount", () => {
    const { result } = renderHook(() => useUniswapSwap());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.lastQuote).toBeNull();
    expect(result.current.approveTxHash).toBeNull();
    expect(result.current.swapTxHash).toBeNull();
  });
});

// ----- quote ----- //

describe("useUniswapSwap — quote (§15.x)", () => {
  it("calls simulateContract (NOT writeContract) on QuoterV2", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(simulateContractMock).toHaveBeenCalledTimes(1);
    const call = simulateContractMock.mock.calls[0][0];
    expect(call.address).toBe(UNISWAP_QUOTER_V2[CHAIN_ID]);
    expect(call.functionName).toBe("quoteExactInputSingle");
  });

  it("returns all 4 QuoteResult fields (amountOut, sqrtPriceX96After, ticks, gas)", async () => {
    simulateContractMock.mockResolvedValue({
      result: [9999n, 12345n, 7, 200_000n],
    });
    const { result } = renderHook(() => useUniswapSwap());
    let q: { amountOut: bigint; sqrtPriceX96After: bigint; initializedTicksCrossed: number; gasEstimate: bigint };
    await act(async () => {
      q = await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(q!.amountOut).toBe(9999n);
    expect(q!.sqrtPriceX96After).toBe(12345n);
    expect(q!.initializedTicksCrossed).toBe(7);
    expect(q!.gasEstimate).toBe(200_000n);
  });

  it("stores result in lastQuote state", async () => {
    simulateContractMock.mockResolvedValue({
      result: [777n, 0n, 0, 0n],
    });
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(result.current.lastQuote?.amountOut).toBe(777n);
  });

  it("fee defaults to POOL_FEE.MEDIUM (3000 / 0.3%) when omitted", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const args = simulateContractMock.mock.calls[0][0].args[0];
    expect(args.fee).toBe(POOL_FEE.MEDIUM);
  });

  it("explicit fee tier passes through", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
        fee: POOL_FEE.LOWEST,
      });
    });
    const args = simulateContractMock.mock.calls[0][0].args[0];
    expect(args.fee).toBe(POOL_FEE.LOWEST);
  });

  it("sqrtPriceLimitX96=0 (unlimited) passed in quote args", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.quote({
        chainId: CHAIN_ID,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const args = simulateContractMock.mock.calls[0][0].args[0];
    expect(args.sqrtPriceLimitX96).toBe(0n);
  });

  it("no publicClient -> throws 'Public client unavailable'", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useUniswapSwap());
    await expect(
      act(async () =>
        result.current.quote({
          chainId: CHAIN_ID,
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          amountIn: 100n,
        }),
      ),
    ).rejects.toThrow("Public client unavailable");
  });

  it("simulateContract rejection propagates (no state mutation)", async () => {
    simulateContractMock.mockRejectedValue(new Error("no pool"));
    const { result } = renderHook(() => useUniswapSwap());
    await expect(
      act(async () =>
        result.current.quote({
          chainId: CHAIN_ID,
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          amountIn: 100n,
        }),
      ),
    ).rejects.toThrow("no pool");
    expect(result.current.lastQuote).toBeNull();
  });
});

// ----- swap: defensive guards ----- //

describe("useUniswapSwap — swap guards (§15.x)", () => {
  it("no effectiveAddress -> throws 'Connect a wallet first'", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useUniswapSwap());
    await expect(
      act(async () =>
        result.current.swap({
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          amountIn: 100n,
        }),
      ),
    ).rejects.toThrow("Connect a wallet first");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> throws 'Public client unavailable'", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useUniswapSwap());
    await expect(
      act(async () =>
        result.current.swap({
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          amountIn: 100n,
        }),
      ),
    ).rejects.toThrow("Public client unavailable");
  });
});

// ----- swap: happy paths ----- //

describe("useUniswapSwap — swap happy path (§15.x)", () => {
  it("pre-approved token: skips approving step, goes straight to swapping", async () => {
    // allowance huge -> skip approve
    readContractMock.mockResolvedValue((1n << 256n) - 1n);
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    // Only ONE write (the swap), no approve
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(result.current.approveTxHash).toBeNull();
    expect(result.current.step).toBe("complete");
  });

  it("step transitions: idle -> swapping -> complete on success", async () => {
    let resolveSwap: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise((res) => {
        resolveSwap = res;
      }),
    );
    const { result } = renderHook(() => useUniswapSwap());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    await waitFor(() => expect(result.current.step).toBe("swapping"));
    await act(async () => {
      resolveSwap({ hash: "0xswap" });
      await p;
    });
    expect(result.current.step).toBe("complete");
    expect(result.current.swapTxHash).toBe("0xswap");
  });

  it("amountOutMinimum = applySlippage(quote.amountOut, slippageBps)", async () => {
    // amountOut=1000, slippageBps=50 (0.5%) -> 1000 * 9950/10000 = 995
    simulateContractMock.mockResolvedValue({
      result: [1000n, 0n, 0, 0n],
    });
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const swapCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(swapCall.functionName).toBe("exactInputSingle");
    // exactInputSingle's tuple shape: { tokenIn, tokenOut, fee, recipient,
    // amountIn, amountOutMinimum, sqrtPriceLimitX96 }
    const params = swapCall.args[0];
    expect(params.amountOutMinimum).toBe(applySlippage(1000n, DEFAULT_SLIPPAGE_BPS));
  });

  it("recipient defaults to effectiveAddress when omitted", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const params = unifiedWriteAndWaitMock.mock.calls[0][0].args[0];
    expect(params.recipient).toBe(ME);
  });

  it("explicit recipient passes through", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
        recipient: ALICE,
      });
    });
    const params = unifiedWriteAndWaitMock.mock.calls[0][0].args[0];
    expect(params.recipient).toBe(ALICE);
  });

  it("fee tier defaults to MEDIUM (3000) when omitted in swap args", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const params = unifiedWriteAndWaitMock.mock.calls[0][0].args[0];
    expect(params.fee).toBe(POOL_FEE.MEDIUM);
  });

  it("custom slippageBps changes amountOutMinimum", async () => {
    simulateContractMock.mockResolvedValue({
      result: [10_000n, 0n, 0, 0n],
    });
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
        slippageBps: 100, // 1%
      });
    });
    const params = unifiedWriteAndWaitMock.mock.calls[0][0].args[0];
    expect(params.amountOutMinimum).toBe(applySlippage(10_000n, 100));
  });

  it("swap targets UNISWAP_SWAP_ROUTER_02 for activeChainId", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(UNISWAP_SWAP_ROUTER_02[CHAIN_ID]);
  });

  it("swap call uses gas=400_000 (FHE precompile margin for thin testnet pools)", async () => {
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.gas).toBe(400_000n);
  });
});

// ----- swap: approve path ----- //

describe("useUniswapSwap — approve path (§15.x)", () => {
  it("allowance < amountIn -> approve fired with MAX-uint256", async () => {
    // First call (allowance) returns small; subsequent calls don't matter
    readContractMock.mockResolvedValueOnce(50n);
    let approveCallCount = 0;
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      approveCallCount += 1;
      if (args.functionName === "approve") {
        return { hash: `0xapprove` };
      }
      return { hash: `0xswap` };
    });
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(approveCallCount).toBe(2);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    const approveCall = unifiedWriteAndWaitMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === "approve",
    );
    expect(approveCall).toBeDefined();
    expect(approveCall![0].args[1]).toBe((1n << 256n) - 1n); // MAX-uint256
    expect(result.current.approveTxHash).toBe("0xapprove");
  });

  it("allowance == amountIn -> NO approve (exact-allowance path)", async () => {
    readContractMock.mockResolvedValue(100n); // exact match
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    // Only ONE write (swap), no approve
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const onlyCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(onlyCall.functionName).toBe("exactInputSingle");
    expect(result.current.approveTxHash).toBeNull();
  });

  it("approve uses gas=120_000 (smaller than swap gas)", async () => {
    readContractMock.mockResolvedValueOnce(0n);
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => ({
      hash: args.functionName === "approve" ? "0xa" : "0xs",
    }));
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    const approveCall = unifiedWriteAndWaitMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === "approve",
    );
    expect(approveCall![0].gas).toBe(120_000n);
  });

  it("step transitions: idle -> approving -> swapping -> complete", async () => {
    readContractMock.mockResolvedValueOnce(0n);
    let resolveApprove: (v: unknown) => void = () => {};
    let resolveSwap: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "approve") {
        return new Promise((res) => {
          resolveApprove = res;
        });
      }
      return new Promise((res) => {
        resolveSwap = res;
      });
    });
    const { result } = renderHook(() => useUniswapSwap());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    await waitFor(() => expect(result.current.step).toBe("approving"));
    await act(async () => {
      resolveApprove({ hash: "0xa" });
    });
    await waitFor(() => expect(result.current.step).toBe("swapping"));
    await act(async () => {
      resolveSwap({ hash: "0xs" });
      await p;
    });
    expect(result.current.step).toBe("complete");
  });

  it("approve allowance check targets (effectiveAddress, router)", async () => {
    readContractMock.mockResolvedValue(0n);
    unifiedWriteAndWaitMock.mockImplementation(async () => ({ hash: "0x" }));
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN_IN,
        functionName: "allowance",
        args: [ME, UNISWAP_SWAP_ROUTER_02[CHAIN_ID]],
      }),
    );
  });
});

// ----- swap: error path ----- //

describe("useUniswapSwap — error path (§15.x)", () => {
  // Helper: catch inside act so state setters in the catch block flush
  // before the surrounding expect runs. Using `await expect(...).rejects`
  // returns before React batches the state update.
  async function swapAndCatch(
    result: { current: ReturnType<typeof useUniswapSwap> },
    args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
  ): Promise<unknown> {
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.swap(args);
      } catch (e) {
        thrown = e;
      }
    });
    return thrown;
  }

  it("quote rejection -> step='error' + error message + re-throws", async () => {
    simulateContractMock.mockRejectedValue(new Error("no pool at 0.30% fee"));
    const { result } = renderHook(() => useUniswapSwap());
    const thrown = await swapAndCatch(result, {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100n,
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("no pool at 0.30% fee");
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("no pool at 0.30% fee");
  });

  it("approve rejection -> step='error' (does not reach swap)", async () => {
    readContractMock.mockResolvedValueOnce(0n);
    unifiedWriteAndWaitMock.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "approve") throw new Error("user rejected");
      return Promise.resolve({ hash: "0xs" });
    });
    const { result } = renderHook(() => useUniswapSwap());
    const thrown = await swapAndCatch(result, {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100n,
    });
    expect((thrown as Error).message).toBe("user rejected");
    expect(result.current.step).toBe("error");
    expect(result.current.swapTxHash).toBeNull();
    // exactInputSingle should NOT have been called
    const swapCall = unifiedWriteAndWaitMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === "exactInputSingle",
    );
    expect(swapCall).toBeUndefined();
  });

  it("swap rejection -> step='error', re-throws (caller surfaces)", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("slippage exceeded"));
    const { result } = renderHook(() => useUniswapSwap());
    const thrown = await swapAndCatch(result, {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100n,
    });
    expect((thrown as Error).message).toBe("slippage exceeded");
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("slippage exceeded");
  });

  it("non-Error thrown value -> String(err) captured into error state", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue("string-not-error");
    const { result } = renderHook(() => useUniswapSwap());
    const thrown = await swapAndCatch(result, {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100n,
    });
    expect(thrown).toBe("string-not-error");
    expect(result.current.error).toBe("string-not-error");
  });
});

// ----- reset ----- //

describe("useUniswapSwap — reset (§15.x)", () => {
  it("reset clears step + error + lastQuote + approveTxHash + swapTxHash", async () => {
    // First, run a successful swap to populate state
    readContractMock.mockResolvedValueOnce(0n);
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => ({
      hash: args.functionName === "approve" ? "0xa" : "0xs",
    }));
    const { result } = renderHook(() => useUniswapSwap());
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(result.current.step).toBe("complete");
    expect(result.current.lastQuote).not.toBeNull();
    expect(result.current.approveTxHash).toBe("0xa");
    expect(result.current.swapTxHash).toBe("0xs");

    // Now reset
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.lastQuote).toBeNull();
    expect(result.current.approveTxHash).toBeNull();
    expect(result.current.swapTxHash).toBeNull();
  });

  it("reset after error allows clean retry", async () => {
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("first fail"));
    const { result } = renderHook(() => useUniswapSwap());
    // Catch inside act so state setters in the catch block flush before
    // the surrounding expect runs.
    await act(async () => {
      try {
        await result.current.swap({
          tokenIn: TOKEN_IN,
          tokenOut: TOKEN_OUT,
          amountIn: 100n,
        });
      } catch {
        /* swallow */
      }
    });
    expect(result.current.step).toBe("error");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    // Retry now succeeds
    unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xretry" });
    await act(async () => {
      await result.current.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 100n,
      });
    });
    expect(result.current.step).toBe("complete");
    expect(result.current.swapTxHash).toBe("0xretry");
  });
});
