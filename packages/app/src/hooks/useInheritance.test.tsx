import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useInheritance. The dead-man's-switch hook driving the
// Beneficiary Planning screen (covered by the screens-sweep test) —
// surfaces the on-chain plan tuple + 6 write operations (setHeir,
// setVaults, heartbeat, removeHeir, startClaim, finalizeClaim).
//
// CRITICAL pins:
//   - Plan tuple decoding: getPlan returns [heir, inactivityPeriod,
//     lastHeartbeat, claimStartedAt, active, vaults[]]. Bigints
//     coerce to Number for periods/timestamps; the address[] copies
//     via spread (not aliased). A regression that swapped tuple
//     positions would show wrong heir or wrong active state.
//   - Dual-row activity pattern on heir-affecting ops (setHeir,
//     removeHeir, startClaim, finalizeClaim): primary row for the
//     caller (user_to=caller) + secondary row for the counterparty
//     (user_to=counterparty) with tx_hash suffixed (":heir" /
//     ":owner") for dedup-key uniqueness. The secondary row is
//     SKIPPED when caller === counterparty (self-targeting). Without
//     the dual-row pattern, the counterparty's realtime subscription
//     never fires and they don't see "you were named as heir" or
//     "your heir started a claim — send heartbeat".
//   - setHeir uses unifiedWriteAndWait (with explicit fallback to
//     publicClient.waitForTransactionReceipt when AA receipt missing)
//     — this is the ONLY op that uses AndWait; the others use plain
//     unifiedWrite + manual waitForTransactionReceipt. The reason:
//     setHeir's receipt logging was added during a debug session and
//     kept the AndWait shape.
//   - removeHeir SNAPSHOT pattern: capture formerHeir from plan.heir
//     BEFORE the tx, then notify formerHeir on success. If we read
//     plan.heir AFTER the tx, refetchPlan would have already cleared
//     it to zero and the notification row would never fire — the
//     former heir wouldn't know they were removed.
//   - removeHeir notification guards: 3 conditions (formerHeir set,
//     formerHeir !== zero-addr, formerHeir !== caller). All three
//     must hold for the secondary row to insert; any one false skips
//     the notification (defensive against ghost heirs).
//   - finalizeClaim MAX_UINT64 array: encrypts uint64.max for EACH
//     vault in the plan. The vault's transferFrom uses FHE.select so
//     over-requesting is safe (transfers up to available balance).
//     Pinning array length === vaultCount ensures the contract
//     receives the right shape.
//   - finalizeClaim vaultCount=0 -> "No vaults configured" toast +
//     no write attempt; this prevents the contract reverting on an
//     empty array (gas wasted + confusing error).
//   - finalizeClaim is the ONLY op that fires invalidateBalanceQueries
//     because it's the only op that actually moves funds. setHeir +
//     setVaults are configuration; heartbeat is administrative;
//     removeHeir + startClaim don't transfer.
//   - Plan tuple null when getPlan returns undefined (wagmi readContract
//     before address is ready) — plan stays null so the UI doesn't
//     render stale state.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: usePublicClientMock,
  useReadContract: useReadContractMock,
}));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/abis", () => ({ InheritanceManagerAbi: [] }));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import { useInheritance } from "./useInheritance";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEIR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const MGR = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const VAULT_2 = "0x3333333333333333333333333333333333333333";

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const refetchPlanMock = vi.fn();

function planTuple(over: Partial<{
  heir: string;
  inactivityPeriod: bigint;
  lastHeartbeat: bigint;
  claimStartedAt: bigint;
  active: boolean;
  vaults: readonly string[];
}> = {}) {
  return [
    over.heir ?? HEIR,
    over.inactivityPeriod ?? BigInt(30 * 86400),
    over.lastHeartbeat ?? BigInt(Math.floor(Date.now() / 1000)),
    over.claimStartedAt ?? 0n,
    over.active ?? true,
    over.vaults ?? [VAULT],
  ] as const;
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useReadContractMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  refetchPlanMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { InheritanceManager: MGR, FHERC20Vault_USDC: VAULT },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useReadContractMock.mockReturnValue({
    data: planTuple(),
    refetch: refetchPlanMock,
  });
  insertActivityMock.mockResolvedValue(undefined);
  unifiedWriteMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 1n },
  });
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 1n,
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state + plan tuple decoding
// ───────────────────────────────────────────────────────────

describe("useInheritance — initial state + plan decoding (§15.x)", () => {
  it("returns plan + isProcessing=false + 6 callable handlers + refetchPlan", () => {
    const { result } = renderHook(() => useInheritance());
    expect(result.current.plan).not.toBeNull();
    expect(result.current.isProcessing).toBe(false);
    expect(typeof result.current.setHeir).toBe("function");
    expect(typeof result.current.setVaults).toBe("function");
    expect(typeof result.current.heartbeat).toBe("function");
    expect(typeof result.current.removeHeir).toBe("function");
    expect(typeof result.current.startClaim).toBe("function");
    expect(typeof result.current.finalizeClaim).toBe("function");
    expect(typeof result.current.refetchPlan).toBe("function");
  });

  it("plan=null when getPlan returns undefined (read not ready)", () => {
    useReadContractMock.mockReturnValue({
      data: undefined,
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    expect(result.current.plan).toBeNull();
  });

  it("plan tuple decoded with correct field positions + Number coercion + vaults spread copy", () => {
    const tuple = planTuple({
      heir: HEIR,
      inactivityPeriod: BigInt(7 * 86400),
      lastHeartbeat: 1_700_000_000n,
      claimStartedAt: 1_700_500_000n,
      active: true,
      vaults: [VAULT, VAULT_2],
    });
    useReadContractMock.mockReturnValue({
      data: tuple,
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    expect(result.current.plan).toEqual({
      heir: HEIR,
      inactivityPeriod: 7 * 86400, // Number, not bigint
      lastHeartbeat: 1_700_000_000,
      claimStartedAt: 1_700_500_000,
      active: true,
      vaults: [VAULT, VAULT_2],
    });
    // Vaults array is a NEW array (spread copy), not the same reference
    expect(result.current.plan!.vaults).not.toBe(tuple[5]);
  });

  it("read enabled gated on address presence (wagmi query.enabled)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    renderHook(() => useInheritance());
    const args = useReadContractMock.mock.calls[0][0];
    expect(args.query.enabled).toBe(false);
    expect(args.args).toBeUndefined();
  });

  it("read uses 60_000ms refetchInterval (1-minute polling)", () => {
    renderHook(() => useInheritance());
    const args = useReadContractMock.mock.calls[0][0];
    expect(args.query.refetchInterval).toBe(60_000);
  });

  it("read targets contracts.InheritanceManager + functionName='getPlan' + args=[address]", () => {
    renderHook(() => useInheritance());
    const args = useReadContractMock.mock.calls[0][0];
    expect(args.address).toBe(MGR);
    expect(args.functionName).toBe("getPlan");
    expect(args.args).toEqual([ME]);
  });
});

// ───────────────────────────────────────────────────────────
//  setHeir (the unifiedWriteAndWait outlier)
// ───────────────────────────────────────────────────────────

describe("useInheritance — setHeir (§15.x)", () => {
  it("no address -> early return (no write)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("no publicClient -> early return", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("uses unifiedWriteAndWait (NOT unifiedWrite — debug-receipt outlier)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("converts inactivityDays to seconds (BigInt(days * 86400))", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("setHeir");
    expect(call.args[0]).toBe(HEIR);
    expect(call.args[1]).toBe(BigInt(7 * 86400));
    expect(call.gas).toBe(5_000_000n);
  });

  it("falls back to publicClient.waitForTransactionReceipt when AA receipt missing", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtx",
      receipt: undefined, // EOA path
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xtx",
      confirmations: 1,
    });
  });

  it("AA path with receipt skips waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtx",
      receipt: { status: "success", blockNumber: 999n },
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
    expect(insertActivityMock.mock.calls[0][0].block_number).toBe(999);
  });

  it("DUAL-ROW pattern: owner's row + heir's row (heir !== owner)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const ownerRow = insertActivityMock.mock.calls[0][0];
    expect(ownerRow.user_to).toBe(ME.toLowerCase());
    expect(ownerRow.note).toContain(HEIR.slice(0, 6));
    expect(ownerRow.tx_hash).toBe("0xtxhash");
    const heirRow = insertActivityMock.mock.calls[1][0];
    expect(heirRow.user_to).toBe(HEIR.toLowerCase());
    expect(heirRow.tx_hash).toBe("0xtxhash:heir"); // dedup suffix
    expect(heirRow.note).toContain("You were named as heir");
  });

  it("SELF-NAME (heir === owner) -> only ONE row inserted (no self-notification)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(ME.toUpperCase(), 30);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("broadcastAction('activity_added') + invalidateBalanceQueries fire on success", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(refetchPlanMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Inheritance plan set!");
  });

  it("reverted receipt -> error toast + NO supabase write", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n },
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setHeir(HEIR, 30);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Transaction reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });

  it("isProcessing flips true during in-flight + false in finally", async () => {
    let resolveWrite: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise((res) => {
        resolveWrite = res;
      }),
    );
    const { result } = renderHook(() => useInheritance());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.setHeir(HEIR, 30);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isProcessing).toBe(true);
    resolveWrite({
      hash: "0xtx",
      receipt: { status: "success", blockNumber: 1n },
    });
    await act(async () => {
      await p;
    });
    expect(result.current.isProcessing).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  heartbeat
// ───────────────────────────────────────────────────────────

describe("useInheritance — heartbeat (§15.x)", () => {
  it("calls heartbeat with no args + gas=5_000_000", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("heartbeat");
    expect(call.address).toBe(MGR);
    expect(call.gas).toBe(5_000_000n);
    expect(call.args).toBeUndefined();
  });

  it("inserts INHERITANCE_PULSE activity row with timer-reset note", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    const row = insertActivityMock.mock.calls[0][0];
    // INHERITANCE_PULSE constant stringifies to "heartbeat" not the
    // longer "inheritance_pulse" — verified against ACTIVITY_TYPES.
    expect(row.activity_type).toBe("heartbeat");
    expect(row.note).toContain("Heartbeat");
    expect(row.note).toContain("timer reset");
  });

  it("heartbeat does NOT broadcast balance_changed (admin action, no balance change)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(0);
  });

  it("reverted receipt -> 'Failed to send heartbeat' toast + NO supabase", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to send heartbeat");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  removeHeir SNAPSHOT pattern
// ───────────────────────────────────────────────────────────

describe("useInheritance — removeHeir (§15.x)", () => {
  it("calls removeHeir + inserts owner's row", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.removeHeir();
    });
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe("removeHeir");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("inheritance_heir_removed");
    expect(row.note).toBe("Removed inheritance plan");
  });

  it("SNAPSHOT pattern: captures formerHeir from plan BEFORE the tx", async () => {
    useReadContractMock.mockReturnValue({
      data: planTuple({ heir: HEIR }),
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.removeHeir();
    });
    // Heir row inserted with the BEFORE-tx heir value
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const heirRow = insertActivityMock.mock.calls[1][0];
    expect(heirRow.user_to).toBe(HEIR.toLowerCase());
    expect(heirRow.tx_hash).toBe("0xtxhash:heir");
    expect(heirRow.note).toBe("You are no longer designated as heir");
  });

  it("formerHeir === zero-addr -> NO secondary row (defensive)", async () => {
    useReadContractMock.mockReturnValue({
      data: planTuple({ heir: ZERO_ADDR }),
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.removeHeir();
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("formerHeir === caller (self) -> NO secondary row", async () => {
    useReadContractMock.mockReturnValue({
      data: planTuple({ heir: ME }),
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.removeHeir();
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("plan.heir null (no plan) -> NO secondary row", async () => {
    useReadContractMock.mockReturnValue({
      data: undefined,
      refetch: refetchPlanMock,
    });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.removeHeir();
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  setVaults
// ───────────────────────────────────────────────────────────

describe("useInheritance — setVaults (§15.x)", () => {
  it("calls setVaults with the address[] arg + gas=5_000_000", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setVaults([VAULT, VAULT_2]);
    });
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("setVaults");
    expect(call.args[0]).toEqual([VAULT, VAULT_2]);
  });

  it("note copy uses singular/plural correctly (1 vault vs 2 vaults)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setVaults([VAULT]);
    });
    expect(insertActivityMock.mock.calls[0][0].note).toContain("1 vault for");
    insertActivityMock.mockClear();
    await act(async () => {
      await result.current.setVaults([VAULT, VAULT_2]);
    });
    expect(insertActivityMock.mock.calls[0][0].note).toContain("2 vaults for");
  });

  it("empty array still calls setVaults (clears the protected list)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setVaults([]);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].note).toContain("0 vaults for");
  });

  it("reverted receipt -> error toast + NO supabase", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.setVaults([VAULT]);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Transaction reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  startClaim (heir -> owner notification)
// ───────────────────────────────────────────────────────────

describe("useInheritance — startClaim (§15.x)", () => {
  it("calls startClaim with ownerAddress arg", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("startClaim");
    expect(call.args[0]).toBe(OWNER);
  });

  it("DUAL-ROW: heir's own row + owner's row (warning to send heartbeat)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const heirRow = insertActivityMock.mock.calls[0][0];
    expect(heirRow.user_to).toBe(ME.toLowerCase());
    expect(heirRow.tx_hash).toBe("0xtxhash");
    const ownerRow = insertActivityMock.mock.calls[1][0];
    expect(ownerRow.user_to).toBe(OWNER.toLowerCase());
    expect(ownerRow.tx_hash).toBe("0xtxhash:owner");
    expect(ownerRow.note).toContain("send a heartbeat");
  });

  it("activity_type='inheritance_claim_started' on both rows", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    expect(insertActivityMock.mock.calls[0][0].activity_type).toBe(
      "inheritance_claim_started",
    );
    expect(insertActivityMock.mock.calls[1][0].activity_type).toBe(
      "inheritance_claim_started",
    );
  });

  it("SELF-CLAIM (owner === caller) -> only ONE row inserted", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(ME);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("startClaim does NOT broadcast balance_changed (no funds moved yet)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(0);
  });

  it("toast copy mentions challenge period", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("challenge period"),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  finalizeClaim (the only fund-moving op)
// ───────────────────────────────────────────────────────────

describe("useInheritance — finalizeClaim (§15.x)", () => {
  it("vaultCount=0 -> error toast + no write", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 0);
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "No vaults configured in the owner's inheritance plan",
    );
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("vaultCount=1 -> finalizeClaim called with [MAX_UINT64] (length 1)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.functionName).toBe("finalizeClaim");
    expect(call.args[0]).toBe(OWNER);
    expect(call.args[1]).toHaveLength(1);
    expect(call.args[1][0]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
  });

  it("vaultCount=3 -> array of THREE MAX_UINT64 values", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 3);
    });
    const arr = unifiedWriteMock.mock.calls[0][0].args[1] as bigint[];
    expect(arr).toHaveLength(3);
    expect(arr.every((v) => v === BigInt("18446744073709551615"))).toBe(true);
  });

  it("DUAL-ROW: heir's own row + owner's notification row", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const heirRow = insertActivityMock.mock.calls[0][0];
    expect(heirRow.user_to).toBe(ME.toLowerCase());
    expect(heirRow.activity_type).toBe("inheritance_claim_finalized");
    expect(heirRow.note).toContain("Finalized");
    const ownerRow = insertActivityMock.mock.calls[1][0];
    expect(ownerRow.user_to).toBe(OWNER.toLowerCase());
    expect(ownerRow.tx_hash).toBe("0xtxhash:owner");
    expect(ownerRow.note).toContain("funds transferred to heir");
  });

  it("SELF-FINALIZE (owner === caller) -> only ONE row inserted", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(ME, 1);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: finalizeClaim is the ONLY op that fires balance_changed + invalidateBalanceQueries", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("reverted receipt -> error toast + NO supabase + NO balance broadcast", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Transaction reverted on-chain");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Cross-op invariants
// ───────────────────────────────────────────────────────────

describe("useInheritance — cross-op invariants (§15.x)", () => {
  it("every op (except setHeir) uses plain unifiedWrite (NOT unifiedWriteAndWait)", async () => {
    const { result } = renderHook(() => useInheritance());
    // heartbeat
    await act(async () => {
      await result.current.heartbeat();
    });
    // removeHeir
    await act(async () => {
      await result.current.removeHeir();
    });
    // setVaults
    await act(async () => {
      await result.current.setVaults([VAULT]);
    });
    // startClaim
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    // finalizeClaim
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    // 5 calls total to unifiedWrite, 0 to unifiedWriteAndWait
    expect(unifiedWriteMock).toHaveBeenCalledTimes(5);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("every op refetches the plan on success", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    expect(refetchPlanMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    expect(refetchPlanMock).toHaveBeenCalledTimes(2);
  });

  it("every op gates on (address && publicClient) and returns early when missing", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    await act(async () => {
      await result.current.removeHeir();
    });
    await act(async () => {
      await result.current.setVaults([VAULT]);
    });
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("every op uses gas=5_000_000 (FHE precompile manual budget)", async () => {
    const { result } = renderHook(() => useInheritance());
    await act(async () => {
      await result.current.heartbeat();
    });
    await act(async () => {
      await result.current.removeHeir();
    });
    await act(async () => {
      await result.current.setVaults([VAULT]);
    });
    await act(async () => {
      await result.current.startClaim(OWNER);
    });
    await act(async () => {
      await result.current.finalizeClaim(OWNER, 1);
    });
    for (const call of unifiedWriteMock.mock.calls) {
      expect(call[0].gas).toBe(5_000_000n);
    }
  });
});
