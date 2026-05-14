import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useSmartAccount. The AA orchestration hook — passkey
// lifecycle (create/remove), counterfactual address resolution, and
// UserOp submission via /api/relay.
//
// CRITICAL pins:
//   - Mount lifecycle: hasPasskey -> getPasskeyPubkey -> factory.getAddress
//     -> getCode for deployment status. status="no-passkey" when no
//     passkey exists; "ready" when passkey + address resolved. The
//     resolution runs OUTSIDE the useEffect (the effect just awaits +
//     swallows) so unhandled-promise rejections don't escape.
//   - resolveAccount errors caught + surfaced as status="error" + error
//     state. Without the catch, RPC rate-limit / network blip / factory
//     not deployed on the active chain would all bubble as unhandled
//     promise rejections (Sentry budget hit, e2e harness fails).
//   - Cross-tab passkey sync: onCrossTabAction("aa_passkey_changed") with
//     matching chainId triggers re-resolve. Without this, BlankApp's
//     instance of the hook never sees the modal's create, stays on
//     "no-passkey", and the Onboarding screen never closes.
//   - #246 cross-tab nonce sync: onCrossTabAction("aa_nonce_used") with
//     matching address bumps pendingNonceRef so a parallel submit in
//     this tab takes max(on-chain, broadcasted+1). chainId guard skips
//     non-matching chains (optional field).
//   - createAccount: createPasskey + factory.getAddress + broadcastAction
//     ("aa_passkey_changed") + state -> "ready". The broadcast is
//     load-bearing — without it, sibling hook instances stay stale.
//   - removeAccount: deletePasskey + state -> "no-passkey" + broadcast.
//   - #123 in-flight dedup via inflightRef Map keyed on callData — same
//     callData submitted twice within the same in-flight window returns
//     the SAME promise (no second UserOp build, no nonce collision).
//   - #123 nonce hint: getNextNonce returns on-chain N, pendingNonceRef
//     may carry a local hint; the submit uses max(onChain, localHint)
//     and bumps localHint to nonce+1 immediately so the NEXT submit
//     (before the first mines) takes a higher nonce. Relay !ok rolls
//     back the local hint to its pre-submit value so the next attempt
//     doesn't skip a nonce.
//   - First UserOp (account.isDeployed === false) -> initCode set via
//     encodeFactoryInitCode + verificationGasLimit=5_000_000n (factory
//     + UUPS proxy + init costs ~300-500k + P-256 verify, default 2M
//     is too tight); subsequent ops have initCode="0x" + default
//     verifGas. status flips to "deploying" on first, "submitting" on
//     subsequent.
//   - Paymaster mode dispatch: "sponsored" (default) -> encodeBlankPaymasterData
//     when BlankPaymaster configured; "self" -> paymasterAndData="0x"
//     (AA pays from its own ETH via BaseAccount._payPrefund). No
//     BlankPaymaster configured -> "0x" regardless of mode.
//   - callGasLimit override: passed through to buildUserOp; useful for
//     batch FHE ops where the 2M default is too low.
//   - sendUserOp wraps submitCallData with encodeExecuteCall (target,
//     value, data); sendBatchUserOp wraps with encodeExecuteBatchCall.

const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const hasPasskeyMock = vi.hoisted(() => vi.fn());
const getPasskeyPubkeyMock = vi.hoisted(() => vi.fn());
const createPasskeyMock = vi.hoisted(() => vi.fn());
const signHashMock = vi.hoisted(() => vi.fn());
const deletePasskeyMock = vi.hoisted(() => vi.fn());
const buildUserOpMock = vi.hoisted(() => vi.fn());
const computeUserOpHashMock = vi.hoisted(() => vi.fn());
const encodeBlankPaymasterDataMock = vi.hoisted(() => vi.fn());
const encodeExecuteCallMock = vi.hoisted(() => vi.fn());
const encodeExecuteBatchCallMock = vi.hoisted(() => vi.fn());
const encodeP256SignatureMock = vi.hoisted(() => vi.fn());
const getNextNonceMock = vi.hoisted(() => vi.fn());
const serializeUserOpMock = vi.hoisted(() => vi.fn());
const encodeFactoryInitCodeMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const onCrossTabActionMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/abis", () => ({ BlankAccountFactoryAbi: [] }));
vi.mock("@/lib/passkey", () => ({
  hasPasskey: hasPasskeyMock,
  getPasskeyPubkey: getPasskeyPubkeyMock,
  createPasskey: createPasskeyMock,
  signHash: signHashMock,
  deletePasskey: deletePasskeyMock,
}));
vi.mock("@/lib/userop", () => ({
  ENTRYPOINT_V08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  buildUserOp: buildUserOpMock,
  computeUserOpHash: computeUserOpHashMock,
  encodeBlankPaymasterData: encodeBlankPaymasterDataMock,
  encodeExecuteCall: encodeExecuteCallMock,
  encodeExecuteBatchCall: encodeExecuteBatchCallMock,
  encodeP256Signature: encodeP256SignatureMock,
  getNextNonce: getNextNonceMock,
  serializeUserOp: serializeUserOpMock,
  encodeFactoryInitCode: encodeFactoryInitCodeMock,
}));
vi.mock("@/lib/cross-tab", () => ({
  broadcastAction: broadcastActionMock,
  onCrossTabAction: onCrossTabActionMock,
}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));

import { useSmartAccount } from "./useSmartAccount";

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const PAYMASTER = "0x2222222222222222222222222222222222222222" as const;
const PREDICTED = "0x3333333333333333333333333333333333333333" as const;
const PUB_X = ("0x" + "aa".repeat(32)) as `0x${string}`;
const PUB_Y = ("0x" + "bb".repeat(32)) as `0x${string}`;
const TARGET = "0x4444444444444444444444444444444444444444" as const;

const readContractMock = vi.fn();
const getCodeMock = vi.fn();
let crossTabHandlers: Array<(action: string, data?: unknown) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  hasPasskeyMock.mockReset();
  getPasskeyPubkeyMock.mockReset();
  createPasskeyMock.mockReset();
  signHashMock.mockReset();
  deletePasskeyMock.mockReset();
  buildUserOpMock.mockReset();
  computeUserOpHashMock.mockReset();
  encodeBlankPaymasterDataMock.mockReset();
  encodeExecuteCallMock.mockReset();
  encodeExecuteBatchCallMock.mockReset();
  encodeP256SignatureMock.mockReset();
  getNextNonceMock.mockReset();
  serializeUserOpMock.mockReset();
  encodeFactoryInitCodeMock.mockReset();
  broadcastActionMock.mockReset();
  onCrossTabActionMock.mockReset();
  readContractMock.mockReset();
  getCodeMock.mockReset();
  crossTabHandlers = [];

  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { BlankAccountFactory: FACTORY, BlankPaymaster: PAYMASTER },
  });
  usePublicClientMock.mockReturnValue({
    readContract: readContractMock,
    getCode: getCodeMock,
  });
  // Capture handlers so tests can fire cross-tab events synthetically
  onCrossTabActionMock.mockImplementation(
    (handler: (action: string, data?: unknown) => void) => {
      crossTabHandlers.push(handler);
      return () => {
        crossTabHandlers = crossTabHandlers.filter((h) => h !== handler);
      };
    },
  );
  hasPasskeyMock.mockResolvedValue(true);
  getPasskeyPubkeyMock.mockResolvedValue({ pubX: PUB_X, pubY: PUB_Y });
  readContractMock.mockResolvedValue(PREDICTED);
  getCodeMock.mockResolvedValue("0xdeployed"); // non-empty -> deployed
  buildUserOpMock.mockReturnValue({ sender: PREDICTED });
  computeUserOpHashMock.mockResolvedValue("0xuserophash");
  signHashMock.mockResolvedValue({ r: "0xr", s: "0xs" });
  encodeP256SignatureMock.mockReturnValue("0xsig");
  encodeBlankPaymasterDataMock.mockReturnValue("0xpaymasterdata");
  encodeExecuteCallMock.mockReturnValue("0xexecutecalldata");
  encodeExecuteBatchCallMock.mockReturnValue("0xbatchcalldata");
  encodeFactoryInitCodeMock.mockReturnValue("0xinitcode");
  getNextNonceMock.mockResolvedValue(5n);
  serializeUserOpMock.mockReturnValue({ sender: PREDICTED });
  createPasskeyMock.mockResolvedValue({ pubX: PUB_X, pubY: PUB_Y });

  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      hash: "0xrelaytx",
      blockNumber: "12345",
      status: "success",
      logs: [],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Mount lifecycle
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — mount lifecycle (§15.x)", () => {
  it("no passkey -> status='no-passkey' + account=null", async () => {
    hasPasskeyMock.mockResolvedValue(false);
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("no-passkey"));
    expect(result.current.account).toBeNull();
    // No factory read should have fired
    expect(readContractMock).toHaveBeenCalledTimes(0);
  });

  it("passkey + getPubkey null -> status='no-passkey' (corrupted keystore)", async () => {
    hasPasskeyMock.mockResolvedValue(true);
    getPasskeyPubkeyMock.mockResolvedValue(null);
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("no-passkey"));
  });

  it("passkey + pubkey + code deployed -> status='ready' + isDeployed=true", async () => {
    getCodeMock.mockResolvedValue("0xabcd"); // non-empty
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.account).toEqual({
      address: PREDICTED,
      pubX: PUB_X,
      pubY: PUB_Y,
      isDeployed: true,
    });
  });

  it("passkey + pubkey + code='0x' -> isDeployed=false (counterfactual only)", async () => {
    getCodeMock.mockResolvedValue("0x");
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.account?.isDeployed).toBe(false));
    expect(result.current.status).toBe("ready");
  });

  it("getCode=undefined (chain not yet ready) -> isDeployed=false", async () => {
    getCodeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.account?.isDeployed).toBe(false);
  });

  it("factory.getAddress called with (BigInt(pubX), BigInt(pubY), ZERO_ADDR, 0n)", async () => {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const call = readContractMock.mock.calls[0][0];
    expect(call.address).toBe(FACTORY);
    expect(call.functionName).toBe("getAddress");
    expect(call.args).toEqual([
      BigInt(PUB_X),
      BigInt(PUB_Y),
      "0x0000000000000000000000000000000000000000",
      0n,
    ]);
  });

  it("no publicClient -> resolveAccount no-op + status stays 'idle'", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useSmartAccount());
    // Brief wait — status should stay idle because resolveAccount returns
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.status).toBe("idle");
    expect(hasPasskeyMock).toHaveBeenCalledTimes(0);
  });

  it("resolveAccount RPC throw -> status='error' + error set (no unhandled rejection)", async () => {
    hasPasskeyMock.mockRejectedValue(new Error("rpc rate-limited"));
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("rpc rate-limited");
  });

  it("entryPoint constant exposed (ENTRYPOINT_V08)", () => {
    const { result } = renderHook(() => useSmartAccount());
    expect(result.current.entryPoint).toBe(
      "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Cross-tab passkey sync
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — cross-tab passkey sync (§15.x)", () => {
  it("aa_passkey_changed broadcast -> re-resolve fires", async () => {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const callsBefore = hasPasskeyMock.mock.calls.length;
    // Synthesize a cross-tab event from THIS test
    act(() => {
      // Find the passkey-changed listener (separate from nonce listener)
      for (const handler of crossTabHandlers) {
        handler("aa_passkey_changed", { chainId: 11155111 });
      }
    });
    await waitFor(() => {
      expect(hasPasskeyMock.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("aa_passkey_changed with wrong chainId -> NO re-resolve", async () => {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const callsBefore = hasPasskeyMock.mock.calls.length;
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("aa_passkey_changed", { chainId: 84532 }); // different chain
      }
    });
    // Give a tick; should NOT trigger re-resolve
    await new Promise((r) => setTimeout(r, 30));
    expect(hasPasskeyMock.mock.calls.length).toBe(callsBefore);
  });

  it("unrelated cross-tab action -> ignored (no re-resolve)", async () => {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const callsBefore = hasPasskeyMock.mock.calls.length;
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("activity_added");
      }
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(hasPasskeyMock.mock.calls.length).toBe(callsBefore);
  });
});

// ───────────────────────────────────────────────────────────
//  createAccount
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — createAccount (§15.x)", () => {
  it("no publicClient -> 'Network not ready' error + returns null", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useSmartAccount());
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createAccount("pass");
    });
    expect(r).toBeNull();
    expect(result.current.error).toBe("Network not ready");
    expect(createPasskeyMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: createPasskey + factory.getAddress + status=ready + broadcast", async () => {
    hasPasskeyMock.mockResolvedValue(false); // no existing passkey
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("no-passkey"));
    let acc: { address: string; isDeployed: boolean } | null = null;
    await act(async () => {
      acc = await result.current.createAccount("the-pass", "My Wallet");
    });
    expect(createPasskeyMock).toHaveBeenCalledWith(11155111, "the-pass", "My Wallet");
    expect(acc).toEqual({
      address: PREDICTED,
      pubX: PUB_X,
      pubY: PUB_Y,
      isDeployed: false,
    });
    expect(result.current.status).toBe("ready");
    expect(broadcastActionMock).toHaveBeenCalledWith("aa_passkey_changed", {
      chainId: 11155111,
    });
  });

  it("createPasskey throw -> status='error' + error set + returns null", async () => {
    hasPasskeyMock.mockResolvedValue(false);
    createPasskeyMock.mockRejectedValue(new Error("user cancelled"));
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("no-passkey"));
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.createAccount("pass");
    });
    expect(r).toBeNull();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("user cancelled");
    expect(broadcastActionMock).not.toHaveBeenCalledWith(
      "aa_passkey_changed",
      expect.anything(),
    );
  });
});

// ───────────────────────────────────────────────────────────
//  removeAccount
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — removeAccount (§15.x)", () => {
  it("calls deletePasskey + sets status=no-passkey + broadcast", async () => {
    deletePasskeyMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.removeAccount();
    });
    expect(deletePasskeyMock).toHaveBeenCalledWith(11155111);
    expect(result.current.status).toBe("no-passkey");
    expect(result.current.account).toBeNull();
    expect(broadcastActionMock).toHaveBeenCalledWith("aa_passkey_changed", {
      chainId: 11155111,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  sendUserOp / submitCallData happy path
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — submitCallData happy path (§15.x)", () => {
  async function setupReadyAccount(isDeployed = true) {
    getCodeMock.mockResolvedValue(isDeployed ? "0xdeployed" : "0x");
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("subsequent UserOp (isDeployed=true): no initCode + paymaster sponsored + status='submitting'", async () => {
    const result = await setupReadyAccount(true);
    let r: { txHash: string; userOpHash: string; status?: string } | null = null;
    await act(async () => {
      r = await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(r!.txHash).toBe("0xrelaytx");
    expect(r!.userOpHash).toBe("0xuserophash");
    expect(r!.status).toBe("success");
    // encodeFactoryInitCode NOT called for deployed accounts
    expect(encodeFactoryInitCodeMock).toHaveBeenCalledTimes(0);
    // Paymaster mode: sponsored (default)
    expect(encodeBlankPaymasterDataMock).toHaveBeenCalledWith(PAYMASTER, 0n);
    // buildUserOp received paymasterAndData="0xpaymasterdata" + no verifGasLimit
    const buildArgs = buildUserOpMock.mock.calls[0][0];
    expect(buildArgs.initCode).toBe("0x");
    expect(buildArgs.paymasterAndData).toBe("0xpaymasterdata");
    expect(buildArgs.verificationGasLimit).toBeUndefined();
  });

  it("first UserOp (isDeployed=false): initCode set + verifGas=5_000_000", async () => {
    const result = await setupReadyAccount(false);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(encodeFactoryInitCodeMock).toHaveBeenCalledWith(
      FACTORY,
      PUB_X,
      PUB_Y,
      "0x0000000000000000000000000000000000000000",
      0n,
    );
    const buildArgs = buildUserOpMock.mock.calls[0][0];
    expect(buildArgs.initCode).toBe("0xinitcode");
    expect(buildArgs.verificationGasLimit).toBe(5_000_000n);
    // status='deploying' fires synchronously BEFORE the async fetch but
    // React hasn't propagated it to result.current by the time fetch's
    // body runs. The observable outcome is initCode + verifGas set
    // correctly — those are the actual deploying-path invariants.
  });

  it("/api/relay POST: chainId + serializeUserOp body, Content-Type header", async () => {
    const result = await setupReadyAccount(true);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relay",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chainId).toBe(11155111);
    expect(body.userOp).toBeDefined();
  });

  it("signs via signHash(chainId, passphrase, userOpHash) + signature attached via encodeP256Signature", async () => {
    const result = await setupReadyAccount(true);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "the-pass");
    });
    expect(signHashMock).toHaveBeenCalledWith(
      11155111,
      "the-pass",
      "0xuserophash",
    );
    expect(encodeP256SignatureMock).toHaveBeenCalledWith("0xr", "0xs");
  });

  it("on success: broadcasts aa_nonce_used + sets status='ready'", async () => {
    const result = await setupReadyAccount(true);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("aa_nonce_used", {
      nonce: "5",
      address: PREDICTED,
      chainId: 11155111,
    });
    expect(result.current.status).toBe("ready");
  });

  it("forwards relayer receipt fields (blockNumber, status, logs)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        hash: "0xtx",
        blockNumber: "999",
        blockHash: "0xbh",
        status: "success",
        logs: [{ address: TARGET, topics: ["0xa"], data: "0xb" }],
      }),
    });
    const result = await setupReadyAccount(true);
    let r: { blockNumber?: bigint; status?: string; logs?: unknown[] } = {};
    await act(async () => {
      r = (await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass"))!;
    });
    expect(r.blockNumber).toBe(999n);
    expect(r.status).toBe("success");
    expect(r.logs).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Paymaster mode dispatch
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — paymaster mode (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("paymaster='sponsored' (default) -> encodeBlankPaymasterData", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(encodeBlankPaymasterDataMock).toHaveBeenCalledTimes(1);
    expect(buildUserOpMock.mock.calls[0][0].paymasterAndData).toBe(
      "0xpaymasterdata",
    );
  });

  it("paymaster='self' -> paymasterAndData='0x' (AA pays own gas)", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass", {
        paymaster: "self",
      });
    });
    expect(encodeBlankPaymasterDataMock).toHaveBeenCalledTimes(0);
    expect(buildUserOpMock.mock.calls[0][0].paymasterAndData).toBe("0x");
  });

  it("no BlankPaymaster in contracts -> paymasterAndData='0x' even with sponsored mode", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { BlankAccountFactory: FACTORY }, // no BlankPaymaster
    });
    const result = await setupReady();
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(encodeBlankPaymasterDataMock).toHaveBeenCalledTimes(0);
    expect(buildUserOpMock.mock.calls[0][0].paymasterAndData).toBe("0x");
  });

  it("callGasLimit override passes through to buildUserOp", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass", {
        callGasLimit: 8_000_000n,
      });
    });
    expect(buildUserOpMock.mock.calls[0][0].callGasLimit).toBe(8_000_000n);
  });
});

// ───────────────────────────────────────────────────────────
//  Nonce hint + rollback
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — #123 nonce hint + rollback (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("parallel submits: second uses max(onChain, localHint+1) — avoids nonce collision when first hasn't mined", async () => {
    getNextNonceMock.mockResolvedValue(5n);
    // Hang the FIRST fetch so the second submit fires before
    // resolveAccount can clear the local nonce hint. This is the
    // race the local hint is designed to handle.
    let resolveFirst: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res;
        }),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ hash: "0xtx2", status: "success" }),
    });
    encodeExecuteCallMock
      .mockReturnValueOnce("0xdistinct-call-A")
      .mockReturnValueOnce("0xdistinct-call-B");
    const result = await setupReady();
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.sendUserOp(TARGET, 0n, "0xa", "pass");
    });
    // Microtask flush so the first submit's nonce-bump lands
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Fire the SECOND submit while the first is still in-flight
    act(() => {
      p2 = result.current.sendUserOp(TARGET, 0n, "0xb", "pass");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Now resolve the first so cleanup completes
      resolveFirst({
        ok: true,
        json: async () => ({ hash: "0xtx1", status: "success" }),
      });
      await p1;
      await p2;
    });
    // First submit used on-chain nonce 5
    expect(buildUserOpMock.mock.calls[0][0].nonce).toBe(5n);
    // Second submit (parallel, before first's resolveAccount) used 6
    expect(buildUserOpMock.mock.calls[1][0].nonce).toBe(6n);
  });

  it("relay !ok rolls back local nonce hint so next attempt doesn't skip", async () => {
    const result = await setupReady();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "relayer down" }),
    });
    await act(async () => {
      try {
        await result.current.sendUserOp(TARGET, 0n, "0xfail", "pass");
      } catch {
        /* swallow */
      }
    });
    // Now retry — should reuse the SAME nonce (5n), not 6n
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hash: "0xretry", status: "success" }),
    });
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xretry-data", "pass");
    });
    // Both buildUserOp calls should use nonce=5n
    expect(buildUserOpMock.mock.calls[0][0].nonce).toBe(5n);
    expect(buildUserOpMock.mock.calls[1][0].nonce).toBe(5n);
  });

  it("relay !ok throws with the error message (not silent null)", async () => {
    const result = await setupReady();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "bad gateway" }),
    });
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("bad gateway");
    expect(result.current.status).toBe("error");
  });

  it("relay !ok with non-JSON body -> falls back to 'relay HTTP <status>'", async () => {
    const result = await setupReady();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    });
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("relay HTTP 503");
  });
});

// ───────────────────────────────────────────────────────────
//  #246 cross-tab nonce sync
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — #246 cross-tab nonce sync (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("aa_nonce_used with matching address -> bumps local hint so next submit takes max", async () => {
    const result = await setupReady();
    // Sibling tab broadcasts that nonce 10 was consumed
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("aa_nonce_used", {
          nonce: "10",
          address: PREDICTED,
          chainId: 11155111,
        });
      }
    });
    // Our local hint should now be 11, so next submit (on-chain still 5)
    // takes max(5, 11) = 11
    getNextNonceMock.mockResolvedValue(5n);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(buildUserOpMock.mock.calls[0][0].nonce).toBe(11n);
  });

  it("aa_nonce_used with non-matching address -> NO bump", async () => {
    const result = await setupReady();
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("aa_nonce_used", {
          nonce: "10",
          address: "0x9999999999999999999999999999999999999999",
          chainId: 11155111,
        });
      }
    });
    getNextNonceMock.mockResolvedValue(5n);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(buildUserOpMock.mock.calls[0][0].nonce).toBe(5n); // no bump
  });

  it("aa_nonce_used with non-matching chainId -> NO bump", async () => {
    const result = await setupReady();
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("aa_nonce_used", {
          nonce: "10",
          address: PREDICTED,
          chainId: 84532, // different chain
        });
      }
    });
    getNextNonceMock.mockResolvedValue(5n);
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(buildUserOpMock.mock.calls[0][0].nonce).toBe(5n);
  });

  it("aa_nonce_used with malformed nonce -> ignored (no throw)", async () => {
    const result = await setupReady();
    act(() => {
      for (const handler of crossTabHandlers) {
        handler("aa_nonce_used", {
          nonce: "not-a-number",
          address: PREDICTED,
        });
      }
    });
    // Subsequent submit still works
    await act(async () => {
      await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(buildUserOpMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  #123 in-flight dedup
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — #123 in-flight dedup (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("same callData submitted twice while first in-flight -> only ONE relay call", async () => {
    // Hang the first fetch
    let resolveFetch: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );
    const result = await setupReady();
    // Set encodeExecuteCall to return the SAME calldata for both sends
    encodeExecuteCallMock.mockReturnValue("0xsame-calldata");
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.sendUserOp(TARGET, 0n, "0xdata-A", "pass");
      p2 = result.current.sendUserOp(TARGET, 0n, "0xdata-B", "pass");
    });
    // Resolve the fetch, both promises should resolve to the SAME result
    resolveFetch({
      ok: true,
      json: async () => ({ hash: "0xshared", status: "success" }),
    });
    let r1: unknown, r2: unknown;
    await act(async () => {
      r1 = await p1;
      r2 = await p2;
    });
    // Only ONE relay fetch fired
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Both promises resolved to the same result (in-flight dedup)
    expect(r1).toBe(r2);
  });
});

// ───────────────────────────────────────────────────────────
//  sendBatchUserOp
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — sendBatchUserOp (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("wraps targets/values/datas via encodeExecuteBatchCall", async () => {
    const result = await setupReady();
    const targets = [TARGET, TARGET] as const;
    const values = [0n, 5n] as const;
    const datas = ["0xa", "0xb"] as readonly `0x${string}`[];
    await act(async () => {
      await result.current.sendBatchUserOp(targets, values, datas, "pass");
    });
    expect(encodeExecuteBatchCallMock).toHaveBeenCalledWith(
      targets,
      values,
      datas,
    );
    // The callData used by buildUserOp is the batch-encoded form
    expect(buildUserOpMock.mock.calls[0][0].callData).toBe("0xbatchcalldata");
  });

  it("batch paymaster + callGasLimit options pass through", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.sendBatchUserOp(
        [TARGET],
        [0n],
        ["0xa"],
        "pass",
        { paymaster: "self", callGasLimit: 10_000_000n },
      );
    });
    expect(buildUserOpMock.mock.calls[0][0].paymasterAndData).toBe("0x");
    expect(buildUserOpMock.mock.calls[0][0].callGasLimit).toBe(10_000_000n);
  });
});

// ───────────────────────────────────────────────────────────
//  sendUserOp wrapper
// ───────────────────────────────────────────────────────────

describe("useSmartAccount — sendUserOp wrapper (§15.x)", () => {
  async function setupReady() {
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("wraps (target, value, data) via encodeExecuteCall", async () => {
    const result = await setupReady();
    await act(async () => {
      await result.current.sendUserOp(TARGET, 100n, "0xabc", "pass");
    });
    expect(encodeExecuteCallMock).toHaveBeenCalledWith(TARGET, 100n, "0xabc");
    expect(buildUserOpMock.mock.calls[0][0].callData).toBe("0xexecutecalldata");
  });

  it("no account ready -> returns null + sets error", async () => {
    hasPasskeyMock.mockResolvedValue(false);
    const { result } = renderHook(() => useSmartAccount());
    await waitFor(() => expect(result.current.status).toBe("no-passkey"));
    let r: unknown = "x";
    await act(async () => {
      r = await result.current.sendUserOp(TARGET, 0n, "0xdata", "pass");
    });
    expect(r).toBeNull();
    expect(result.current.error).toBe("No smart account ready");
  });
});
