import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Covers the audit-fix surface of the offramp hook: escrow decrypt before
// paying fiat, the stale-dispute exit, and user-facing revert copy.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const unifiedWriteAndWaitMock = vi.hoisted(() => vi.fn());
const decryptForViewMock = vi.hoisted(() => vi.fn());
const readContractMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: () => ({ unifiedWriteAndWait: unifiedWriteAndWaitMock }) }));
vi.mock("./useFhePipeline", () => ({
  useFhePipeline: () => ({
    start: vi.fn(), onEncryptStep: vi.fn(), markSubmitting: vi.fn(), markConfirming: vi.fn(),
    markDone: vi.fn(), markFailed: vi.fn(), reset: vi.fn(), state: { phase: "idle" },
  }),
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: () => ({ encryptInputsAsync: vi.fn() }),
  useCofheConnection: () => ({ connected: true }),
  useCofheDecryptForView: () => ({ decryptForView: decryptForViewMock }),
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ P2POfframpAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/approval", () => ({ isVaultApproved: () => true, markVaultApproved: vi.fn() }));
vi.mock("@/lib/event-parser", () => ({ extractEventId: vi.fn() }));
vi.mock("@/lib/query-invalidation", () => ({ invalidateBalanceQueries: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }));

import { useP2POfframp, friendlyOfframpError } from "./useP2POfframp";

const OFFRAMP = "0x5981C437032Da38844AE9a3aa382F993b1B8444a" as const;

beforeEach(() => {
  readContractMock.mockReset();
  decryptForViewMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: "0x00000000000000000000000000000000000000bb" });
  useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: { P2POfframp: OFFRAMP } });
  // refreshBook runs on mount; nextOfferId/nextFillId = 0 keeps it empty.
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "nextOfferId" || functionName === "nextFillId" ? 0n : 0n,
  );
  usePublicClientMock.mockReturnValue({ readContract: readContractMock, waitForTransactionReceipt: vi.fn() });
  unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xtx", receipt: { status: "success", logs: [] } });
});

describe("useP2POfframp — escrow decrypt before paying fiat", () => {
  it("reads getEscrowedAmount(fillId) and decrypts it", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "getEscrowedAmount" ? 0xabcn : 0n,
    );
    decryptForViewMock.mockResolvedValue(500_000n);
    const { result } = renderHook(() => useP2POfframp());
    let v = 0n;
    await act(async () => {
      v = await result.current.decryptEscrowedAmount(7n);
    });
    expect(v).toBe(500_000n);
    const call = readContractMock.mock.calls.find((c) => c[0].functionName === "getEscrowedAmount");
    expect(call?.[0].args).toEqual([7n]);
    expect(decryptForViewMock).toHaveBeenCalledWith(0xabcn, "uint64");
  });

  it("returns 0n honestly when the vault moved nothing", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "getEscrowedAmount" ? 0xabcn : 0n,
    );
    decryptForViewMock.mockResolvedValue(0n);
    const { result } = renderHook(() => useP2POfframp());
    let v = 1n;
    await act(async () => {
      v = await result.current.decryptEscrowedAmount(7n);
    });
    expect(v).toBe(0n);
  });

  it("decrypt failure throws (never treated as funded)", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "getEscrowedAmount" ? 0xabcn : 0n,
    );
    decryptForViewMock.mockResolvedValue(null);
    const { result } = renderHook(() => useP2POfframp());
    await expect(result.current.decryptEscrowedAmount(7n)).rejects.toThrow(/decrypt/i);
  });

  it("zero handle throws", async () => {
    const { result } = renderHook(() => useP2POfframp());
    await expect(result.current.decryptEscrowedAmount(7n)).rejects.toThrow(/No escrow handle/);
  });

  it("offramp not deployed -> throws the not-deployed reason", async () => {
    useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: { P2POfframp: "0x0000000000000000000000000000000000000000" } });
    const { result } = renderHook(() => useP2POfframp());
    await expect(result.current.decryptEscrowedAmount(7n)).rejects.toThrow(/not yet deployed/);
  });
});

describe("useP2POfframp — resolveStaleDispute", () => {
  it("calls resolveStaleDispute(fillId)", async () => {
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await result.current.resolveStaleDispute(9n);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("resolveStaleDispute");
    expect(call.args).toEqual([9n]);
  });

  it("arbiter window still open -> mapped copy in the thrown error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("execution reverted: P2POfframp: arbiter window open"));
    const { result } = renderHook(() => useP2POfframp());
    await expect(result.current.resolveStaleDispute(9n)).rejects.toThrow("The arbiter still has time to rule on this dispute.");
  });
});

describe("useP2POfframp — takeOffer one-lock-per-taker copy", () => {
  it("'too many open locks' -> actionable copy", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("execution reverted: P2POfframp: too many open locks"));
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await expect(result.current.takeOffer(1n)).rejects.toThrow(/already have an open fill/);
    });
    expect(result.current.state.error).toMatch(/already have an open fill/);
  });
});

describe("friendlyOfframpError", () => {
  it("maps rail mismatch, vault allowlist, legacy dispute; passes unknown through", () => {
    expect(friendlyOfframpError("P2POfframp: provider/rail mismatch")).toMatch(/different rail/);
    expect(friendlyOfframpError("P2POfframp: vault not allowed")).toMatch(/not enabled/);
    expect(friendlyOfframpError("P2POfframp: legacy dispute, arbiter only")).toMatch(/Only the arbiter/);
    expect(friendlyOfframpError("rpc down")).toBe("rpc down");
  });
});
