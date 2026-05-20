import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useQualificationProof. Encrypted "income/balance ≥ X"
// proofs via PaymentReceipts. Two creation paths (income / balance) +
// fetch + publish + listByUser.
//
// CRITICAL pins:
//   - Threshold conversion: USDC float × 1_000_000 -> 6-decimal wei via
//     Math.round(thresholdUSDC * 1_000_000); negative thresholds rejected
//     up-front with "Threshold must be ≥ 0" toast.
//   - createBalanceProof is TWO-stage: allowBalanceReader (grant
//     PaymentReceipts FHE access to the user's vault balance handle)
//     FIRST, then proveBalanceAbove. If allowBalanceReader fails the
//     prove call MUST NOT fire — otherwise the contract would revert
//     on FHE.gte(balanceHandle, threshold) for a handle it can't read.
//   - decodeEventLog walks ALL logs looking for ProofCreated; logs from
//     unrelated contracts are caught + skipped via try/catch (different
//     ABI). ProofCreated missing entirely -> throws "Proof id missing
//     from receipt logs" (not null, not 0).
//   - publishProof uses 3-CONFIRMATION reorg-safety (not 1). Testnet
//     shallow reorgs can flip a TRUE verdict to FALSE; 3 confirms means
//     a reorg deep enough to flip the verdict would be visible on the
//     explorer first. Pinned via call-args assertion on
//     waitForTransactionReceipt.
//   - publishProof inserts TWO supabase rows when publisher !== prover:
//     one for publisher (user_to=publisher) + one for prover (user_to=
//     prover, tx_hash suffixed with ":prover" so the dedupe key is
//     unique). When publisher === prover (self-publish), only the
//     primary row inserts. Without the prover row, the original prover
//     never sees the verdict in their History.
//   - prover lookup wrapped in try/catch — a failed getProof on the
//     publish path doesn't fail the whole publish; the publisher still
//     gets their row, the prover just doesn't get the secondary one.
//   - publishProof activity note carries explicit "TRUE" / "FALSE"
//     string for human-readable history. Toast copy also differs:
//     "Verified — proof holds" vs "Verified — proof is false".
//   - Decryption poll budget 60_000ms (60s), distinct from
//     useInvoiceEscrow's 180s budget. Income proofs are simpler ebool
//     decrypts that resolve faster on the TN under normal load.
//   - fetchProof tuple decoding: [prover, threshold, blockNumber,
//     timestamp, kind, isTrue, isReady] — getProof returns these in
//     that order. A regression that swapped the tuple position would
//     show the wrong block number, isReady, etc.
//   - readContract failure on fetchProof / fetchProofsByUser -> returns
//     null / [] not throws (so the UI can render an empty state instead
//     of crashing).

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const decodeEventLogMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheDecryptForTx: useCofheDecryptForTxMock,
}));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/abis", () => ({
  PaymentReceiptsAbi: [],
  FHERC20VaultAbi: [],
}));
// Replace viem's decodeEventLog with a controllable mock; re-import
// everything else so unrelated viem helpers stay working.
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, decodeEventLog: decodeEventLogMock };
});
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import { useQualificationProof } from "./useQualificationProof";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RECEIPTS = "0x1111111111111111111111111111111111111111";
const TEST_USDC = "0x2222222222222222222222222222222222222222";
const VAULT_USDC = "0x3333333333333333333333333333333333333333";
const SIGNATURE = ("0x" + "01".repeat(65)) as `0x${string}`;

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();
const decryptForTxMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  decodeEventLogMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  readContractMock.mockReset();
  decryptForTxMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      PaymentReceipts: RECEIPTS,
      TestUSDC: TEST_USDC,
      FHERC20Vault_USDC: VAULT_USDC,
    },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useCofheDecryptForTxMock.mockReturnValue({ decryptForTx: decryptForTxMock });
  toastLoadingMock.mockReturnValue("toast-id");
  insertActivityMock.mockResolvedValue(undefined);
  // Default decoded log: ProofCreated with proofId=42
  decodeEventLogMock.mockReturnValue({
    eventName: "ProofCreated",
    args: { proofId: 42n },
  });
  unifiedWriteMock.mockResolvedValue("0xpublishtx" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: {
      status: "success",
      blockNumber: 12345n,
      logs: [
        { address: RECEIPTS, topics: ["0xabc"], data: "0xdef" },
      ],
    },
  });
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 12345n,
    logs: [{ address: RECEIPTS, topics: ["0xabc"], data: "0xdef" }],
  });
  // Default decryptForTx returns TRUE plaintext
  decryptForTxMock.mockResolvedValue({
    decryptedValue: true,
    signature: SIGNATURE,
  });
  // Default getProof tuple — used by publishProof's prover-lookup
  readContractMock.mockImplementation(async (args: { functionName: string }) => {
    if (args.functionName === "getProofHandle") return 999n;
    if (args.functionName === "getProof") {
      return [ME, 1_000_000_000n, 12345n, 1_700_000_000n, "income", true, true];
    }
    if (args.functionName === "getProofsByUser") return [1n, 2n, 3n];
    return null;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — initial state (§15.x)", () => {
  it("returns idle step + null error + 6 callable handlers", () => {
    const { result } = renderHook(() => useQualificationProof());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(typeof result.current.createIncomeProof).toBe("function");
    expect(typeof result.current.createBalanceProof).toBe("function");
    expect(typeof result.current.fetchProof).toBe("function");
    expect(typeof result.current.publishProof).toBe("function");
    expect(typeof result.current.fetchProofsByUser).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  createIncomeProof
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — createIncomeProof (§15.x)", () => {
  it("negative threshold -> 'Threshold must be ≥ 0' toast + null + no write", async () => {
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = 0n;
    await act(async () => {
      r = await result.current.createIncomeProof(-1);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Threshold must be ≥ 0");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("threshold 0 ACCEPTED (>= 0 boundary)", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(0);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it("calls proveIncomeAbove with thresholdWei = USDC × 1_000_000", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(1234.56);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(RECEIPTS);
    expect(call.functionName).toBe("proveIncomeAbove");
    // 1234.56 * 1_000_000 = 1_234_560_000 (Math.round)
    expect(call.args[0]).toBe(1_234_560_000n);
    expect(call.gas).toBe(5_000_000n);
  });

  it("Math.round applied to fractional cents (e.g. 0.005 -> 5000 not 4999.999...)", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(0.005);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args[0]).toBe(5000n);
  });

  it("returns proofId from ProofCreated event log + sets step=success", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "ProofCreated",
      args: { proofId: 77n },
    });
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = null;
    await act(async () => {
      r = await result.current.createIncomeProof(100);
    });
    expect(r).toBe(77n);
    expect(result.current.step).toBe("success");
    expect(toastSuccessMock).toHaveBeenCalledWith("Proof created. ID 77");
  });

  it("inserts PROOF_CREATED activity row with descriptive note", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "ProofCreated",
      args: { proofId: 5n },
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(1000);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("proof_created");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.note).toContain("Proof #5");
    expect(row.note).toContain("income");
    expect(row.contract_address).toBe(RECEIPTS);
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.block_number).toBe(12345);
  });

  it("broadcastAction('activity_added') fires on success", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("AA path: writeResult.receipt present -> skips waitForTransactionReceipt", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path: no receipt -> waitForTransactionReceipt with 300s timeout", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
      timeout: 300_000,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  createBalanceProof
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — createBalanceProof (§15.x)", () => {
  it("two-stage: allowBalanceReader FIRST, then proveBalanceAbove", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createBalanceProof(100);
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe(
      "allowBalanceReader",
    );
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].address).toBe(VAULT_USDC);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].args[0]).toBe(RECEIPTS);
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].functionName).toBe(
      "proveBalanceAbove",
    );
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].address).toBe(RECEIPTS);
  });

  it("allowBalanceReader failure -> prove NOT fired", async () => {
    let callCount = 0;
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      callCount += 1;
      if (args.functionName === "allowBalanceReader") {
        throw new Error("allow reader reverted");
      }
      return {
        hash: "0xtxhash",
        receipt: { status: "success", blockNumber: 1n, logs: [{}] },
      };
    });
    const { result } = renderHook(() => useQualificationProof());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.createBalanceProof(100);
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("allow reader reverted");
    expect(callCount).toBe(1); // prove NOT called
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Failed to grant balance access",
      expect.objectContaining({ id: "toast-id" }),
    );
  });

  it("negative threshold -> 'Threshold must be ≥ 0' + no writes", async () => {
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = 0n;
    await act(async () => {
      r = await result.current.createBalanceProof(-1);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Threshold must be ≥ 0");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("explicit vault override passes through to BOTH allowBalanceReader AND proveBalanceAbove", async () => {
    const altVault = "0x4444444444444444444444444444444444444444" as `0x${string}`;
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createBalanceProof(100, altVault);
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].address).toBe(altVault);
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].args[0]).toBe(altVault);
  });

  it("no vault -> defaults to contracts.FHERC20Vault_USDC", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createBalanceProof(100);
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].address).toBe(VAULT_USDC);
    expect(unifiedWriteAndWaitMock.mock.calls[1][0].args[0]).toBe(VAULT_USDC);
  });

  it("proveBalanceAbove receives (vault, thresholdWei)", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createBalanceProof(50);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[1][0];
    expect(call.args[0]).toBe(VAULT_USDC);
    expect(call.args[1]).toBe(50_000_000n);
  });

  it("activity note describes balance threshold", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createBalanceProof(1000);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toContain("balance");
    expect(row.note).toContain("$1,000");
  });
});

// ───────────────────────────────────────────────────────────
//  _submitProof event log parsing
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — event log parsing (§15.x)", () => {
  it("ProofCreated missing from receipt logs -> 'Proof id missing' error", async () => {
    decodeEventLogMock.mockReturnValue({
      eventName: "SomeOtherEvent",
      args: {},
    });
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = null;
    await act(async () => {
      r = await result.current.createIncomeProof(100);
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("Proof id missing");
  });

  it("decodeEventLog throws for unrelated logs -> skipped + continues to next", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xtxhash",
      receipt: {
        status: "success",
        blockNumber: 1n,
        logs: [
          { address: "0xother", topics: ["0xa"], data: "0xb" },
          { address: RECEIPTS, topics: ["0xabc"], data: "0xdef" },
        ],
      },
    });
    let callCount = 0;
    decodeEventLogMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) throw new Error("not a PaymentReceipts log");
      return { eventName: "ProofCreated", args: { proofId: 99n } };
    });
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = null;
    await act(async () => {
      r = await result.current.createIncomeProof(100);
    });
    expect(r).toBe(99n);
  });

  it("reverted receipt -> throws 'Proof creation reverted'", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 1n, logs: [] },
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("Proof creation reverted");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
  });

  it("no address -> 'Connect your wallet first' + no write", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint | null = null;
    await act(async () => {
      r = await result.current.createIncomeProof(100);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect your wallet first");
  });

  it("no publicClient -> 'Connect your wallet first' + no write", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connect your wallet first");
  });
});

// ───────────────────────────────────────────────────────────
//  fetchProof
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — fetchProof (§15.x)", () => {
  it("returns null when no publicClient", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useQualificationProof());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.fetchProof(42n);
    });
    expect(r).toBeNull();
  });

  it("returns ProofRecord with all 7 fields decoded from getProof tuple", async () => {
    readContractMock.mockResolvedValue([
      ME,
      1_000_000_000n, // threshold
      5555n, // blockNumber
      1_700_000_000n, // timestamp
      "income", // kind
      true, // isTrue
      true, // isReady
    ]);
    const { result } = renderHook(() => useQualificationProof());
    let r: { id: bigint; prover: string; threshold: bigint; blockNumber: bigint; timestamp: bigint; kind: string; isTrue: boolean; isReady: boolean } | null = null;
    await act(async () => {
      r = await result.current.fetchProof(42n);
    });
    expect(r!.id).toBe(42n);
    expect(r!.prover).toBe(ME);
    expect(r!.threshold).toBe(1_000_000_000n);
    expect(r!.blockNumber).toBe(5555n);
    expect(r!.timestamp).toBe(1_700_000_000n);
    expect(r!.kind).toBe("income");
    expect(r!.isTrue).toBe(true);
    expect(r!.isReady).toBe(true);
  });

  it("readContract rejection -> returns null (does NOT crash)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useQualificationProof());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.fetchProof(42n);
    });
    expect(r).toBeNull();
  });

  it("isReady=false -> ProofRecord still returns (in-flight verdict)", async () => {
    readContractMock.mockResolvedValue([
      ME,
      0n,
      0n,
      0n,
      "income",
      false, // isTrue
      false, // isReady (not yet published)
    ]);
    const { result } = renderHook(() => useQualificationProof());
    let r: { isReady: boolean; isTrue: boolean } | null = null;
    await act(async () => {
      r = await result.current.fetchProof(42n);
    });
    expect(r!.isReady).toBe(false);
    expect(r!.isTrue).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  publishProof
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — publishProof (§15.x)", () => {
  it("no address -> 'Connect your wallet first' + returns false", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useQualificationProof());
    let ok = true;
    await act(async () => {
      ok = await result.current.publishProof(42n);
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("Connect your wallet first");
  });

  it("getProofHandle returns 0n -> throws 'Proof handle missing'", async () => {
    readContractMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "getProofHandle") return 0n;
      return null;
    });
    const { result } = renderHook(() => useQualificationProof());
    let ok = true;
    await act(async () => {
      ok = await result.current.publishProof(42n);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("Proof handle missing");
    expect(decryptForTxMock).toHaveBeenCalledTimes(0);
  });

  it("calls publishProof on PaymentReceipts with (proofId, plaintext, signature)", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.address).toBe(RECEIPTS);
    expect(call.functionName).toBe("publishProof");
    expect(call.args[0]).toBe(42n);
    expect(call.args[1]).toBe(true);
    expect(call.args[2]).toBe(SIGNATURE);
  });

  it("3-confirmation reorg-safety: waitForTransactionReceipt called with confirmations=3", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    const call = waitForTransactionReceiptMock.mock.calls[0][0];
    expect(call.confirmations).toBe(3);
  });

  it("plaintext=true -> 'Verified — proof holds' toast", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Verified. Proof holds.",
      expect.objectContaining({ id: "toast-id" }),
    );
  });

  it("plaintext=false -> 'Verified — proof is false' toast", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Verified. Proof is false.",
      expect.objectContaining({ id: "toast-id" }),
    );
  });

  it("decryptedValue bigint normalization: 0n -> false, 1n -> true", async () => {
    // 1n -> true
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 1n,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(unifiedWriteMock.mock.calls[0][0].args[1]).toBe(true);
    // 0n -> false
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 0n,
      signature: SIGNATURE,
    });
    unifiedWriteMock.mockClear();
    await act(async () => {
      await result.current.publishProof(43n);
    });
    expect(unifiedWriteMock.mock.calls[0][0].args[1]).toBe(false);
  });

  it("activity note contains explicit 'TRUE' / 'FALSE' string for human readability", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: true,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("proof_published");
    expect(row.note).toContain("TRUE");
    expect(row.note).toContain("#42");
  });

  it("FALSE verdict -> note contains 'FALSE'", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: false,
      signature: SIGNATURE,
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(insertActivityMock.mock.calls[0][0].note).toContain("FALSE");
  });

  it("publisher !== prover: TWO supabase rows (publisher + prover) with distinct tx_hash", async () => {
    // Prover differs from publisher (current user)
    readContractMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "getProofHandle") return 999n;
      if (args.functionName === "getProof") {
        return [ALICE, 1_000_000_000n, 12345n, 1_700_000_000n, "income", true, true];
      }
      return null;
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(2);
    const row1 = insertActivityMock.mock.calls[0][0];
    const row2 = insertActivityMock.mock.calls[1][0];
    // First row: publisher (user_from=publisher, user_to=publisher)
    expect(row1.user_to).toBe(ME.toLowerCase());
    expect(row1.tx_hash).toBe("0xpublishtx");
    // Second row: prover notification (user_from=publisher, user_to=prover)
    expect(row2.user_from).toBe(ME.toLowerCase());
    expect(row2.user_to).toBe(ALICE.toLowerCase());
    // tx_hash suffixed with :prover for dedup-key uniqueness
    expect(row2.tx_hash).toBe("0xpublishtx:prover");
  });

  it("publisher === prover (self-publish): only ONE row (no prover notification)", async () => {
    // Prover same as publisher
    readContractMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "getProofHandle") return 999n;
      if (args.functionName === "getProof") {
        return [ME, 1_000_000_000n, 12345n, 1_700_000_000n, "income", true, true];
      }
      return null;
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
  });

  it("prover lookup failure -> wrapped in try/catch, primary row still inserts", async () => {
    let getProofCallCount = 0;
    readContractMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "getProofHandle") return 999n;
      if (args.functionName === "getProof") {
        getProofCallCount += 1;
        throw new Error("getProof revert");
      }
      return null;
    });
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(getProofCallCount).toBe(1);
    // Primary row still inserted (publisher's own feed)
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].user_to).toBe(ME.toLowerCase());
    // Success path still completes
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("publish revert -> 'Publish reverted' error", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      blockNumber: 1n,
      logs: [],
    });
    const { result } = renderHook(() => useQualificationProof());
    let ok = true;
    await act(async () => {
      ok = await result.current.publishProof(42n);
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("Publish reverted");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("balance queries NOT invalidated (proof publish doesn't affect balances)", async () => {
    // No invalidateBalanceQueries import — confirm by absence of any
    // such side effect. We pin this by inspecting that the source's
    // comment is honored: ONLY broadcastAction("activity_added") fires,
    // no balance broadcast.
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.publishProof(42n);
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
  });

  it("decryptForTx 60s poll budget: returns null then result on retry -> success", async () => {
    let callCount = 0;
    decryptForTxMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount < 3) return null;
      return { decryptedValue: true, signature: SIGNATURE };
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useQualificationProof());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.publishProof(42n);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => {
      await p;
    });
    expect(decryptForTxMock).toHaveBeenCalledTimes(3);
  });

  it("decryptForTx always null -> 60s budget elapses then 'Decryption timed out'", async () => {
    decryptForTxMock.mockResolvedValue(null);
    vi.useFakeTimers();
    const { result } = renderHook(() => useQualificationProof());
    let p!: Promise<boolean>;
    act(() => {
      p = result.current.publishProof(42n);
    });
    await vi.advanceTimersByTimeAsync(70_000);
    let ok = true;
    await act(async () => {
      ok = await p;
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("Decryption timed out");
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  fetchProofsByUser
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — fetchProofsByUser (§15.x)", () => {
  it("no publicClient -> returns []", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint[] = [99n];
    await act(async () => {
      r = await result.current.fetchProofsByUser();
    });
    expect(r).toEqual([]);
  });

  it("no target (no address + no arg) -> returns []", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint[] = [99n];
    await act(async () => {
      r = await result.current.fetchProofsByUser();
    });
    expect(r).toEqual([]);
  });

  it("explicit user arg overrides current address", async () => {
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.fetchProofsByUser(ALICE);
    });
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "getProofsByUser",
        args: [ALICE],
      }),
    );
  });

  it("happy path: returns the bigint[] from getProofsByUser", async () => {
    readContractMock.mockResolvedValue([1n, 2n, 99n]);
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint[] = [];
    await act(async () => {
      r = await result.current.fetchProofsByUser();
    });
    expect(r).toEqual([1n, 2n, 99n]);
  });

  it("readContract rejection -> returns [] (no crash)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useQualificationProof());
    let r: bigint[] = [99n];
    await act(async () => {
      r = await result.current.fetchProofsByUser();
    });
    expect(r).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useQualificationProof — reset (§15.x)", () => {
  it("reset clears step + error back to idle/null", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("test fail"));
    const { result } = renderHook(() => useQualificationProof());
    await act(async () => {
      await result.current.createIncomeProof(100);
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("test fail");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
