import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useClaimLinks. Wave 4 #244 Magic-Claim-Links hook —
// bearer / email-bound / address-bound payment URLs backed by encrypted
// on-chain vault transfers + a salted secret hash.
//
// CRITICAL pins:
//   - 3-mode discriminated union: Bearer (0) / EmailBound (1) /
//     AddressBound (2). Each picks a different hash builder
//     (makeBearerHash / makeEmailHash / makeAddressHash) AND a different
//     claim path (v2 claim(linkId, signature) or legacy claimAddressBound).
//     EmailBound requires a non-empty email with "@" before encrypting.
//     AddressBound requires a non-zero bound-address. The mode integer
//     passed to the contract MUST match the mode used on claim, else
//     the contract reverts with "wrong-mode."
//   - §3.4 ensureVaultApproval uses unifiedWriteAndWait so the
//     approval receipt mines BEFORE markVaultApproved caches. Pre-fix
//     used unifiedWrite (no wait) and markVaultApproved fired before
//     the approve tx mined — if createLink's main tx ran first,
//     transferFromVerified reverted with "insufficient allowance" but
//     localStorage still said "approved", so the retry skipped re-
//     approve and the user was locked out until they manually cleared
//     storage. The AndWait fix is the load-bearing invariant.
//   - §3.10 receipt-path discrimination: AA path returns
//     writeResult.receipt with logs ready -> skip pipeline.markConfirming
//     (no extra RPC). EOA path has no receipt -> fall through to
//     publicClient.waitForTransactionReceipt + flash markConfirming so
//     the user sees the confirm phase.
//   - §1.7 (audit Top-28 #244): extractEventId returns NULL on miss,
//     not 0. Returning 0 silently routed share-links to id=0 which
//     was potentially someone ELSE'S first claim link — leaking the
//     funds to the previous demo's leftover state. The null result
//     throws "Tx mined but linkId could not be read; check History tab"
//     so the user never gets a wrong shareable URL.
//   - §3.11 error state preserves prev.txHash so a failed createLink
//     is still linkable to the explorer for debugging.
//   - §3.12 txExplorerUrl derived from state.txHash + activeChainId.
//   - buildClaimUrl shape pinned per-mode: the URL must include the
//     chainId, linkId, mode, AND the secret (URL-safe base64); the
//     recipient parses this and calls the matching claim* function.
//     Producer (createLink) and consumer (claim) MUST agree on
//     encoding or claim reverts with "wrong-secret".
//   - secret generation per createLink: a new CSPRNG secret every
//     time, NEVER reused; the hash on-chain is deterministic from
//     (secret, mode, optional-binding-info). Two consecutive
//     createLink calls produce DIFFERENT secrets.
//   - pipeline lifecycle: start -> onEncryptStep -> markSubmitting ->
//     markDone on success; markFailed on error. EOA path adds
//     markConfirming between markSubmitting and markDone.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const decryptForTxMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useFhePipelineMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const isVaultApprovedMock = vi.hoisted(() => vi.fn());
const markVaultApprovedMock = vi.hoisted(() => vi.fn());
const extractEventIdMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("./useFhePipeline", () => ({ useFhePipeline: useFhePipelineMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheDecryptForTx: () => ({ decryptForTx: decryptForTxMock }),
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
  Encryptable: new Proxy({}, { get: () => (v: unknown) => ({ raw: v }) }),
}));
vi.mock("@/lib/abis", () => ({ ClaimLinksAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/approval", () => ({
  isVaultApproved: isVaultApprovedMock,
  markVaultApproved: markVaultApprovedMock,
}));
vi.mock("@/lib/event-parser", () => ({ extractEventId: extractEventIdMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
// The real helper, driven by a fake clock so a funding check that never
// arrives times out instantly instead of waiting 90 real seconds.
vi.mock("@/lib/funding-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/funding-gate")>("@/lib/funding-gate");
  return {
    ...actual,
    runFundingGate: (opts: Parameters<typeof actual.runFundingGate>[0]) => {
      let t = 0;
      return actual.runFundingGate({ ...opts, now: () => t, sleep: async (ms: number) => { t += ms; } });
    },
  };
});
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

// Use the REAL claim-links lib so secret generation, hash builders, and
// buildClaimUrl are exercised end-to-end. Mocking these would shadow
// the producer/consumer contract being verified.

import { useClaimLinks, LEGACY_LINK_MESSAGE, CLAIM_LINK_UNFUNDED_MESSAGE } from "./useClaimLinks";
import { MODE, deriveClaimKeyPriv, claimKeyAddress, type LinkMode } from "@/lib/claim-links";
import { recoverMessageAddress } from "viem";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const BOUND_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const CL_ADDR = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const encryptInputsAsyncMock = vi.fn();
const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const readContractMock = vi.fn();
const DIGEST = ("0x" + "d1".repeat(32)) as `0x${string}`;
// claimKeyOf result for the link under test (zero = legacy link).
let registeredKey: `0x${string}` = "0x0000000000000000000000000000000000000000";
function registerKeyFor(mode: LinkMode, secret: Uint8Array, email?: string) {
  registeredKey = claimKeyAddress(deriveClaimKeyPriv(mode, secret, email)!);
}
const onEncryptStepMock = vi.fn();
const markSubmittingMock = vi.fn();
const markConfirmingMock = vi.fn();
const markDoneMock = vi.fn();
const markFailedMock = vi.fn();
const startMock = vi.fn();
const pipelineResetMock = vi.fn();

function bearerParams(over: Record<string, unknown> = {}) {
  return {
    vault: VAULT,
    amountTokens: "100",
    decimals: 6,
    note: "Bearer link",
    expirySeconds: 0,
    input: { mode: MODE.Bearer },
    ...over,
  };
}

function emailParams(over: Record<string, unknown> = {}) {
  return {
    vault: VAULT,
    amountTokens: "100",
    decimals: 6,
    note: "Email-bound link",
    expirySeconds: 7 * 86400,
    input: { mode: MODE.EmailBound, email: "alice@example.com" },
    ...over,
  };
}

function addressBoundParams(over: Record<string, unknown> = {}) {
  return {
    vault: VAULT,
    amountTokens: "100",
    decimals: 6,
    note: "Address-bound link",
    expirySeconds: 0,
    input: { mode: MODE.AddressBound, boundAddress: BOUND_ADDR },
    ...over,
  };
}

beforeEach(() => {
  decryptForTxMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useFhePipelineMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheEncryptMock.mockReset();
  isVaultApprovedMock.mockReset();
  markVaultApprovedMock.mockReset();
  extractEventIdMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  encryptInputsAsyncMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  readContractMock.mockReset();
  registeredKey = "0x0000000000000000000000000000000000000000";
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "claimKeyOf") return registeredKey;
    if (functionName === "claimDigest") return DIGEST;
    throw new Error(`unexpected read ${functionName}`);
  });
  onEncryptStepMock.mockReset();
  markSubmittingMock.mockReset();
  markConfirmingMock.mockReset();
  markDoneMock.mockReset();
  markFailedMock.mockReset();
  startMock.mockReset();
  pipelineResetMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { ClaimLinks: CL_ADDR },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    readContract: readContractMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useFhePipelineMock.mockReturnValue({
    state: { currentIndex: -1, phase: "idle", error: null },
    start: startMock,
    onEncryptStep: onEncryptStepMock,
    markSubmitting: markSubmittingMock,
    markConfirming: markConfirmingMock,
    markDone: markDoneMock,
    markFailed: markFailedMock,
    reset: pipelineResetMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheEncryptMock.mockReturnValue({ encryptInputsAsync: encryptInputsAsyncMock });
  // 0.7: one handle per input, then a single batch signature.
  encryptInputsAsyncMock.mockResolvedValue(["0xhandle", "0xbatchproof"]);
  toastLoadingMock.mockReturnValue("toast-id");
  isVaultApprovedMock.mockReturnValue(true);
  extractEventIdMock.mockReturnValue(42);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash",
    receipt: { status: "success", blockNumber: 1n, logs: [] },
  });
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — initial state (§15.x)", () => {
  it("returns input step + null txExplorerUrl + 4 callable handlers", () => {
    const { result } = renderHook(() => useClaimLinks());
    expect(result.current.state.step).toBe("input");
    expect(result.current.state.isProcessing).toBe(false);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.shareableUrl).toBeNull();
    expect(result.current.state.linkId).toBeNull();
    expect(result.current.txExplorerUrl).toBeNull();
    expect(typeof result.current.createLink).toBe("function");
    expect(typeof result.current.claim).toBe("function");
    expect(typeof result.current.refund).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  createLink guards
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — createLink guards (§15.x)", () => {
  it("no address -> 'Wallet not connected' toast + null return", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useClaimLinks());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createLink(bearerParams());
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("cofhe not connected -> 'Wallet not connected' toast", async () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Wallet not connected");
  });

  it("ClaimLinks contract not deployed (zero addr) -> distinct toast", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ClaimLinks: ZERO_ADDR },
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "ClaimLinks not deployed on this chain yet",
    );
  });

  it("no publicClient -> 'Connection lost' toast", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Connection lost. Please refresh.");
  });

  it("EmailBound mode + empty email -> throws 'Email is required'", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createLink(emailParams({ input: { mode: MODE.EmailBound, email: "" } }));
    });
    expect(r).toBeNull();
    expect(result.current.state.error).toContain("Email is required");
  });

  it("EmailBound mode + email without '@' -> throws 'Email is required'", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createLink(emailParams({ input: { mode: MODE.EmailBound, email: "not-an-email" } }));
    });
    expect(r).toBeNull();
    expect(result.current.state.error).toContain("Email is required");
  });
});

// ───────────────────────────────────────────────────────────
//  §3.4 vault approval AndWait fix
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — §3.4 vault approval (§15.x)", () => {
  it("first createLink approves via unifiedWriteAndWait + markVaultApproved", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    // First call should be the approval, second the createLink
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    const approveCall = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(approveCall.functionName).toBe("approvePlaintext");
    expect(approveCall.address).toBe(VAULT);
    expect(approveCall.args[0]).toBe(CL_ADDR);
    expect(approveCall.args[1]).toBe(BigInt("18446744073709551615")); // MAX_UINT64
    expect(markVaultApprovedMock).toHaveBeenCalledWith(CL_ADDR);
    // Order: markVaultApproved AFTER the approve tx awaited
    const calls = markVaultApprovedMock.mock.invocationCallOrder[0];
    const approveOrder = unifiedWriteAndWaitMock.mock.invocationCallOrder[0];
    expect(calls).toBeGreaterThan(approveOrder);
  });

  it("pre-approved -> skip approval (single unifiedWriteAndWait call)", async () => {
    isVaultApprovedMock.mockReturnValue(true);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].functionName).toBe("createLink");
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
  });

  it("approval failure -> toast + main createLink NOT fired + markVaultApproved NOT called", async () => {
    isVaultApprovedMock.mockReturnValue(false);
    unifiedWriteAndWaitMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "approvePlaintext") {
        throw new Error("approve reverted");
      }
      return { hash: "0x", receipt: { status: "success", logs: [] } };
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    expect(markVaultApprovedMock).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Approval failed",
      expect.objectContaining({ id: "toast-id" }),
    );
    expect(result.current.state.step).toBe("error");
  });
});

// ───────────────────────────────────────────────────────────
//  createLink: 3-mode hash + URL building
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — Bearer mode (§15.x)", () => {
  it("passes Bearer mode (0) + ZERO_ADDR boundAddress to createLink", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("createLink");
    expect(call.args[4]).toBe(MODE.Bearer);
    expect(call.args[5]).toBe(ZERO_ADDR);
  });

  it("CRITICAL registers the claim key derived from the URL secret (never the secret itself)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: { secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r = (await result.current.createLink(bearerParams())) as { secretHex: `0x${string}` };
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    const secret = Uint8Array.from(Buffer.from(r!.secretHex.slice(2), "hex"));
    expect(call.args[3]).toBe(claimKeyAddress(deriveClaimKeyPriv(MODE.Bearer, secret)!));
    expect(JSON.stringify(call.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
      r!.secretHex.slice(2),
    );
  });

  it("returns { linkId, shareableUrl, secretHex } on success", async () => {
    extractEventIdMock.mockReturnValue(7);
    const { result } = renderHook(() => useClaimLinks());
    let r: { linkId: number; shareableUrl: string; secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r = await result.current.createLink(bearerParams());
    });
    expect(r).not.toBeNull();
    expect(r!.linkId).toBe(7);
    expect(r!.shareableUrl).toContain("/claim/");
    expect(r!.shareableUrl).toContain(String(7));
    expect(r!.secretHex).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("populates state.shareableUrl + state.linkId on success", async () => {
    extractEventIdMock.mockReturnValue(99);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.shareableUrl).toContain("99");
    expect(result.current.state.linkId).toBe(99);
    expect(result.current.state.step).toBe("success");
  });
});

describe("useClaimLinks — EmailBound mode (§15.x)", () => {
  it("valid email -> EmailBound mode (1) + ZERO_ADDR bound + claim key mixes the email in", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: { secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r = (await result.current.createLink(emailParams())) as { secretHex: `0x${string}` };
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args[4]).toBe(MODE.EmailBound);
    expect(call.args[5]).toBe(ZERO_ADDR);
    const secret = Uint8Array.from(Buffer.from(r!.secretHex.slice(2), "hex"));
    expect(call.args[3]).toBe(claimKeyAddress(deriveClaimKeyPriv(MODE.EmailBound, secret, "alice@example.com")!));
    expect(call.args[3]).not.toBe(claimKeyAddress(deriveClaimKeyPriv(MODE.EmailBound, secret, "mallory@example.com")!));
  });

  it("email '@' position 0 ('@example.com') -> rejected (indexOf < 1)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createLink(emailParams({ input: { mode: MODE.EmailBound, email: "@example.com" } }));
    });
    expect(r).toBeNull();
    expect(result.current.state.error).toContain("Email is required");
  });
});

describe("useClaimLinks — AddressBound mode (§15.x)", () => {
  it("valid bound address -> passes AddressBound mode (2) + non-zero bound + AddressBound hash", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(addressBoundParams());
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args[4]).toBe(MODE.AddressBound);
    expect(call.args[5]).toBe(BOUND_ADDR);
  });

  it("shareableUrl encodes the mode in the hash fragment (consumer discriminates by leading char)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: { linkId: number; shareableUrl: string; secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r = await result.current.createLink(addressBoundParams());
    });
    // Mode encoded as single char ('a' = AddressBound) prefix before
    // the secret in the URL hash fragment: /claim/{chainId}/{linkId}#a.{secret}
    expect(r!.shareableUrl).toMatch(/#a\./);
  });

  it("Bearer mode -> URL fragment starts with 'b.'", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: { shareableUrl: string } | null = null;
    await act(async () => {
      r = (await result.current.createLink(bearerParams())) as { shareableUrl: string };
    });
    expect(r!.shareableUrl).toMatch(/#b\./);
  });

  it("EmailBound mode -> URL fragment starts with 'e.'", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let r: { shareableUrl: string } | null = null;
    await act(async () => {
      r = (await result.current.createLink(emailParams())) as { shareableUrl: string };
    });
    expect(r!.shareableUrl).toMatch(/#e\./);
  });
});

// ───────────────────────────────────────────────────────────
//  Secret generation freshness
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — secret freshness (§15.x)", () => {
  it("two consecutive createLink calls produce DIFFERENT secrets (CSPRNG, not cached)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    extractEventIdMock.mockReturnValue(1);
    let r1: { secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r1 = (await result.current.createLink(bearerParams())) as { secretHex: `0x${string}` };
    });
    extractEventIdMock.mockReturnValue(2);
    let r2: { secretHex: `0x${string}` } | null = null;
    await act(async () => {
      r2 = (await result.current.createLink(bearerParams())) as { secretHex: `0x${string}` };
    });
    expect(r1!.secretHex).not.toBe(r2!.secretHex);
  });
});

// ───────────────────────────────────────────────────────────
//  parseUnits encoding
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — parseUnits encoding (§15.x)", () => {
  it("parseUnits('2.5', 6) -> 2_500_000n encoded via Encryptable.uint64", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams({ amountTokens: "2.5", decimals: 6 }));
    });
    const arr = encryptInputsAsyncMock.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(arr[0].raw).toBe(2_500_000n);
  });

  it("expirySeconds 0 (contract default) passes through unchanged", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams({ expirySeconds: 0 }));
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.args[6]).toBe(0n);
  });

  it("custom expirySeconds passes through as BigInt", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams({ expirySeconds: 30 * 86400 }));
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].args[6]).toBe(BigInt(30 * 86400));
  });
});

// ───────────────────────────────────────────────────────────
//  §3.10 receipt-path discrimination
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — §3.10 receipt path (§15.x)", () => {
  it("AA path: writeResult.receipt present -> SKIPS markConfirming + waitForTransactionReceipt", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xaa",
      receipt: { status: "success", logs: [] },
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path: no receipt -> markConfirming flash + waitForTransactionReceipt call", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xeoa",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "success",
      logs: [],
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(markConfirmingMock).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xeoa",
      confirmations: 1,
    });
  });

  it("EOA path reverted -> throws 'createLink reverted on-chain'", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: undefined,
    });
    waitForTransactionReceiptMock.mockResolvedValue({
      status: "reverted",
      logs: [],
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("createLink reverted");
  });

  it("AA-receipt reverted status -> same throw", async () => {
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xrev",
      receipt: { status: "reverted", logs: [] },
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("createLink reverted");
  });
});

// ───────────────────────────────────────────────────────────
//  §1.7 extractEventId null guard (audit Top-28 fix)
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — §1.7 extractEventId null guard (§15.x)", () => {
  it("extractEventId returns null -> throws + no shareableUrl returned (NEVER routes to id=0)", async () => {
    extractEventIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useClaimLinks());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createLink(bearerParams());
    });
    expect(r).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toContain("linkId could not be read");
    expect(result.current.state.shareableUrl).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Pipeline lifecycle
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — pipeline lifecycle (§15.x)", () => {
  it("happy path: start -> onEncryptStep passed -> markSubmitting -> markDone", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(startMock).toHaveBeenCalled();
    const encArgs = encryptInputsAsyncMock.mock.calls[0];
    // 0.7 signature: (items, consumingContract, onStep)
    expect(encArgs[1]).toBe(CL_ADDR);
    expect(encArgs[2]).toBe(onEncryptStepMock);
    expect(markSubmittingMock).toHaveBeenCalled();
    expect(markDoneMock).toHaveBeenCalled();
    expect(markFailedMock).toHaveBeenCalledTimes(0);
  });

  it("error path: markFailed called with the thrown error", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("rejected"));
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(markFailedMock).toHaveBeenCalledWith(expect.any(Error));
    expect(markDoneMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  §3.11 error state preserves prev.txHash
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — §3.11 error preserves prev.txHash (§15.x)", () => {
  it("successful createLink then failed claim preserves txHash from the success", async () => {
    extractEventIdMock.mockReturnValue(42);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.txHash).toBe("0xtxhash");
    registerKeyFor(MODE.Bearer, new Uint8Array(32).fill(1));
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("claim failed"));
    await act(async () => {
      await result.current.claim({
        linkId: 42,
        mode: MODE.Bearer,
        secret: new Uint8Array(32).fill(1),
      });
    });
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.txHash).toBe("0xtxhash"); // preserved
  });
});

// ───────────────────────────────────────────────────────────
//  §3.12 txExplorerUrl
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — §3.12 txExplorerUrl (§15.x)", () => {
  it("null when no tx hash", () => {
    const { result } = renderHook(() => useClaimLinks());
    expect(result.current.txExplorerUrl).toBeNull();
  });

  it("after successful createLink -> URL contains the tx hash", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.txExplorerUrl).toContain("0xtxhash");
  });
});

// ───────────────────────────────────────────────────────────
//  claim
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — claim (§15.x)", () => {
  it("ClaimLinks not deployed -> returns false + toast (no write)", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ClaimLinks: ZERO_ADDR },
    });
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.claim({
        linkId: 1,
        mode: MODE.Bearer,
        secret: new Uint8Array(32),
      });
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("ClaimLinks not deployed on this chain");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("Bearer v2 -> claim(linkId, sig) where sig recovers to the registered claim key over claimDigest", async () => {
    const secret = new Uint8Array(32).fill(0xab);
    registerKeyFor(MODE.Bearer, secret);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.claim({ linkId: 7, mode: MODE.Bearer, secret });
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claim");
    expect(call.args[0]).toBe(7n);
    const signer = await recoverMessageAddress({ message: { raw: DIGEST }, signature: call.args[1] });
    expect(signer).toBe(registeredKey);
    // The digest is bound to the connected claimer.
    const digestRead = readContractMock.mock.calls.find((c) => c[0].functionName === "claimDigest")![0];
    expect(digestRead.args).toEqual([7n, ME]);
    // The secret itself is never sent.
    expect(String(call.args[1])).not.toContain("ab".repeat(32));
  });

  it("EmailBound v2 -> signs with the email-mixed key", async () => {
    const secret = new Uint8Array(32).fill(3);
    registerKeyFor(MODE.EmailBound, secret, "alice@example.com");
    const { result } = renderHook(() => useClaimLinks());
    let ok = false;
    await act(async () => {
      ok = await result.current.claim({ linkId: 7, mode: MODE.EmailBound, secret, email: "Alice@Example.com " });
    });
    expect(ok).toBe(true);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claim");
    const signer = await recoverMessageAddress({ message: { raw: DIGEST }, signature: call.args[1] });
    expect(signer).toBe(registeredKey);
  });

  it("EmailBound v2 with the wrong email -> 'email does not match', no write", async () => {
    const secret = new Uint8Array(32).fill(3);
    registerKeyFor(MODE.EmailBound, secret, "alice@example.com");
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.claim({ linkId: 7, mode: MODE.EmailBound, secret, email: "bob@example.com" });
    });
    expect(ok).toBe(false);
    expect(result.current.state.error).toContain("email does not match");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("Bearer v2 with a corrupted secret -> invalid link error, no write", async () => {
    registerKeyFor(MODE.Bearer, new Uint8Array(32).fill(1));
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.claim({ linkId: 7, mode: MODE.Bearer, secret: new Uint8Array(32).fill(2) });
    });
    expect(ok).toBe(false);
    expect(result.current.state.error).toContain("invalid");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("EmailBound mode without email -> throws 'Email is required to claim'", async () => {
    registerKeyFor(MODE.EmailBound, new Uint8Array(32), "alice@example.com");
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.claim({
        linkId: 7,
        mode: MODE.EmailBound,
        secret: new Uint8Array(32),
        // email omitted
      });
    });
    expect(ok).toBe(false);
    expect(result.current.state.error).toContain("Email is required");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("legacy AddressBound link (no claim key) -> claimAddressBound(linkId, secretHex)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.claim({
        linkId: 7,
        mode: MODE.AddressBound,
        secret: new Uint8Array(32),
      });
    });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("claimAddressBound");
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("legacy Bearer / EmailBound link -> refund-only message, no write", async () => {
    for (const mode of [MODE.Bearer, MODE.EmailBound] as const) {
      unifiedWriteAndWaitMock.mockClear();
      const { result } = renderHook(() => useClaimLinks());
      let ok = true;
      await act(async () => {
        ok = await result.current.claim({ linkId: 7, mode, secret: new Uint8Array(32), email: "a@b.co" });
      });
      expect(ok).toBe(false);
      expect(result.current.state.error).toBe(LEGACY_LINK_MESSAGE);
      expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
    }
  });

  it("claim success: returns true + sets state.step='success' + state.linkId", async () => {
    registerKeyFor(MODE.Bearer, new Uint8Array(32));
    const { result } = renderHook(() => useClaimLinks());
    let ok = false;
    await act(async () => {
      ok = await result.current.claim({
        linkId: 99,
        mode: MODE.Bearer,
        secret: new Uint8Array(32),
      });
    });
    expect(ok).toBe(true);
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.linkId).toBe(99);
    expect(result.current.state.txHash).toBe("0xtxhash");
    expect(markDoneMock).toHaveBeenCalled();
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("claim rejection -> returns false + step=error + markFailed", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("wrong-secret"));
    registerKeyFor(MODE.Bearer, new Uint8Array(32));
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.claim({
        linkId: 7,
        mode: MODE.Bearer,
        secret: new Uint8Array(32),
      });
    });
    expect(ok).toBe(false);
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.error).toBe("wrong-secret");
    expect(markFailedMock).toHaveBeenCalled();
  });

  it("claim uses gas 5_000_000 (FHE precompile margin)", async () => {
    registerKeyFor(MODE.Bearer, new Uint8Array(32));
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.claim({
        linkId: 1,
        mode: MODE.Bearer,
        secret: new Uint8Array(32),
      });
    });
    expect(unifiedWriteAndWaitMock.mock.calls[0][0].gas).toBe(5_000_000n);
  });
});

// ───────────────────────────────────────────────────────────
//  refund
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — refund (§15.x)", () => {
  it("ClaimLinks not deployed -> returns false silently", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ClaimLinks: ZERO_ADDR },
    });
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.refund(7);
    });
    expect(ok).toBe(false);
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: calls refundLink(linkId) + invalidate + 'Refund completed' toast", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let ok = false;
    await act(async () => {
      ok = await result.current.refund(42);
    });
    expect(ok).toBe(true);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("refundLink");
    expect(call.args).toEqual([42n]);
    expect(call.gas).toBe(2_000_000n);
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Refund completed");
  });

  it("refund rejection -> returns false + error toast with the error message", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("not yet expired"));
    const { result } = renderHook(() => useClaimLinks());
    let ok = true;
    await act(async () => {
      ok = await result.current.refund(42);
    });
    expect(ok).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith("not yet expired");
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — reset (§15.x)", () => {
  it("reset clears state to initial + calls pipeline.reset", async () => {
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.step).toBe("success");
    act(() => result.current.reset());
    expect(result.current.state.step).toBe("input");
    expect(result.current.state.txHash).toBeNull();
    expect(result.current.state.shareableUrl).toBeNull();
    expect(result.current.state.linkId).toBeNull();
    expect(pipelineResetMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Concurrent invocation guard
// ───────────────────────────────────────────────────────────

describe("useClaimLinks — concurrent invocation guard (§15.x)", () => {
  it("second createLink while first is in-flight -> short-circuits via state.isProcessing", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    unifiedWriteAndWaitMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFirst = res;
      }),
    );
    const { result } = renderHook(() => useClaimLinks());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.createLink(bearerParams());
      await Promise.resolve();
    });
    let secondResult: unknown = "x";
    await act(async () => {
      secondResult = await result.current.createLink(bearerParams({ note: "second" }));
    });
    expect(secondResult).toBeNull();
    resolveFirst({
      hash: "0x",
      receipt: { status: "success", logs: [] },
    });
    await act(async () => {
      await p1;
    });
  });
});

describe("useClaimLinks: fetchLink legacy flags", () => {
  const tuple = (mode: number) =>
    [ME, VAULT, mode, ZERO_ADDR, 1n, 2n, false, false, "n", ZERO_ADDR, 0n] as const;
  function withReads(mode: number, key: string | Error) {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getLink") return tuple(mode);
      if (functionName === "claimKeyOf") {
        if (key instanceof Error) throw key;
        return key;
      }
      throw new Error(functionName);
    });
  }

  it("v2 link: legacy=false, legacyRefundOnly=false", async () => {
    withReads(MODE.Bearer, "0x" + "c".repeat(40));
    const { result } = renderHook(() => useClaimLinks());
    const link = await result.current.fetchLink(3n);
    expect(link?.legacy).toBe(false);
    expect(link?.legacyRefundOnly).toBe(false);
  });

  it("legacy Bearer / EmailBound: refund-only", async () => {
    for (const mode of [MODE.Bearer, MODE.EmailBound]) {
      withReads(mode, ZERO_ADDR);
      const { result } = renderHook(() => useClaimLinks());
      const link = await result.current.fetchLink(3n);
      expect(link?.legacy).toBe(true);
      expect(link?.legacyRefundOnly).toBe(true);
    }
  });

  it("legacy AddressBound: still claimable, not refund-only", async () => {
    withReads(MODE.AddressBound, ZERO_ADDR);
    const { result } = renderHook(() => useClaimLinks());
    const link = await result.current.fetchLink(3n);
    expect(link?.legacy).toBe(true);
    expect(link?.legacyRefundOnly).toBe(false);
  });

  it("claimKeyOf missing (pre-upgrade deployment) -> treated as legacy, not a miss", async () => {
    withReads(MODE.Bearer, new Error("reverted"));
    const { result } = renderHook(() => useClaimLinks());
    const link = await result.current.fetchLink(3n);
    expect(link).not.toBeNull();
    expect(link?.legacyRefundOnly).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  Funding gate: createLink ends PendingFunding, confirmFunding settles it
// ───────────────────────────────────────────────────────────

describe("useClaimLinks: funding gate", () => {
  const SIG = "0x5151" as const;
  let fundingCode = 1; // ClaimLinks.FundingStatus: 0 Active, 1 PendingFunding, 2 Void

  beforeEach(() => {
    fundingCode = 1;
    extractEventIdMock.mockReturnValue(9);
    readContractMock.mockImplementation(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "claimKeyOf") return registeredKey;
      if (functionName === "claimDigest") return DIGEST;
      // The probe asks about id 0, which has no check; real ids have a handle.
      if (functionName === "getFundingCheck") return args[0] === 0n ? 0n : 77n;
      if (functionName === "fundingStatus") return fundingCode;
      throw new Error(`unexpected read ${functionName}`);
    });
  });

  const confirmCalls = () =>
    unifiedWriteAndWaitMock.mock.calls.map((c) => c[0]).filter((c) => c.functionName === "confirmFunding");

  it("funded: decrypts the check, confirms with the signature, and releases the share URL", async () => {
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useClaimLinks());
    let out: Awaited<ReturnType<typeof result.current.createLink>> = null;
    await act(async () => {
      out = await result.current.createLink(bearerParams());
    });
    expect(decryptForTxMock).toHaveBeenCalledWith(77n, "ebool");
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].args).toEqual([9n, true, SIG]);
    expect(out).toMatchObject({ linkId: 9, funding: "active" });
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.funding).toBe("active");
    expect(result.current.state.shareableUrl).toContain("/9");
    expect(markDoneMock).toHaveBeenCalled();
  });

  it("unfunded: confirms false, returns null, withholds the URL, says nothing was locked", async () => {
    decryptForTxMock.mockResolvedValue({ decryptedValue: false, signature: SIG });
    const { result } = renderHook(() => useClaimLinks());
    let out: unknown = "unset";
    await act(async () => {
      out = await result.current.createLink(bearerParams());
    });
    expect(confirmCalls()[0].args).toEqual([9n, false, SIG]);
    expect(out).toBeNull();
    expect(result.current.state.step).toBe("error");
    expect(result.current.state.funding).toBe("void");
    expect(result.current.state.shareableUrl).toBeNull();
    expect(result.current.state.error).toBe(CLAIM_LINK_UNFUNDED_MESSAGE);
    expect(result.current.state.error).toContain("Nothing was locked");
    expect(toastErrorMock).toHaveBeenCalledWith(CLAIM_LINK_UNFUNDED_MESSAGE);
    expect(markFailedMock).toHaveBeenCalled();
  });

  it("decryption never arrives: link stays pending on-chain, no confirm, no fake success", async () => {
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useClaimLinks());
    let out: Awaited<ReturnType<typeof result.current.createLink>> = null;
    await act(async () => {
      out = await result.current.createLink(bearerParams());
    });
    expect(confirmCalls()).toHaveLength(0);
    // The secret only exists here, so the URL is kept in state for finishFunding.
    expect(out).toMatchObject({ linkId: 9, funding: "pending" });
    expect(result.current.state.funding).toBe("pending");
    expect(result.current.state.shareableUrl).not.toBeNull();
    const msg = toastErrorMock.mock.calls.map((c) => String(c[0])).find((m) => m.includes("Link #9"));
    expect(msg).toContain("not confirmed");
    expect(msg).toContain("Finish funding");
  });

  it("confirm tx rejected by the wallet: still pending, reason shown", async () => {
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    unifiedWriteAndWaitMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "confirmFunding") throw new Error("User rejected the request");
      return { hash: "0xtxhash", receipt: { status: "success", blockNumber: 1n, logs: [] } };
    });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => {
      await result.current.createLink(bearerParams());
    });
    expect(result.current.state.funding).toBe("pending");
    expect(toastErrorMock.mock.calls.map((c) => String(c[0])).join(" ")).toContain("User rejected the request");
  });

  it("legacy contract (no getFundingCheck): old behaviour, no decrypt, no confirm", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      throw new Error(`function ${functionName} not found`);
    });
    const { result } = renderHook(() => useClaimLinks());
    let out: Awaited<ReturnType<typeof result.current.createLink>> = null;
    await act(async () => {
      out = await result.current.createLink(bearerParams());
    });
    expect(decryptForTxMock).not.toHaveBeenCalled();
    expect(confirmCalls()).toHaveLength(0);
    expect(out).toMatchObject({ linkId: 9, funding: null });
    expect(result.current.state.step).toBe("success");
    expect(result.current.state.funding).toBeNull();
  });

  it("probes support once per hook: a second create does not probe again", async () => {
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => { await result.current.createLink(bearerParams()); });
    await act(async () => { await result.current.createLink(bearerParams()); });
    const probes = readContractMock.mock.calls.filter((c) => c[0].functionName === "getFundingCheck" && c[0].args[0] === 0n);
    expect(probes).toHaveLength(1);
  });

  it("finishFunding completes a pending link and then shows the URL", async () => {
    decryptForTxMock.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => { await result.current.createLink(bearerParams()); });
    expect(result.current.state.funding).toBe("pending");

    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    let verdict: string | null = null;
    await act(async () => { verdict = await result.current.finishFunding(9); });
    expect(verdict).toBe("funded");
    expect(confirmCalls()[0].args).toEqual([9n, true, SIG]);
    expect(result.current.state.funding).toBe("active");
    expect(result.current.state.step).toBe("success");
  });

  it("finishFunding on a link someone else already settled sends no second confirm", async () => {
    fundingCode = 0;
    decryptForTxMock.mockResolvedValue({ decryptedValue: true, signature: SIG });
    const { result } = renderHook(() => useClaimLinks());
    let verdict: string | null = null;
    await act(async () => { verdict = await result.current.finishFunding(4); });
    expect(verdict).toBe("funded");
    expect(confirmCalls()).toHaveLength(0);
  });

  it("finishFunding that cannot decrypt returns null and leaves the link pending", async () => {
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useClaimLinks());
    let verdict: string | null = "x";
    await act(async () => { verdict = await result.current.finishFunding(4); });
    expect(verdict).toBeNull();
    expect(confirmCalls()).toHaveLength(0);
    expect(result.current.state.error).toContain("Link #4");
  });

  it("finishFunding on a legacy contract says there is nothing to finish", async () => {
    readContractMock.mockImplementation(async () => { throw new Error("no such function"); });
    const { result } = renderHook(() => useClaimLinks());
    let verdict: string | null = "x";
    await act(async () => { verdict = await result.current.finishFunding(4); });
    expect(verdict).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("This claim link contract has no funding check to finish.");
  });

  it("cancelPending writes cancelPendingLink(id)", async () => {
    const { result } = renderHook(() => useClaimLinks());
    let ok = false;
    await act(async () => { ok = await result.current.cancelPending(9); });
    expect(ok).toBe(true);
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("cancelPendingLink");
    expect(call.args).toEqual([9n]);
  });

  it("claim on a pending link surfaces a recipient-readable message, not the raw revert", async () => {
    const secret = new Uint8Array(32).fill(0xab);
    registerKeyFor(MODE.Bearer, secret);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("execution reverted: ClaimLinks: funding pending"));
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => { await result.current.claim({ linkId: 7, mode: MODE.Bearer, secret }); });
    expect(toastErrorMock).toHaveBeenCalledWith("This link is still being funded. Try again in a minute.");
  });

  it("claim on a void link says it was never funded", async () => {
    const secret = new Uint8Array(32).fill(0xab);
    registerKeyFor(MODE.Bearer, secret);
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("ClaimLinks: link unfunded"));
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => { await result.current.claim({ linkId: 7, mode: MODE.Bearer, secret }); });
    expect(toastErrorMock).toHaveBeenCalledWith("This link was never funded, so there is nothing to claim.");
  });

  it("refund on a pending link points to Finish / Cancel instead", async () => {
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("ClaimLinks: funding pending"));
    const { result } = renderHook(() => useClaimLinks());
    await act(async () => { await result.current.refund(7); });
    expect(toastErrorMock).toHaveBeenCalledWith("This link is still waiting for its funding check. Finish or cancel it instead.");
  });

  it("fetchLink reports funding from fundingStatus, and active when the view is missing", async () => {
    const tuple = [ME, VAULT, MODE.Bearer, ZERO_ADDR, 1n, 2n, false, false, "n", ZERO_ADDR, 0n] as const;
    const reads = (status: number | Error) =>
      readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "getLink") return tuple;
        if (functionName === "claimKeyOf") return "0x" + "c".repeat(40);
        if (functionName === "fundingStatus") {
          if (status instanceof Error) throw status;
          return status;
        }
        throw new Error(functionName);
      });
    const { result } = renderHook(() => useClaimLinks());
    reads(1);
    expect((await result.current.fetchLink(3n))?.funding).toBe("pending");
    reads(2);
    expect((await result.current.fetchLink(3n))?.funding).toBe("void");
    reads(0);
    expect((await result.current.fetchLink(3n))?.funding).toBe("active");
    reads(new Error("function not found"));
    expect((await result.current.fetchLink(3n))?.funding).toBe("active");
  });
});
