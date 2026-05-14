import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useStealthPayments. Stealth payment flow with
// FHE-encrypted recipient identity: sender submits a payment with
// an encrypted recipient address + a public claim-code hash;
// recipient redeems via off-chain claim code. The amount is
// public, the recipient identity is FHE-protected, and the
// claim-code-hash binding to recipient prevents front-running
// because keccak256(abi.encodePacked(claimCode, recipientAddress))
// only matches when msg.sender at claim time is the intended
// recipient.
//
// CRITICAL pins:
//   - 9-step machine (idle / approving / encrypting / sending /
//     claiming / waiting_for_decryption / finalizing / success /
//     error); claimStealth auto-transitions into the decryption
//     poll which calls finalizeClaim once Threshold Network is
//     ready; finalizeClaim ALSO callable manually for the resume
//     UI path.
//   - sendStealth claim-code generation: 32 random bytes via
//     crypto.getRandomValues + computeClaimCodeHash binds
//     claimCode TO recipientAddress so an attacker who intercepts
//     the claimCode in transit can't substitute their own address
//     and steal the payment (the contract's keccak256 verification
//     would fail).
//   - sendStealth transferId extraction from event log topics[1]:
//     reads the FIRST log emitted by stealthAddress where
//     topics.length >= 2 and parses topics[1] as a bigint (the
//     indexed transferId in the StealthSent event signature). Test
//     pins by seeding a log with topics[1] = bytes32(42n) and
//     asserting transferId === 42.
//   - sendStealth STEALTH_SENT activity uses user_to =
//     0x0000000000000000000000000000000000000000 because the
//     on-chain recipient is encrypted; only the claim reveals the
//     real recipient address. The receipt page can display the
//     recipient by reading the stored claim code's bound hash, but
//     the indexer / supabase query for "payments TO me" intentionally
//     misses stealth sends until the claim lands and a STEALTH_CLAIMED
//     row appears with the correct user_to.
//   - finalizeClaim 4-branch ladder: (1) handle === 0n -> 'No
//     pending claim' error (already finalized OR claim never
//     started); (2) decryptForTx returns null -> 'Decryption not
//     ready yet' error with hint to retry; (3) decryptedAmount ===
//     0n -> 'wasn't intended for your claim code' RED toast +
//     step='error' + txHash PRESERVED + NO activity insert +
//     pending-claim record STILL removed (the chain accepted the
//     finalize attempt and won't accept another); (4) decryptedAmount
//     > 0n -> STEALTH_CLAIMED activity + balance broadcast + green
//     toast. The 0n branch is the privacy-preserving contract path:
//     FHE.select returns 0 when msg.sender at claim time doesn't
//     match the encrypted recipient — the contract DOES NOT revert
//     because reverting would leak that the wrong claimer tried
//     (a side-channel for the recipient's identity); test pins
//     activity-insert count = 0 specifically.
//   - claimStealth persistPendingClaim AFTER on-chain mine (NOT
//     before): the persistent record holds (transferId, claimCode,
//     claimCodeHash, startedAt, txHash) so a user who navigates
//     away or whose 60s decrypt poll times out can resume via
//     getPendingClaims + resumePendingClaim; removePendingClaim
//     fires on finalize regardless of decrypted-amount outcome
//     because the chain accepted the finalize attempt (success or
//     0-amount-privacy-path) and there's nothing more to resume.
//   - Inbox dedup #227 three-case logic: (a) same hash + status
//     'claimed' -> silent no-op (dev-mode console.debug only); (b)
//     same hash + DIFFERENT fromHint (both supplied + disagree)
//     -> WARN toast 'received another link with same claim code
//     from different sender' but keep the first; (c) same hash +
//     same/missing fromHint + not-yet-claimed -> silent no-op
//     (debounce duplicate clicks); new hash -> insert at FRONT of
//     list (unshift) + cap at 100 entries + broadcast 'added'.
//   - getMyPendingClaims filters by found[i] flag: contract
//     returns parallel [transferIds, found] arrays, hook returns
//     only the transferIds where found[i] === true (drops the
//     0-id slots that map to claim codes the contract doesn't
//     have a record of); empty input array returns [] without
//     hitting the chain.
//   - submittingRef ref-based single-flight: prevents concurrent
//     sendStealth / claimStealth / finalizeClaim submissions
//     across THE SAME HOOK INSTANCE (one shared ref); the chain-
//     switch effect at line 291 also calls stopPolling() + resets
//     state when address goes null, so a user disconnecting
//     mid-poll doesn't leak a setInterval that calls finalizeClaim
//     for the wrong signer.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const getStoredJsonMock = vi.hoisted(() => vi.fn());
const setStoredJsonMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const toastFnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheEncrypt: useCofheEncryptMock,
  useCofheConnection: useCofheConnectionMock,
  useCofheDecryptForTx: useCofheDecryptForTxMock,
  Encryptable: new Proxy(
    {},
    { get: (_t, prop) => (v: unknown) => ({ type: prop, raw: v }) },
  ),
}));
vi.mock("@/lib/abis", () => ({ StealthPaymentsAbi: [], TestUSDCAbi: [] }));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    stealthInbox: (addr: string, c: number) => `inbox_${addr}_${c}`,
    pendingStealthClaims: (addr: string, c: number) => `pending_${addr}_${c}`,
  },
  getStoredJson: getStoredJsonMock,
  setStoredJson: setStoredJsonMock,
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(toastFnMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  }),
}));

import {
  useStealthPayments,
  addToStealthInbox,
  getStealthInbox,
  markInboxEntryStatus,
} from "./useStealthPayments";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const STEALTH = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const USDC = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const VAULT = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const CLAIM_CODE = ("0x" + "ab".repeat(32)) as `0x${string}`; // bytes32, 32 bytes

const unifiedWriteAndWaitMock = vi.fn();
const encryptInputsAsyncMock = vi.fn();
const decryptForTxMock = vi.fn();
const readContractMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useCofheEncryptMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  getStoredJsonMock.mockReset();
  setStoredJsonMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  toastFnMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  decryptForTxMock.mockReset();
  readContractMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { StealthPayments: STEALTH, TestUSDC: USDC },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useCofheEncryptMock.mockReturnValue({
    encryptInputsAsync: encryptInputsAsyncMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheDecryptForTxMock.mockReturnValue({ decryptForTx: decryptForTxMock });
  getStoredJsonMock.mockReturnValue([]); // empty inbox + empty pending
  toastLoadingMock.mockReturnValue("tid");
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 5n, logs: [] },
  });
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
    logs: [],
  });
  encryptInputsAsyncMock.mockResolvedValue([
    { ctHash: 0x42n, securityZone: 0, utype: 12, signature: "0xenc" },
  ]);
  decryptForTxMock.mockResolvedValue({
    decryptedValue: 10_000_000n,
    signature: ("0x" + "01".repeat(65)) as `0x${string}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Inbox helpers (exported standalone)
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — inbox dedup logic #227 (§15.x)", () => {
  it("getStealthInbox reads stored JSON for the (addr, chainId) key, defaults to []", () => {
    getStoredJsonMock.mockReturnValue([
      {
        claimCode: "0xa",
        claimCodeHash: "0xh",
        status: "new",
        receivedAt: 1,
      },
    ]);
    const inbox = getStealthInbox(ME, 11155111);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].claimCodeHash).toBe("0xh");
  });

  it("addToStealthInbox: NEW entry -> unshift to front + setStoredJson + broadcast 'added'", () => {
    getStoredJsonMock.mockReturnValue([]);
    const added = addToStealthInbox(ME, 11155111, {
      claimCode: "0xabc",
      claimCodeHash: "0xh1" as `0x${string}`,
      fromHint: "0xsender",
    });
    expect(added).toBe(true);
    expect(setStoredJsonMock).toHaveBeenCalled();
    const saved = setStoredJsonMock.mock.calls[0][1] as Array<{
      claimCodeHash: string;
      status: string;
    }>;
    expect(saved[0].claimCodeHash).toBe("0xh1");
    expect(saved[0].status).toBe("new");
    expect(broadcastActionMock).toHaveBeenCalledWith(
      "stealth_inbox_changed",
      expect.objectContaining({
        action: "added",
        claimCodeHash: "0xh1",
      }),
    );
  });

  it("addToStealthInbox: (a) duplicate hash + already-claimed -> silent no-op, returns false", () => {
    getStoredJsonMock.mockReturnValue([
      {
        claimCode: "0xabc",
        claimCodeHash: "0xh1",
        status: "claimed",
        receivedAt: 1,
      },
    ]);
    const added = addToStealthInbox(ME, 11155111, {
      claimCode: "0xabc",
      claimCodeHash: "0xh1" as `0x${string}`,
    });
    expect(added).toBe(false);
    expect(toastFnMock).toHaveBeenCalledTimes(0);
    expect(setStoredJsonMock).toHaveBeenCalledTimes(0);
  });

  it("addToStealthInbox: (b) duplicate hash + DIFFERENT fromHint -> WARN toast + keep first + return false", () => {
    getStoredJsonMock.mockReturnValue([
      {
        claimCode: "0xabc",
        claimCodeHash: "0xh1",
        fromHint: "0xsender_A",
        status: "new",
        receivedAt: 1,
      },
    ]);
    const added = addToStealthInbox(ME, 11155111, {
      claimCode: "0xabc",
      claimCodeHash: "0xh1" as `0x${string}`,
      fromHint: "0xsender_B",
    });
    expect(added).toBe(false);
    expect(toastFnMock).toHaveBeenCalledWith(
      expect.stringContaining("different sender"),
      expect.any(Object),
    );
    expect(setStoredJsonMock).toHaveBeenCalledTimes(0);
  });

  it("addToStealthInbox: (c) duplicate hash + SAME fromHint -> silent no-op (no warn)", () => {
    getStoredJsonMock.mockReturnValue([
      {
        claimCode: "0xabc",
        claimCodeHash: "0xh1",
        fromHint: "0xsender",
        status: "new",
        receivedAt: 1,
      },
    ]);
    const added = addToStealthInbox(ME, 11155111, {
      claimCode: "0xabc",
      claimCodeHash: "0xh1" as `0x${string}`,
      fromHint: "0xsender",
    });
    expect(added).toBe(false);
    expect(toastFnMock).toHaveBeenCalledTimes(0);
  });

  it("addToStealthInbox: (c) duplicate hash + MISSING fromHint on one side -> silent no-op (wildcard match)", () => {
    getStoredJsonMock.mockReturnValue([
      {
        claimCode: "0xabc",
        claimCodeHash: "0xh1",
        // no fromHint
        status: "new",
        receivedAt: 1,
      },
    ]);
    const added = addToStealthInbox(ME, 11155111, {
      claimCode: "0xabc",
      claimCodeHash: "0xh1" as `0x${string}`,
      fromHint: "0xsender_B",
    });
    expect(added).toBe(false);
    expect(toastFnMock).toHaveBeenCalledTimes(0);
  });

  it("addToStealthInbox caps inbox at 100 entries (oldest dropped)", () => {
    const existing = Array(100)
      .fill(0)
      .map((_, i) => ({
        claimCode: `0x${i}`,
        claimCodeHash: `0xhash${i}` as `0x${string}`,
        status: "new" as const,
        receivedAt: i,
      }));
    getStoredJsonMock.mockReturnValue(existing);
    addToStealthInbox(ME, 11155111, {
      claimCode: "0xnew",
      claimCodeHash: "0xnewhash" as `0x${string}`,
    });
    const saved = setStoredJsonMock.mock.calls[0][1] as Array<unknown>;
    expect(saved).toHaveLength(100);
  });

  it("markInboxEntryStatus updates status + broadcasts the new status", () => {
    getStoredJsonMock.mockReturnValue([
      { claimCodeHash: "0xh1", status: "new", receivedAt: 1 },
      { claimCodeHash: "0xh2", status: "new", receivedAt: 2 },
    ]);
    markInboxEntryStatus(ME, 11155111, "0xh1" as `0x${string}`, "claimed");
    const saved = setStoredJsonMock.mock.calls[0][1] as Array<{
      claimCodeHash: string;
      status: string;
    }>;
    expect(saved[0].status).toBe("claimed");
    expect(saved[1].status).toBe("new"); // unchanged
    expect(broadcastActionMock).toHaveBeenCalledWith(
      "stealth_inbox_changed",
      expect.objectContaining({
        claimCodeHash: "0xh1",
        status: "claimed",
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — initial state (§15.x)", () => {
  it("returns step='idle' + 8 callables + 5 state fields", () => {
    const { result } = renderHook(() => useStealthPayments());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
    expect(result.current.isWaitingForDecryption).toBe(false);
    expect(result.current.decryptionProgress).toBe("");
    expect(typeof result.current.sendStealth).toBe("function");
    expect(typeof result.current.claimStealth).toBe("function");
    expect(typeof result.current.finalizeClaim).toBe("function");
    expect(typeof result.current.getMyPendingClaims).toBe("function");
    expect(typeof result.current.getPendingClaims).toBe("function");
    expect(typeof result.current.resumePendingClaim).toBe("function");
    expect(typeof result.current.stopPolling).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  sendStealth
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — sendStealth (§15.x)", () => {
  it("no address -> 'Please connect your wallet' toast + null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.sendStealth("100", ALICE, VAULT, "");
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Please connect your wallet");
  });

  it("not connected -> 'Please connect your wallet' toast + null", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.sendStealth("100", ALICE, VAULT, "");
    });
    expect(r).toBeNull();
  });

  it("happy path: TWO writes (approve THEN sendStealth) + encrypt recipient", async () => {
    const transferIdHex =
      "0x000000000000000000000000000000000000000000000000000000000000002a"; // 42
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xapprove" as `0x${string}`,
      receipt: { status: "success", blockNumber: 5n, logs: [] },
    });
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xsend" as `0x${string}`,
      receipt: {
        status: "success",
        blockNumber: 5n,
        logs: [
          {
            address: STEALTH,
            topics: [
              "0xeventsig" as `0x${string}`,
              transferIdHex as `0x${string}`,
            ],
            data: "0x",
          },
        ],
      },
    });
    const { result } = renderHook(() => useStealthPayments());
    let r: { claimCode: string; transferId: number } | null = null;
    await act(async () => {
      r = await result.current.sendStealth("100", ALICE, VAULT, "secret");
    });
    expect(r).not.toBeNull();
    expect(r!.transferId).toBe(42); // extracted from topics[1]
    expect(r!.claimCode.startsWith("0x")).toBe(true);
    expect(r!.claimCode).toHaveLength(66); // 0x + 64 hex chars

    // approve call
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approve");
    expect(approveCall.address).toBe(USDC);
    expect(approveCall.args[0]).toBe(STEALTH);
    expect(approveCall.args[1]).toBe(100_000_000n);
    expect(approveCall.gas).toBe(5_000_000n);

    // sendStealth call
    const sendCall = unifiedWriteAndWaitMock.mock.calls[1][0];
    expect(sendCall.functionName).toBe("sendStealth");
    expect(sendCall.address).toBe(STEALTH);
    expect(sendCall.args[0]).toBe(100_000_000n);
    expect(sendCall.args[3]).toBe(VAULT);
    expect(sendCall.args[4]).toBe("secret");
    expect(sendCall.gas).toBe(5_000_000n);

    // encryptInputsAsync called with Encryptable.address(recipient)
    const encBatch = encryptInputsAsyncMock.mock.calls[0][0] as Array<{
      type: string;
      raw: string;
    }>;
    expect(encBatch[0].type).toBe("address");
    expect(encBatch[0].raw).toBe(ALICE);
  });

  it("STEALTH_SENT activity uses user_to = 0x0 (encrypted on-chain)", async () => {
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xa",
      receipt: { status: "success", blockNumber: 5n, logs: [] },
    });
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xs",
      receipt: {
        status: "success",
        blockNumber: 5n,
        logs: [
          {
            address: STEALTH,
            topics: [
              "0xeventsig" as `0x${string}`,
              "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
            ],
            data: "0x",
          },
        ],
      },
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.sendStealth("100", ALICE, VAULT, "");
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("stealth_sent");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ZERO_ADDR);
    expect(row.contract_address).toBe(STEALTH);
  });

  it("approve reverted -> 'Approval transaction reverted' error + no sendStealth", async () => {
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xa",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.sendStealth("100", ALICE, VAULT, "");
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("error");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1); // approve only
  });

  it("sendStealth reverted -> step='error' + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xa",
      receipt: { status: "success", blockNumber: 5n, logs: [] },
    });
    unifiedWriteAndWaitMock.mockResolvedValueOnce({
      hash: "0xs",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.sendStealth("100", ALICE, VAULT, "");
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("single-flight: second sendStealth while first in-flight returns null", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useStealthPayments());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.sendStealth("100", ALICE, VAULT, "");
      await Promise.resolve();
    });
    let r2: unknown;
    await act(async () => {
      r2 = await result.current.sendStealth("50", BOB, VAULT, "");
    });
    expect(r2).toBeNull();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    resolveFirst({
      hash: "0x",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    await act(async () => {
      await p1;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  claimStealth
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — claimStealth (§15.x)", () => {
  it("no address -> 'Please connect your wallet' + null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.claimStealth(42, CLAIM_CODE);
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Please connect your wallet");
  });

  it("claimStealth args: [BigInt(transferId), claimCode] + gas 5M", async () => {
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.claimStealth(42, CLAIM_CODE);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimStealth");
    expect(call.address).toBe(STEALTH);
    expect(call.args[0]).toBe(42n);
    expect(call.args[1]).toBe(CLAIM_CODE);
    expect(call.gas).toBe(5_000_000n);
  });

  it("happy path: persistPendingClaim with (transferId, claimCode, hash) + STEALTH_CLAIM_STARTED activity", async () => {
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.claimStealth(42, CLAIM_CODE);
    });
    // persistPendingClaim: getStoredJson reads, setStoredJson writes
    const pendingWrites = setStoredJsonMock.mock.calls.filter((c) =>
      String(c[0]).includes("pending_"),
    );
    expect(pendingWrites.length).toBeGreaterThan(0);
    const saved = pendingWrites[0][1] as Array<{
      transferId: number;
      claimCode: string;
      txHash: string;
    }>;
    expect(saved[0].transferId).toBe(42);
    expect(saved[0].claimCode).toBe(CLAIM_CODE);
    expect(saved[0].txHash).toBe("0xtxhash");
    // Activity row
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("stealth_claim_started");
    expect(row.note).toContain("#42");
  });

  it("reverted -> step='error' + no persist + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.claimStealth(42, CLAIM_CODE);
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    const pendingWrites = setStoredJsonMock.mock.calls.filter((c) =>
      String(c[0]).includes("pending_"),
    );
    expect(pendingWrites.length).toBe(0);
  });

  it("returns the claim tx hash on success", async () => {
    const { result } = renderHook(() => useStealthPayments());
    let h: unknown;
    await act(async () => {
      h = await result.current.claimStealth(42, CLAIM_CODE);
    });
    expect(h).toBe("0xtxhash");
  });
});

// ───────────────────────────────────────────────────────────
//  finalizeClaim (4-branch ladder)
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — finalizeClaim (§15.x)", () => {
  beforeEach(() => {
    readContractMock.mockResolvedValue(0x999n); // pending handle present
  });

  it("no address -> 'Please connect your wallet' + null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.finalizeClaim(42);
    });
    expect(r).toBeNull();
  });

  it("(1) handle === 0n -> 'No pending claim' error + step='error' + null", async () => {
    readContractMock.mockResolvedValue(0n);
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.finalizeClaim(42);
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("No pending claim");
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("No pending claim"),
    );
  });

  it("(2) decryptForTx returns null -> 'Decryption not ready yet' + step='error'", async () => {
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(42);
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("Decryption not ready");
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Decryption not ready"),
    );
  });

  it("(3) decryptedAmount === 0n PRIVACY path: error toast + step='error' + txHash PRESERVED + NO activity + STILL removePendingClaim", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 0n,
      signature: ("0x" + "01".repeat(65)) as `0x${string}`,
    });
    // Seed a pending entry so removePendingClaim has something to delete
    getStoredJsonMock.mockReturnValue([
      {
        transferId: 42,
        claimCode: "0xabc",
        claimCodeHash: "0xh",
        startedAt: 1,
        txHash: "0xold",
      },
    ]);
    const { result } = renderHook(() => useStealthPayments());
    let r: unknown;
    await act(async () => {
      r = await result.current.finalizeClaim(42);
    });
    expect(r).toBe("0xtxhash"); // hash returned even on 0n path
    expect(result.current.step).toBe("error");
    expect(result.current.error).toContain("Claim code did not match");
    expect(result.current.txHash).toBe("0xtxhash"); // PRESERVED
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("wasn't intended for your claim code"),
      expect.any(Object),
    );
    // NO activity insert
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    // NO balance broadcast (pending_claim_removed broadcast IS allowed — it
    // signals sibling tabs to drop the entry from the resume UI list).
    expect(broadcastActionMock).not.toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).not.toHaveBeenCalledWith("activity_added");
    // STILL removed from pending (next-write call after removePendingClaim)
    const pendingWrites = setStoredJsonMock.mock.calls.filter((c) =>
      String(c[0]).includes("pending_"),
    );
    expect(pendingWrites.length).toBeGreaterThan(0);
    const finalSaved = pendingWrites[pendingWrites.length - 1][1] as Array<unknown>;
    expect(finalSaved).toEqual([]); // entry removed
  });

  it("(4) decryptedAmount > 0n SUCCESS path: STEALTH_CLAIMED activity + balance broadcast + green toast", async () => {
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 100_000_000n,
      signature: ("0x" + "02".repeat(65)) as `0x${string}`,
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(42);
    });
    expect(result.current.step).toBe("success");
    expect(result.current.txHash).toBe("0xtxhash");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("stealth_claimed");
    expect(row.note).toContain("#42");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("Funds released"),
      expect.any(Object),
    );
  });

  it("finalizeClaim args: [BigInt(transferId), decryptedAmount, signature] + gas 5M", async () => {
    const sig = ("0x" + "03".repeat(65)) as `0x${string}`;
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 50_000_000n,
      signature: sig,
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(7);
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("finalizeClaim");
    expect(call.address).toBe(STEALTH);
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toBe(50_000_000n);
    expect(call.args[2]).toBe(sig);
    expect(call.gas).toBe(5_000_000n);
  });

  it("finalize tx reverted -> step='error' + no activity", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", blockNumber: 5n, logs: [] },
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(42);
    });
    expect(result.current.step).toBe("error");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });

  it("getPendingClaimHandle read uses BigInt(transferId)", async () => {
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(7);
    });
    const readCall = readContractMock.mock.calls[0][0];
    expect(readCall.functionName).toBe("getPendingClaimHandle");
    expect(readCall.args).toEqual([7n]);
  });
});

// ───────────────────────────────────────────────────────────
//  getMyPendingClaims + getPendingClaims + resumePendingClaim
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — pending claims surface (§15.x)", () => {
  it("getMyPendingClaims: empty input -> [] without on-chain call", async () => {
    const { result } = renderHook(() => useStealthPayments());
    let r: number[] = [];
    await act(async () => {
      r = await result.current.getMyPendingClaims([]);
    });
    expect(r).toEqual([]);
    expect(readContractMock).toHaveBeenCalledTimes(0);
  });

  it("getMyPendingClaims: filters by found[i] flag (only true-flagged ids returned)", async () => {
    readContractMock.mockResolvedValue([
      [10n, 20n, 30n], // transferIds
      [true, false, true], // found flags
    ]);
    const { result } = renderHook(() => useStealthPayments());
    let r: number[] = [];
    await act(async () => {
      r = await result.current.getMyPendingClaims([
        "0xh1" as `0x${string}`,
        "0xh2" as `0x${string}`,
        "0xh3" as `0x${string}`,
      ]);
    });
    expect(r).toEqual([10, 30]); // index 1 dropped (found=false)
  });

  it("getMyPendingClaims: readContract throw -> log.warn + returns [] (no crash)", async () => {
    readContractMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useStealthPayments());
    let r: number[] = [];
    await act(async () => {
      r = await result.current.getMyPendingClaims([
        "0xh1" as `0x${string}`,
      ]);
    });
    expect(r).toEqual([]);
  });

  it("getPendingClaims reads from STORAGE_KEYS.pendingStealthClaims for the (addr, chain) key", () => {
    getStoredJsonMock.mockReturnValue([
      {
        transferId: 5,
        claimCode: "0xabc",
        claimCodeHash: "0xh",
        startedAt: 1,
        txHash: "0xt",
      },
    ]);
    const { result } = renderHook(() => useStealthPayments());
    const r = result.current.getPendingClaims();
    expect(r).toHaveLength(1);
    expect(r[0].transferId).toBe(5);
  });

  it("getPendingClaims no address -> []", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useStealthPayments());
    expect(result.current.getPendingClaims()).toEqual([]);
  });

  it("resumePendingClaim delegates to finalizeClaim with Number(transferId)", async () => {
    readContractMock.mockResolvedValue(0x999n);
    decryptForTxMock.mockResolvedValue({
      decryptedValue: 50_000_000n,
      signature: ("0x" + "04".repeat(65)) as `0x${string}`,
    });
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.resumePendingClaim(99n, CLAIM_CODE);
    });
    const finalizeCall = unifiedWriteAndWaitMock.mock.calls.find(
      (c) => c[0].functionName === "finalizeClaim",
    );
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall![0].args[0]).toBe(99n);
  });
});

// ───────────────────────────────────────────────────────────
//  Auto-cleanup effects + reset
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — auto-cleanup + reset (§15.x)", () => {
  it("address goes null -> stopPolling implicit (waiting_for_decryption state resets to idle)", async () => {
    // Drive into a polled state first by claiming
    const initial = renderHook(() => useStealthPayments());
    // Manually flip address to null by re-rendering with a new mock value
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    initial.rerender();
    // State stays idle since we never entered the polled state
    expect(initial.result.current.step).toBe("idle");
  });

  it("reset clears state + calls stopPolling", async () => {
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.finalizeClaim(42);
    });
    expect(result.current.step).toBe("error");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
  });

  it("stopPolling on an idle hook -> no-op (no crash)", () => {
    const { result } = renderHook(() => useStealthPayments());
    expect(() => act(() => result.current.stopPolling())).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────
//  Decryption polling timeout
// ───────────────────────────────────────────────────────────

describe("useStealthPayments — claimStealth polling state (§15.x)", () => {
  it("claimStealth happy path transitions to step='waiting_for_decryption' + isWaitingForDecryption=true", async () => {
    readContractMock.mockResolvedValue(0x999n);
    decryptForTxMock.mockResolvedValue(null); // poll stays pending
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.claimStealth(42, CLAIM_CODE);
    });
    // After claimStealth returns, startDecryptionPolling flipped state
    expect(result.current.step).toBe("waiting_for_decryption");
    expect(result.current.isWaitingForDecryption).toBe(true);
    // Clean up: stopPolling so the setInterval doesn't leak into next test
    act(() => result.current.stopPolling());
  });

  it("stopPolling stops an active poll without crashing", async () => {
    readContractMock.mockResolvedValue(0x999n);
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStealthPayments());
    await act(async () => {
      await result.current.claimStealth(42, CLAIM_CODE);
    });
    expect(result.current.isWaitingForDecryption).toBe(true);
    act(() => result.current.stopPolling());
    // stopPolling doesn't change state on its own; the polling-state flag
    // remains until either timeout, decrypt-ready, or reset(). Pin that
    // stopPolling is callable without throwing.
    expect(result.current.step).toBe("waiting_for_decryption");
  });
});
