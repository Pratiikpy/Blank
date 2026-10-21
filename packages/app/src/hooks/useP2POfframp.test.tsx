import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Covers the audit-fix surface of the offramp hook: escrow decrypt before
// paying fiat, the stale-dispute exit, and user-facing revert copy, plus the
// funding gate: on an upgraded P2POfframp a take leaves a Pending fill that
// only unlocks the fiat leg after confirmFunding proves the escrow.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const unifiedWriteAndWaitMock = vi.hoisted(() => vi.fn());
const decryptForViewMock = vi.hoisted(() => vi.fn());
const readContractMock = vi.hoisted(() => vi.fn());
const waitForTransactionReceiptMock = vi.hoisted(() => vi.fn());
const decryptForTxMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const connectedFlag = vi.hoisted(() => ({ value: true }));

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
  useCofheConnection: () => ({ connected: connectedFlag.value }),
  useCofheDecryptForView: () => ({ decryptForView: decryptForViewMock }),
  useCofheDecryptForTx: () => ({ decryptForTx: decryptForTxMock }),
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ P2POfframpAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/approval", () => ({ isVaultApproved: () => true, markVaultApproved: vi.fn() }));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
// Same logic, but time only advances when the helper sleeps, so a decrypt that
// never becomes ready times out instantly instead of after 90 real seconds.
vi.mock("@/lib/funding-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/funding-gate")>();
  return {
    ...actual,
    runFundingGate: (opts: Parameters<typeof actual.runFundingGate>[0]) => {
      let t = 0;
      return actual.runFundingGate({ ...opts, now: () => t, sleep: async (ms) => { t += ms; } });
    },
  };
});
vi.mock("@/lib/query-invalidation", () => ({ invalidateBalanceQueries: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }));

import { useP2POfframp, friendlyOfframpError } from "./useP2POfframp";
import { PENDING_EVENT_TOPIC } from "@/lib/pending-funding";

const OFFRAMP = "0x5981C437032Da38844AE9a3aa382F993b1B8444a" as const;

beforeEach(() => {
  readContractMock.mockReset();
  decryptForViewMock.mockReset();
  decryptForTxMock.mockReset();
  extractEventIdMock.mockReset();
  connectedFlag.value = true;
  unifiedWriteAndWaitMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: "0x00000000000000000000000000000000000000bb" });
  useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: { P2POfframp: OFFRAMP } });
  // refreshBook runs on mount; nextOfferId/nextFillId = 0 keeps it empty.
  // A pre-gate P2POfframp has no fillFunded, so that read fails by default.
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "fillFunded") throw new Error("execution reverted");
    return 0n;
  });
  usePublicClientMock.mockReturnValue({ readContract: readContractMock, waitForTransactionReceipt: waitForTransactionReceiptMock });
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

// ─── funding gate ───────────────────────────────────────────────────

const SIG = "0xsig" as const;
const TAKER = "0x00000000000000000000000000000000000000bb" as const;
const MAKER = "0x00000000000000000000000000000000000000aa" as const;
const HANDLE_HEX = `0x${"cd".repeat(32)}`;
const VAULT = "0x00000000000000000000000000000000000000cc" as const;
const padId = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const fillPendingLog = (id: bigint) => ({
  address: OFFRAMP,
  topics: [PENDING_EVENT_TOPIC.fill, padId(id), padId(5n)],
  data: "0x",
});

/** Upgraded P2POfframp. Fill states: 6 Pending, 0 Locked, 7 Voided. confirmFunding moves it. */
function gatedOfframp(over: { fillState?: number; fiat?: bigint; rate?: bigint; decimals?: number | "revert"; logs?: unknown[] } = {}) {
  const chain = { fillState: over.fillState ?? 6 };
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "fillFunded":
        return HANDLE_HEX;
      case "getOffer":
        return [MAKER, VAULT, over.fiat ?? 25_000_000n, over.rate ?? 1_000_000n, 4, "0x" + "ab".repeat(32), 0, 0];
      case "tokenDecimals":
        if (over.decimals === "revert") throw new Error("no such function");
        return over.decimals ?? 6;
      case "getFill":
        return [5n, TAKER, 25_000_000n, 1000, 0, "0x" + "00".repeat(32), chain.fillState];
      default:
        return 0n;
    }
  });
  unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string; args: unknown[] }) => {
    if (args.functionName === "confirmFunding") {
      chain.fillState = args.args[1] ? 0 : 7;
      return { hash: "0xconfirm", receipt: { status: "success", logs: [] } };
    }
    return { hash: "0xtake", receipt: { status: "success", logs: over.logs ?? [fillPendingLog(9n)] } };
  });
  return chain;
}

const confirmCalls = () => unifiedWriteAndWaitMock.mock.calls.filter((c) => c[0].functionName === "confirmFunding");
const takeCall = () =>
  unifiedWriteAndWaitMock.mock.calls.find((c) => c[0].functionName === "takeOffer" || c[0].functionName === "takeOfferExpecting")![0];

describe("useP2POfframp — takeOffer funding gate, funded escrow", () => {
  it("takes with a minimum from the displayed price, confirms, and only then reports Locked", async () => {
    gatedOfframp({ fiat: 25_000_000n, rate: 1_000_000n });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(takeCall().functionName).toBe("takeOfferExpecting");
    // $25.00 at $1.00 per USDC, 6 decimals: at least 25 USDC.
    expect(takeCall().args).toEqual([5n, 25_000_000n]);
    expect(decryptForTxMock).toHaveBeenCalledWith(BigInt(HANDLE_HEX), "ebool");
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0][0].args).toEqual([9n, true, SIG]);
    expect(out).toEqual({ txHash: "0xtake", fillId: 9n, status: "locked" });
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.lastFillId).toBe(9n);
  });

  it("minimum is fiat * 10^decimals / rate (non-trivial rate)", async () => {
    gatedOfframp({ fiat: 12_000_000n, rate: 1_200_000n });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await result.current.takeOffer(5n);
    });
    expect(takeCall().args).toEqual([5n, 10_000_000n]);
  });

  it("uses the vault's own decimals", async () => {
    gatedOfframp({ fiat: 5_000_000n, rate: 1_000_000n, decimals: 8 });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await result.current.takeOffer(5n);
    });
    expect(takeCall().args).toEqual([5n, 500_000_000n]);
  });

  it("a rate of zero is refused before any transaction", async () => {
    gatedOfframp({ rate: 0n });
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await expect(result.current.takeOffer(5n)).rejects.toThrow(/no price/);
    });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
  });

  it("someone else confirmed while the decrypt ran: no second confirmation, still Locked", async () => {
    const chain = gatedOfframp();
    decryptForTxMock.mockImplementation(async () => {
      chain.fillState = 0;
      return { decryptedValue: true, signature: SIG };
    });
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(confirmCalls()).toHaveLength(0);
    expect(out).toMatchObject({ status: "locked" });
  });
});

describe("useP2POfframp — takeOffer funding gate, short maker", () => {
  it("voids: throws the honest reason, never reports Locked", async () => {
    gatedOfframp();
    decryptForTxMock.mockResolvedValue({ decryptedValue: false, signature: SIG });
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await expect(result.current.takeOffer(5n)).rejects.toThrow("The maker's balance was too low; the offer is open again.");
    });
    expect(confirmCalls()[0][0].args).toEqual([9n, false, SIG]);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("The maker's balance was too low; the offer is open again.");
  });
});

describe("useP2POfframp — takeOffer funding gate, check does not finish", () => {
  it("decrypt never ready: fill stays Pending, status 'pending', no fake success", async () => {
    const chain = gatedOfframp();
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(out).toEqual({ txHash: "0xtake", fillId: 9n, status: "pending" });
    expect(chain.fillState).toBe(6);
    expect(confirmCalls()).toHaveLength(0);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toMatch(/not ready yet/);
    expect(result.current.state.error).toMatch(/Do not send fiat/);
    expect(result.current.state.isProcessing).toBe(false);
  });

  it("confirm fails: the real reason is surfaced and the fill is still recoverable", async () => {
    gatedOfframp();
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "confirmFunding") throw new Error("rpc: nonce too low");
      return { hash: "0xtake", receipt: { status: "success", logs: [fillPendingLog(9n)] } };
    });
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(out).toMatchObject({ status: "pending", fillId: 9n });
    expect(result.current.state.error).toMatch(/rpc: nonce too low/);
  });

  it("confirmPendingFill finishes a fill left Pending", async () => {
    const chain = gatedOfframp();
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await result.current.takeOffer(5n);
    });
    expect(chain.fillState).toBe(6);

    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    let verdict = "";
    await act(async () => {
      verdict = await result.current.confirmPendingFill(9n);
    });
    expect(verdict).toBe("locked");
    expect(confirmCalls()).toHaveLength(1);
    expect(chain.fillState).toBe(0);
  });

  it("confirmPendingFill reports a voided fill without sending anything", async () => {
    gatedOfframp({ fillState: 7 });
    const { result } = renderHook(() => useP2POfframp());
    let verdict = "";
    await act(async () => {
      verdict = await result.current.confirmPendingFill(9n);
    });
    expect(verdict).toBe("voided");
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
    expect(decryptForTxMock).not.toHaveBeenCalled();
  });

  it("confirmPendingFill on an already Locked fill is a no-op", async () => {
    gatedOfframp({ fillState: 0 });
    const { result } = renderHook(() => useP2POfframp());
    let verdict = "";
    await act(async () => {
      verdict = await result.current.confirmPendingFill(9n);
    });
    expect(verdict).toBe("locked");
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
  });

  it("confirmPendingFill refuses to run before the FHE session is connected", async () => {
    gatedOfframp();
    connectedFlag.value = false;
    const { result } = renderHook(() => useP2POfframp());
    expect(result.current.fheReady).toBe(false);
    await act(async () => {
      await expect(result.current.confirmPendingFill(9n)).rejects.toThrow(/FHE network connecting/);
    });
  });

  it("confirmPendingFill that cannot finish throws the reason and leaves the fill Pending", async () => {
    const chain = gatedOfframp();
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useP2POfframp());
    await act(async () => {
      await expect(result.current.confirmPendingFill(9n)).rejects.toThrow(/not ready yet/);
    });
    expect(chain.fillState).toBe(6);
    expect(result.current.state.step).toBe("error");
  });
});

describe("useP2POfframp — pre-gate contract fallback", () => {
  it("no fillFunded: plain takeOffer(offerId), no minimum read, no gate, Locked at once", async () => {
    extractEventIdMock.mockReturnValue(4);
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(takeCall().functionName).toBe("takeOffer");
    expect(takeCall().args).toEqual([5n]);
    expect(out).toEqual({ txHash: "0xtx", fillId: 4n, status: "locked" });
    expect(decryptForTxMock).not.toHaveBeenCalled();
    expect(readContractMock.mock.calls.some((c) => c[0].functionName === "getOffer" && c[0].args[0] === 5n)).toBe(false);
  });

  it("probe fails transiently on an upgraded contract: the FillPending log still routes to the gate", async () => {
    gatedOfframp();
    const base = readContractMock.getMockImplementation()!;
    let probed = false;
    readContractMock.mockImplementation(async (args: { functionName: string; args?: unknown[] }) => {
      if (args.functionName === "fillFunded" && !probed) {
        probed = true;
        throw new Error("rpc busy");
      }
      return base(args);
    });
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useP2POfframp());
    let out: Awaited<ReturnType<typeof result.current.takeOffer>> = null;
    await act(async () => {
      out = await result.current.takeOffer(5n);
    });
    expect(takeCall().functionName).toBe("takeOffer");
    expect(out).toMatchObject({ status: "locked", fillId: 9n });
    expect(confirmCalls()).toHaveLength(1);
  });
});

describe("useP2POfframp — fill state map", () => {
  it("labels Pending and Voided", async () => {
    const { FILL_STATE, FILL_STATE_LABEL } = await import("@/lib/offramp-fill-state");
    expect(FILL_STATE.Pending).toBe(6);
    expect(FILL_STATE.Voided).toBe(7);
    for (let s = 0; s <= 7; s++) expect(FILL_STATE_LABEL[s]).toBeTruthy();
  });

  it("friendlyOfframpError explains the confirmFunding reverts", () => {
    expect(friendlyOfframpError("P2POfframp: fill not pending")).toMatch(/already settled/);
    expect(friendlyOfframpError("P2POfframp: decryption not ready")).toMatch(/not ready yet/);
  });
});
