import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useFeatureKit. The consolidated primitive that
// every new write-flow hook should use. Bakes in: submit-guard +
// state-machine + approval-flow + encrypt + unified-write +
// receipt-wait + activity-insert + cross-tab-broadcast +
// query-invalidate + error-to-user mapping + rate-limit. Tested
// here in isolation so each surface is regression-fenced before
// callers depend on it.
//
// CRITICAL pins:
//   - 6-step state machine (idle / approving / encrypting /
//     sending / success / error) flips through the lifecycle even
//     when the caller's fn doesn't await the write callback's
//     setState (the kit drives state itself, the caller's fn just
//     orchestrates encrypt + write).
//   - 4-preflight gate: no address / no publicClient / no cofhe
//     connection / rate-limit-blocked all toast a specific error
//     and return null BEFORE the caller's fn runs (no wasted
//     encrypt cycles).
//   - Rate limiter is localStorage-backed with a 'blank:rl:' key
//     prefix; filters by `now - t < windowMs`; on accept it pushes
//     the new timestamp + caps the stored array at `max` length so
//     a long-stale window doesn't grow the localStorage value
//     unboundedly; on reject it WRITES BACK the filtered (no-new)
//     array so stale entries are GC'd even on the blocked path;
//     fail-open if localStorage throws (defensive).
//   - Approval branch ONLY fires when config.approval is set AND
//     isVaultApproved(spender) returns false; first-time path calls
//     unifiedWrite with approvePlaintext + MAX_UINT64 + then waits
//     for receipt + checks revert + calls markVaultApproved on
//     success; cached path skips the entire branch; the toast id
//     used for the approval loading state is reused for the
//     success / failure toast so the user sees ONE updating
//     notification (not 2 stacked).
//   - Main tx revert -> 'Transaction reverted on-chain' thrown +
//     friendly classifier applied + state.error preserved as the
//     friendly message NOT the raw revert; default classifier
//     6-branch: user-rejected -> 'Transaction rejected'; out-of-gas
//     -> 'Not enough gas — fund your wallet'; allowance -> 'Approval
//     needed — please retry'; network/timeout/rpc -> 'Network error
//     — please retry'; revert -> 'Transaction reverted on-chain';
//     fallback truncation at 120 chars with '…' suffix.
//   - approvalErrorRegex auto-clears the cache when the error msg
//     matches; default regex covers allowance / approve /
//     insufficient / transfer-amount-exceeds; caller can override
//     for hook-specific patterns; clear ONLY fires when
//     config.approval is also set (no point clearing a cache that
//     doesn't exist).
//   - classifyError caller-provided wins over default classifier
//     when it returns non-null; null falls through to default.
//   - Activity log: outcome.activity inserts a row with kit-filled
//     tx_hash + activity_type + block_number; outcome.
//     activityForRecipient (when set) inserts a SECOND row with
//     `${hash}:r` tx_hash suffix for dedup uniqueness so the
//     constraint doesn't collapse the two rows.
//   - guard ref-based concurrent-submit lock: second run() while
//     first in-flight returns null + toasts 'Already in flight.
//     Please wait.' (the kit wraps useSubmissionGuard which uses
//     useRef so it's NOT affected by state batching).
//   - broadcastAction + invalidateBalanceQueries fire AFTER both
//     activity inserts (NOT between them) so the cross-tab listener
//     refetch sees both rows.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useSubmissionGuardMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const clearVaultApprovalMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const toastFnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useUnifiedWrite", () => ({
  useUnifiedWrite: useUnifiedWriteMock,
}));
vi.mock("@/hooks/useSubmissionGuard", () => ({
  useSubmissionGuard: useSubmissionGuardMock,
}));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: useCofheEncryptMock,
  useCofheConnection: useCofheConnectionMock,
}));
vi.mock("./supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("./cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("./query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("./approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
  clearVaultApproval: clearVaultApprovalMock,
}));
vi.mock("./abis", () => ({ FHERC20VaultAbi: [] }));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(toastFnMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  }),
}));

import { useFeatureKit } from "./feature-kit";
import { ACTIVITY_TYPES } from "./activity-types";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const VAULT = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const HUB = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const USDC = "0x3333333333333333333333333333333333333333" as `0x${string}`;

const unifiedWriteMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

// Guard helper: by default, invokes the inner fn and returns its result.
// Override per-test to simulate in-flight blocking.
function passthroughGuard(): typeof useSubmissionGuardMock {
  const guardFn = vi.fn(async (fn: () => Promise<unknown>) => {
    const result = await fn();
    return { result, guarded: false };
  });
  return guardFn as unknown as typeof useSubmissionGuardMock;
}

beforeEach(() => {
  // Clear localStorage between tests so rate-limit windows don't leak
  try { localStorage.clear(); } catch { /* jsdom may not have it */ }

  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useSubmissionGuardMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  clearVaultApprovalMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  toastFnMock.mockReset();
  unifiedWriteMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: {} });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useSubmissionGuardMock.mockImplementation(() => passthroughGuard());
  isVaultApprovedMock.mockReturnValue(true);
  toastLoadingMock.mockReturnValue("tid");
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
  });
  encryptInputsAsyncMock.mockImplementation(async (inputs: unknown[]) =>
    inputs.map((_, i) => ({ ctHash: BigInt(i + 1), signature: "0xenc" })),
  );
  insertActivityMock.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────
//  Initial state + preflight
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — initial state + preflight (§15.x)", () => {
  it("returns state idle + null error/txHash + 4 expected fields", () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    expect(result.current.state).toEqual({
      step: "idle",
      error: null,
      txHash: null,
    });
    expect(result.current.address).toBe(ME);
    expect(result.current.chainId).toBe(11155111);
    expect(typeof result.current.run).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  it("no address -> 'Connect your wallet first' + null + fn NOT called", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn();
    let r: unknown;
    await act(async () => {
      r = await result.current.run(fn as never);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect your wallet first");
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> 'Network not ready' + null", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn();
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Network not ready. Please retry.",
    );
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("cofhe not connected -> 'FHE is still initializing' + null", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn();
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "FHE is still initializing. Please retry in a moment.",
    );
    expect(fn).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Rate limiter
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — rate limit (§15.x)", () => {
  it("first call within window -> allowed + timestamp pushed", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        rateLimit: { key: "test", windowMs: 60_000, max: 3 },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem("blank:rl:test") || "[]");
    expect(stored).toHaveLength(1);
  });

  it("max reached within window -> blocked + 'Too many requests' toast + fn NOT called", async () => {
    // Seed 3 fresh timestamps
    const now = Date.now();
    localStorage.setItem(
      "blank:rl:test",
      JSON.stringify([now - 1000, now - 2000, now - 3000]),
    );
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        rateLimit: { key: "test", windowMs: 60_000, max: 3 },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Too many requests. Please try again later.",
    );
  });

  it("stale timestamps (>windowMs) filtered out -> allowed", async () => {
    const now = Date.now();
    localStorage.setItem(
      "blank:rl:test",
      JSON.stringify([
        now - 70_000, // stale (>60s window)
        now - 80_000,
        now - 90_000,
      ]),
    );
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        rateLimit: { key: "test", windowMs: 60_000, max: 3 },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("blocked path STILL writes back filtered array (GC stale entries)", async () => {
    const now = Date.now();
    // 3 fresh + 2 stale -> still 3 fresh in window, BLOCK
    localStorage.setItem(
      "blank:rl:test",
      JSON.stringify([
        now - 1000,
        now - 2000,
        now - 3000,
        now - 80_000, // stale
        now - 90_000, // stale
      ]),
    );
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        rateLimit: { key: "test", windowMs: 60_000, max: 3 },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn);
    });
    const stored = JSON.parse(localStorage.getItem("blank:rl:test") || "[]");
    expect(stored).toHaveLength(3); // stale dropped, no new entry pushed
  });

  it("caps stored array at `max` length (slice(-max))", async () => {
    // Allow N=3 in window
    const now = Date.now();
    localStorage.setItem(
      "blank:rl:test",
      JSON.stringify([now - 1000, now - 2000]),
    );
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        rateLimit: { key: "test", windowMs: 60_000, max: 3 },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn);
    });
    const stored = JSON.parse(localStorage.getItem("blank:rl:test") || "[]");
    expect(stored.length).toBeLessThanOrEqual(3);
  });
});

// ───────────────────────────────────────────────────────────
//  Approval branch
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — approval branch (§15.x)", () => {
  it("approval cached -> skip approve, single write call", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    const fn = vi.fn(async ({ write }) => {
      const hash = await write({
        address: HUB,
        abi: [],
        functionName: "doIt",
        args: [],
        gas: 5_000_000n,
      });
      return { hash };
    });
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1); // only the main write
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval missing -> approve fires + markVaultApproved on success", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    const fn = vi.fn(async ({ write }) => {
      const hash = await write({
        address: HUB,
        abi: [],
        functionName: "doIt",
        args: [],
        gas: 5_000_000n,
      });
      return { hash };
    });
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(2); // approve + main
    const approveCall = unifiedWriteMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(HUB);
    expect(markVaultApprovedMock).toHaveBeenCalledWith(HUB);
  });

  it("approval reverted -> throws + state.error + main write NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    waitForTransactionReceiptMock.mockResolvedValueOnce({
      status: "reverted",
      blockNumber: 5n,
    });
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    let r: unknown;
    await act(async () => {
      r = await result.current.run(fn as never);
    });
    expect(r).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(fn).toHaveBeenCalledTimes(0); // main fn never ran
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval throw -> approval-failed toast + main write NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteMock.mockRejectedValueOnce(new Error("rpc fail"));
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    const fn = vi.fn(async () => ({ hash: "0xtxhash" as `0x${string}` }));
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Approval failed", expect.any(Object));
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("config.approval not set -> skip approve entirely (no isVaultApproved call)", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn(async ({ write }) => {
      const hash = await write({
        address: HUB,
        abi: [],
        functionName: "doIt",
        args: [],
        gas: 5_000_000n,
      });
      return { hash };
    });
    await act(async () => {
      await result.current.run(fn as never);
    });
    expect(isVaultApprovedMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1); // only main
  });
});

// ───────────────────────────────────────────────────────────
//  run() happy path
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — run happy path (§15.x)", () => {
  it("caller fn gets address + encrypt + write in ctx", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn(async (ctx) => {
      expect(ctx.address).toBe(ME);
      expect(typeof ctx.encrypt).toBe("function");
      expect(typeof ctx.write).toBe("function");
      const hash = await ctx.write({
        address: HUB,
        abi: [],
        functionName: "doIt",
        args: [],
        gas: 5_000_000n,
      });
      return { hash };
    });
    await act(async () => {
      await result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("happy path: state machine -> success + txHash + return hash", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    let r: unknown;
    await act(async () => {
      r = await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(r).toBe("0xtxhash");
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.txHash).toBe("0xtxhash");
    expect(result.current.state.error).toBeNull();
  });

  it("activity logged with kit-filled tx_hash + activity_type + block_number", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async ({ address }) => ({
        hash: "0xtxhash" as `0x${string}`,
        activity: {
          user_from: address,
          user_to: ALICE,
          note: "hi",
          token_address: USDC,
          contract_address: HUB,
        },
      }));
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.activity_type).toBe("payment");
    expect(row.block_number).toBe(5);
    expect(row.user_from).toBe(ME);
    expect(row.user_to).toBe(ALICE);
  });

  it("activityForRecipient inserts SECOND row with `:r` tx_hash suffix", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async ({ address }) => ({
        hash: "0xtxhash" as `0x${string}`,
        activity: {
          user_from: address,
          user_to: ALICE,
          note: "hi",
          token_address: USDC,
          contract_address: HUB,
        },
        activityForRecipient: {
          user_from: address,
          user_to: ALICE,
          note: "received",
          token_address: USDC,
          contract_address: HUB,
        },
      }));
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    expect(insertActivityMock.mock.calls[0][0].tx_hash).toBe("0xtxhash");
    expect(insertActivityMock.mock.calls[1][0].tx_hash).toBe("0xtxhash:r");
  });

  it("activity NOT inserted when outcome.activity is undefined", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("broadcastAction + invalidateBalanceQueries fire after success", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("waitForTransactionReceipt called with config.confirmations (default 1)", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xtxhash",
      confirmations: 1,
    });
  });

  it("config.confirmations = 3 -> passed through to receipt wait", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        confirmations: 3,
      }),
    );
    await act(async () => {
      await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xtxhash",
      confirmations: 3,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Error path + classifier
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — error path + default classifier (§15.x)", () => {
  it("main tx reverted -> state.step='error' + friendly 'Transaction reverted' + null", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 5n,
    });
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    let r: unknown;
    await act(async () => {
      r = await result.current.run(async () => ({
        hash: "0xtxhash" as `0x${string}`,
      }));
    });
    expect(r).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("Transaction reverted on-chain");
  });

  it("default classifier: user-rejected -> 'Transaction rejected'", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("User rejected the request");
      });
    });
    expect(result.current.state.error).toBe("Transaction rejected");
  });

  it("default classifier: insufficient funds -> 'Not enough gas — fund your wallet'", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("insufficient funds for gas");
      });
    });
    expect(result.current.state.error).toBe(
      "Not enough gas — fund your wallet",
    );
  });

  it("default classifier: allowance -> 'Approval needed — please retry'", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("ERC20: insufficient allowance");
      });
    });
    expect(result.current.state.error).toBe(
      "Approval needed — please retry",
    );
  });

  it("default classifier: network timeout -> 'Network error — please retry'", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("rpc timeout after 30s");
      });
    });
    expect(result.current.state.error).toBe("Network error — please retry");
  });

  it("default classifier: unmatched short msg -> passes through", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("something obscure happened");
      });
    });
    expect(result.current.state.error).toBe("something obscure happened");
  });

  it("default classifier: long msg truncated at 120 chars with '…' suffix", async () => {
    const longMsg = "x".repeat(500);
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error(longMsg);
      });
    });
    const err = result.current.state.error!;
    expect(err.length).toBeLessThanOrEqual(121); // 120 + '…'
    expect(err.endsWith("…")).toBe(true);
  });

  it("custom classifyError returning non-null overrides default", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        classifyError: () => "Custom friendly message",
      }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("any raw error");
      });
    });
    expect(result.current.state.error).toBe("Custom friendly message");
  });

  it("custom classifyError returning null falls through to default", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        classifyError: () => null,
      }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("User rejected");
      });
    });
    // Default classifier still applies
    expect(result.current.state.error).toBe("Transaction rejected");
  });
});

// ───────────────────────────────────────────────────────────
//  approvalErrorRegex + clearVaultApproval
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — approval cache clearing on error (§15.x)", () => {
  it("default regex + allowance error + approval configured -> clearVaultApproval(spender)", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("insufficient allowance");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });

  it("'transfer amount exceeds' error -> clearVaultApproval", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("transfer amount exceeds balance");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });

  it("unrelated error (rpc fail) -> NO clearVaultApproval call", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
      }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("rpc network timeout");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });

  it("no approval configured -> clearVaultApproval NEVER called even on allowance error", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("insufficient allowance");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
  });

  it("custom approvalErrorRegex overrides default", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({
        activityType: ACTIVITY_TYPES.PAYMENT,
        approval: { vault: VAULT, spender: HUB },
        approvalErrorRegex: /CUSTOM_PATTERN/,
      }),
    );
    // Default would match 'allowance', custom only matches 'CUSTOM_PATTERN'
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("insufficient allowance");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledTimes(0);
    // Now hit the custom pattern
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("CUSTOM_PATTERN matched");
      });
    });
    expect(clearVaultApprovalMock).toHaveBeenCalledWith(HUB);
  });
});

// ───────────────────────────────────────────────────────────
//  Guard (concurrent submit)
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — concurrent submit guard (§15.x)", () => {
  it("guarded=true -> 'Already in flight' toast + returns null", async () => {
    // Make the guard return { result: undefined, guarded: true } so the
    // kit takes the 'guarded' branch.
    const blockedGuard = vi.fn(async () => ({
      result: undefined,
      guarded: true,
    }));
    useSubmissionGuardMock.mockReturnValue(blockedGuard);
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    const fn = vi.fn();
    let r: unknown;
    await act(async () => {
      r = await result.current.run(fn as never);
    });
    expect(r).toBeNull();
    expect(toastFnMock).toHaveBeenCalledWith(
      "Already in flight. Please wait.",
      expect.any(Object),
    );
    expect(fn).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useFeatureKit — reset (§15.x)", () => {
  it("reset clears state back to initial", async () => {
    const { result } = renderHook(() =>
      useFeatureKit({ activityType: ACTIVITY_TYPES.PAYMENT }),
    );
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("fail");
      });
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.state).toEqual({
      step: "idle",
      error: null,
      txHash: null,
    });
  });
});
