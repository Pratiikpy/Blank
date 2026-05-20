import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useShield. The on-ramp + off-ramp hook for the
// encrypted USDC vault. Two flows + a faucet: (1) MINT (TestUSDC /
// TestUSDT faucet with per-token 60s cooldown), (2) SHIELD (USDC ->
// vault deposit; smart-account batch path OR EOA sequential
// approve+shield path), (3) UNSHIELD (vault -> USDC via
// FHE.allowPublic + threshold-decrypt + claim, with tab-close
// persistence + auto-resume).
//
// CRITICAL pins:
//   - Per-token faucet cooldown (USDC = faucetCooldown,
//     USDT = faucetCooldownUsdt) so the two faucets don't block each
//     other; remaining-seconds toast counts down from 60s. Cooldown
//     write happens AFTER on-chain confirm so a reverted mint
//     doesn't burn the cooldown window.
//   - mintTestUSDT short-circuits when contracts.TestUSDT is missing.
//   - shield smart-account path: bundles approve + shield into ONE
//     sendBatchUserOp call ([USDC, Vault], [0n, 0n], [approveData,
//     shieldData]) so the user signs ONE passphrase prompt instead
//     of TWO. The values array MUST be [0n, 0n] not [amountWei, 0n];
//     a regression that passed amountWei as value would burn ETH
//     equal to the USDC amount (ERC20 approve takes amount as arg
//     not msg.value).
//   - shield smart-account passphrase prompt cancel -> setStep('idle')
//     + return null; without the idle reset the UI would stay in
//     'approving' state forever after a cancel.
//   - shield EOA path: 2 sequential unifiedWriteAndWait calls
//     (approve THEN shield); insufficient-balance pre-check fails
//     fast BEFORE the approve fires so the user doesn't pay gas on
//     an approve that the subsequent shield would revert.
//   - shield smart-account note '(via smart wallet)' suffix
//     distinguishes the AA-batched activity row from EOA rows for
//     post-mortem debugging.
//   - #253-like ordering for shield: insertActivity fires AFTER
//     setStep('success') but broadcasts fire on the EOA path BEFORE
//     insertActivity (the EOA path was written before #253 ordering
//     rule was discovered for fanout; activity is single-row here
//     so the cross-tab race window is narrower).
//   - unshield 4-step ladder (encrypting -> requesting -> decrypting
//     -> claiming -> success | error) with persistence to
//     localStorage AFTER the requestUnshield mines so a tab-close
//     during the threshold-decrypt poll resumes on next mount.
//   - _attemptClaim 60s decrypt poll budget (5s intervals); claim
//     error breaks the loop (don't retry on-chain calls, only retry
//     the decrypt because the on-chain side already mined the
//     request).
//   - removeStored on claim SUCCESS only; failed claim leaves the
//     persisted record so retryUnshieldClaim has something to work
//     with on next page load.
//   - hasPendingUnshield derived from pendingCtHash !== 0n; the 0n
//     sentinel means "no pending" (vault contract uses 0 as the
//     unset value).
//   - Auto-resume useEffect: fires on mount when address +
//     hasPendingUnshield, ONLY when unshieldStep === 'idle' (don't
//     restart a mid-flight unshield). No-op when no local hint
//     ("pending on-chain but localStorage missing" — leave for
//     explicit retry).

const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const usePassphrasePromptMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForTxMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const getStoredJsonMock = vi.hoisted(() => vi.fn());
const setStoredJsonMock = vi.hoisted(() => vi.fn());
const getStoredStringMock = vi.hoisted(() => vi.fn());
const setStoredStringMock = vi.hoisted(() => vi.fn());
const removeStoredMock = vi.hoisted(() => vi.fn());
const encodeFunctionDataMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastFnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useReadContract: useReadContractMock,
  usePublicClient: usePublicClientMock,
  // useAccount mock added when useShield gained the passkey-only
  // -still-loading guard. Returns undefined address — matches the
  // 'no MetaMask connected' shape the existing tests assume.
  useAccount: () => ({ address: undefined }),
}));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/components/PassphrasePrompt", () => ({
  usePassphrasePrompt: usePassphrasePromptMock,
}));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheDecryptForTx: useCofheDecryptForTxMock,
}));
vi.mock("@/lib/abis", () => ({ TestUSDCAbi: [], FHERC20VaultAbi: [] }));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn() } }));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    faucetCooldown: (addr: string, c: number) => `faucet_usdc_${addr}_${c}`,
    faucetCooldownUsdt: (addr: string, c: number) => `faucet_usdt_${addr}_${c}`,
    pendingUnshield: (addr: string, c: number) => `pending_unshield_${addr}_${c}`,
  },
  getStoredJson: getStoredJsonMock,
  setStoredJson: setStoredJsonMock,
  getStoredString: getStoredStringMock,
  setStoredString: setStoredStringMock,
  removeStored: removeStoredMock,
}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, encodeFunctionData: encodeFunctionDataMock };
});
vi.mock("react-hot-toast", () => ({
  default: Object.assign(toastFnMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
  }),
}));

import { useShield } from "./useShield";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const AA_ADDR = "0xddddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const USDC = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const USDT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const VAULT = "0x3333333333333333333333333333333333333333" as `0x${string}`;

const unifiedWriteMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const sendBatchUserOpMock = vi.fn();
const passphraseRequestMock = vi.fn();
const decryptForTxMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();
const getTransactionReceiptMock = vi.fn();
const refetchBalanceMock = vi.fn();
const refetchVaultMock = vi.fn();
const refetchPendingMock = vi.fn();

// Helper: configure useReadContract mock to return specific data per call.
// useShield calls it THREE times: publicBalance, vaultBalance, pendingCtHash.
function setupReads(opts: {
  publicBalance?: bigint;
  vaultBalance?: bigint;
  pendingCtHash?: bigint;
}) {
  useReadContractMock.mockImplementation((cfg: { functionName: string }) => {
    if (cfg.functionName === "balanceOf") {
      return { data: opts.publicBalance ?? 0n, refetch: refetchBalanceMock };
    }
    if (cfg.functionName === "totalDeposited") {
      return { data: opts.vaultBalance ?? 0n, refetch: refetchVaultMock };
    }
    if (cfg.functionName === "pendingUnshield") {
      return { data: opts.pendingCtHash ?? 0n, refetch: refetchPendingMock };
    }
    return { data: undefined, refetch: vi.fn() };
  });
}

beforeEach(() => {
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useReadContractMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useEffectiveAddressMock.mockReset();
  usePassphrasePromptMock.mockReset();
  useCofheDecryptForTxMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  getStoredJsonMock.mockReset();
  setStoredJsonMock.mockReset();
  getStoredStringMock.mockReset();
  setStoredStringMock.mockReset();
  removeStoredMock.mockReset();
  encodeFunctionDataMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastFnMock.mockReset();
  unifiedWriteMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  sendBatchUserOpMock.mockReset();
  passphraseRequestMock.mockReset();
  decryptForTxMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  getTransactionReceiptMock.mockReset();
  refetchBalanceMock.mockReset();
  refetchVaultMock.mockReset();
  refetchPendingMock.mockReset();

  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      TestUSDC: USDC,
      TestUSDT: USDT,
      FHERC20Vault_USDC: VAULT,
    },
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    getTransactionReceipt: getTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  useEffectiveAddressMock.mockReturnValue({
    effectiveAddress: ME,
    smartAccount: { status: "no-passkey", account: null },
  });
  usePassphrasePromptMock.mockReturnValue({ request: passphraseRequestMock });
  useCofheDecryptForTxMock.mockReturnValue({ decryptForTx: decryptForTxMock });
  setupReads({ publicBalance: 10_000_000_000n, vaultBalance: 5_000_000_000n });
  getStoredStringMock.mockReturnValue("0"); // No prior faucet timestamp
  getStoredJsonMock.mockReturnValue(null); // No pending unshield record
  unifiedWriteMock.mockResolvedValue("0xfaucet" as `0x${string}`);
  unifiedWriteAndWaitMock.mockResolvedValue({
    hash: "0xtxhash" as `0x${string}`,
    receipt: { status: "success", blockNumber: 5n, logs: [] },
  });
  sendBatchUserOpMock.mockResolvedValue({
    txHash: "0xbatch" as `0x${string}`,
    blockNumber: 5n,
  });
  passphraseRequestMock.mockResolvedValue("passphrase");
  waitForTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
    logs: [],
  });
  getTransactionReceiptMock.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
    logs: [],
  });
  refetchBalanceMock.mockResolvedValue({ data: 0n });
  refetchVaultMock.mockResolvedValue({ data: 0n });
  refetchPendingMock.mockResolvedValue({ data: 0n });
  encodeFunctionDataMock.mockImplementation(({ functionName }: { functionName: string }) =>
    `0x${functionName}data` as `0x${string}`,
  );
  decryptForTxMock.mockResolvedValue({
    decryptedValue: 5_000_000n,
    signature: ("0x" + "01".repeat(65)) as `0x${string}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Initial state + balance formatting
// ───────────────────────────────────────────────────────────

describe("useShield — initial state (§15.x)", () => {
  it("returns step='idle' + 7 callables + balance fields formatted via formatUnits(_, 6)", () => {
    setupReads({ publicBalance: 5_000_000n, vaultBalance: 12_500_000n });
    const { result } = renderHook(() => useShield());
    expect(result.current.step).toBe("idle");
    expect(result.current.txHash).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isMinting).toBe(false);
    expect(result.current.isMintingUsdt).toBe(false);
    expect(result.current.publicBalance).toBe(5); // 5_000_000 / 1e6
    expect(result.current.vaultBalance).toBe(12.5);
    expect(result.current.hasPendingUnshield).toBe(false);
    expect(result.current.unshieldStep).toBe("idle");
    expect(typeof result.current.shield).toBe("function");
    expect(typeof result.current.mintTestTokens).toBe("function");
    expect(typeof result.current.mintTestUSDT).toBe("function");
    expect(typeof result.current.unshield).toBe("function");
    expect(typeof result.current.retryUnshieldClaim).toBe("function");
    expect(typeof result.current.reset).toBe("function");
    expect(typeof result.current.refetchBalance).toBe("function");
  });

  it("publicBalance=0 when read undefined (loading)", () => {
    setupReads({ publicBalance: undefined, vaultBalance: undefined });
    const { result } = renderHook(() => useShield());
    expect(result.current.publicBalance).toBe(0);
    expect(result.current.vaultBalance).toBe(0);
  });

  it("hasPendingUnshield=true when pendingCtHash != 0n", () => {
    setupReads({ pendingCtHash: 0x42n });
    const { result } = renderHook(() => useShield());
    expect(result.current.hasPendingUnshield).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  mintTestTokens (USDC faucet)
// ───────────────────────────────────────────────────────────

describe("useShield — mintTestTokens / USDC faucet (§15.x)", () => {
  it("no address -> returns null", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      smartAccount: { status: "no-passkey", account: null },
    });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.mintTestTokens();
    });
    expect(r).toBeNull();
  });

  it("cooldown active (<60s) -> error toast with remaining seconds + null", async () => {
    getStoredStringMock.mockImplementation((key: string) =>
      key.includes("usdc") ? String(Date.now() - 30_000) : "0",
    );
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.mintTestTokens();
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/Please wait \d+s before using faucet again/),
    );
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("cooldown expired -> faucet() called + cooldown timestamp set + activity row", async () => {
    getStoredStringMock.mockReturnValue(String(Date.now() - 70_000)); // expired
    const { result } = renderHook(() => useShield());
    let h: unknown;
    await act(async () => {
      h = await result.current.mintTestTokens();
    });
    expect(h).toBe("0xfaucet");
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].functionName).toBe("faucet");
    expect(unifiedWriteMock.mock.calls[0][0].address).toBe(USDC);
    expect(unifiedWriteMock.mock.calls[0][0].gas).toBe(5_000_000n);
    expect(setStoredStringMock).toHaveBeenCalled();
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("mint");
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.user_to).toBe(ME.toLowerCase());
    expect(row.contract_address).toBe(USDC);
    expect(toastSuccessMock).toHaveBeenCalledWith("10,000 USDC minted!");
  });

  it("faucet throws -> error toast + null + no cooldown write", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("faucet revert"));
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.mintTestTokens();
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("faucet revert");
    expect(setStoredStringMock).toHaveBeenCalledTimes(0);
  });

  it("isMinting flips true mid-flight + back to false after", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const { result } = renderHook(() => useShield());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.mintTestTokens();
      await Promise.resolve();
    });
    expect(result.current.isMinting).toBe(true);
    resolveFn("0xhash");
    await act(async () => {
      await p;
    });
    expect(result.current.isMinting).toBe(false);
  });

  it("concurrent mintTestTokens calls short-circuit via isMinting guard", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const { result } = renderHook(() => useShield());
    let p1!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.mintTestTokens();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.mintTestTokens();
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    resolveFn("0x");
    await act(async () => {
      await p1;
    });
  });
});

// ───────────────────────────────────────────────────────────
//  mintTestUSDT (USDT faucet, config-gated)
// ───────────────────────────────────────────────────────────

describe("useShield — mintTestUSDT (§15.x)", () => {
  it("no TestUSDT contract -> unavailable toast + null", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: {
        TestUSDC: USDC,
        FHERC20Vault_USDC: VAULT,
        // No TestUSDT
      },
    });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.mintTestUSDT();
    });
    expect(r).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "USDT faucet is not available on this chain",
    );
  });

  it("uses separate cooldown key (USDT cooldown doesn't block USDC)", async () => {
    getStoredStringMock.mockImplementation((key: string) =>
      key.includes("usdt") ? String(Date.now() - 30_000) : "0",
    );
    const { result } = renderHook(() => useShield());
    // USDT call: cooldown active -> blocked
    let r1: unknown;
    await act(async () => {
      r1 = await result.current.mintTestUSDT();
    });
    expect(r1).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("USDT faucet again"),
    );
    // USDC call: cooldown expired -> allowed
    await act(async () => {
      await result.current.mintTestTokens();
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    expect(unifiedWriteMock.mock.calls[0][0].address).toBe(USDC);
  });

  it("happy path: faucet on USDT address + activity row + USDT-specific success toast", async () => {
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.mintTestUSDT();
    });
    expect(unifiedWriteMock.mock.calls[0][0].address).toBe(USDT);
    expect(toastSuccessMock).toHaveBeenCalledWith("10,000 USDT minted!");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.contract_address).toBe(USDT);
    expect(row.token_address).toBe(USDT);
  });

  it("isMintingUsdt flips true mid-flight + back to false after", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    const { result } = renderHook(() => useShield());
    let p!: Promise<unknown>;
    await act(async () => {
      p = result.current.mintTestUSDT();
      await Promise.resolve();
    });
    expect(result.current.isMintingUsdt).toBe(true);
    resolveFn("0x");
    await act(async () => {
      await p;
    });
    expect(result.current.isMintingUsdt).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  shield — EOA path
// ───────────────────────────────────────────────────────────

// CRITICAL: regression pin for the passkey-only-still-loading bug
// found by running the wave4 e2e end-to-end. Before this fix, a
// passkey-only user clicking Deposit while smartAccount.status was
// still "loading" got ZERO visible feedback — the function fell
// through to the EOA path which returned null silently (no toast,
// no error, no spinner state change). User clicks → nothing happens.
//
// After fix: explicit toast + null return when isPasskeyOnly &&
// status !== "ready". Verified against the same useShield/
// useUnifiedWrite shape that affects every contract-write hook.
describe("useShield — passkey-only-still-loading guard (e2e fix)", () => {
  it("passkey-only user + smartAccount loading -> 'Wallet still loading' toast + null", async () => {
    // Test fixture: address resolved (effectiveAddress), but status
    // is still 'loading'. useEffectiveAddress mock returns the AA
    // address as effectiveAddress regardless of status, so we mock
    // it directly here.
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
      smartAccount: {
        status: "loading",
        account: null,
        sendBatchUserOp: vi.fn(),
        sendUserOp: vi.fn(),
      },
      eoa: undefined,
      isSmartAccount: false,
    });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.shield("10");
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Wallet still loading. Try again in a moment.",
    );
    expect(r).toBeNull();
    // Critical: no contract write attempted (no silent fallthrough).
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });
});

describe("useShield — shield EOA path (§15.x)", () => {
  it("empty amount -> 'Enter an amount' toast + null", async () => {
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.shield("");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
    expect(r).toBeNull();
  });

  it("whitespace-only amount -> 'Enter an amount' toast", async () => {
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("   ");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount");
  });

  it("insufficient USDC balance -> 'Insufficient USDC balance' toast + step='idle' + null", async () => {
    setupReads({ publicBalance: 1_000_000n }); // 1 USDC
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.shield("100"); // wants 100 USDC
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Insufficient USDC balance");
    expect(result.current.step).toBe("idle");
    expect(r).toBeNull();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: TWO writes (approve THEN shield) + activity row + broadcasts", async () => {
    setupReads({ publicBalance: 1_000_000_000n }); // 1000 USDC
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(2);
    const call1 = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call1.functionName).toBe("approve");
    expect(call1.address).toBe(USDC);
    expect(call1.args[0]).toBe(VAULT);
    expect(call1.args[1]).toBe(100_000_000n);
    expect(call1.gas).toBe(5_000_000n);
    const call2 = unifiedWriteAndWaitMock.mock.calls[1][0];
    expect(call2.functionName).toBe("shield");
    expect(call2.address).toBe(VAULT);
    expect(call2.args).toEqual([100_000_000n]);
    expect(call2.gas).toBe(5_000_000n);
    expect(result.current.step).toBe("success");
    expect(toastSuccessMock).toHaveBeenCalledWith("Shielded 100 USDC!");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.activity_type).toBe("shield");
    expect(row.note).toBe("Shielded 100 USDC");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("approve reverted -> step='error' + no shield call + error preserved", async () => {
    setupReads({ publicBalance: 1_000_000_000n });
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("approve revert"));
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("approve revert");
    expect(unifiedWriteAndWaitMock).toHaveBeenCalledTimes(1); // only approve, shield not fired
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  shield — smart-account path
// ───────────────────────────────────────────────────────────

describe("useShield — shield smart-account batch path (§15.x)", () => {
  beforeEach(() => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: AA_ADDR,
      smartAccount: {
        status: "ready",
        account: { address: AA_ADDR },
        sendBatchUserOp: sendBatchUserOpMock,
      },
    });
  });

  it("passphrase prompt fires with shield-specific title + subtitle", async () => {
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    const prompt = passphraseRequestMock.mock.calls[0][0];
    expect(prompt.title).toBe("Sign shield transaction");
    expect(prompt.subtitle).toContain("100 USDC");
  });

  it("passphrase cancel -> step='idle' + null + no batch call", async () => {
    passphraseRequestMock.mockResolvedValue(null);
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.shield("100");
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("idle");
    expect(sendBatchUserOpMock).toHaveBeenCalledTimes(0);
  });

  it("sendBatchUserOp args: ([USDC, Vault], [0n, 0n], [approveData, shieldData], passphrase)", async () => {
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    expect(sendBatchUserOpMock).toHaveBeenCalledTimes(1);
    const [targets, values, datas, passphrase] = sendBatchUserOpMock.mock.calls[0];
    expect(targets).toEqual([USDC, VAULT]);
    expect(values).toEqual([0n, 0n]); // CRITICAL: not [amountWei, 0n]
    expect(Array.isArray(datas)).toBe(true);
    expect(datas).toHaveLength(2);
    expect(passphrase).toBe("passphrase");
    // encodeFunctionData called for both: approve + shield
    const approveCall = encodeFunctionDataMock.mock.calls.find(
      (c) => (c[0] as { functionName: string }).functionName === "approve",
    );
    const shieldCall = encodeFunctionDataMock.mock.calls.find(
      (c) => (c[0] as { functionName: string }).functionName === "shield",
    );
    expect(approveCall?.[0]).toMatchObject({
      functionName: "approve",
      args: [VAULT, 100_000_000n],
    });
    expect(shieldCall?.[0]).toMatchObject({
      functionName: "shield",
      args: [100_000_000n],
    });
  });

  it("happy path: txHash set + step='success' + 'via smart wallet' activity note", async () => {
    const { result } = renderHook(() => useShield());
    let h: unknown;
    await act(async () => {
      h = await result.current.shield("100");
    });
    expect(h).toBe("0xbatch");
    expect(result.current.step).toBe("success");
    expect(result.current.txHash).toBe("0xbatch");
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.note).toBe("Shielded 100 USDC (via smart wallet)");
    expect(row.user_from).toBe(AA_ADDR.toLowerCase());
    expect(row.user_to).toBe(AA_ADDR.toLowerCase());
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Shielded 100 USDC via smart wallet!",
    );
  });

  it("sendBatchUserOp returns null -> step='error' + null", async () => {
    sendBatchUserOpMock.mockResolvedValue(null);
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.shield("100");
    });
    expect(r).toBeNull();
    expect(result.current.step).toBe("error");
  });

  it("sendBatchUserOp throw -> step='error' + error preserved", async () => {
    sendBatchUserOpMock.mockRejectedValue(new Error("batch fail"));
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("batch fail");
  });
});

// ───────────────────────────────────────────────────────────
//  unshield (request -> decrypt -> claim)
// ───────────────────────────────────────────────────────────

describe("useShield — unshield (§15.x)", () => {
  const encryptInputsAsyncStub = vi.fn();
  const EncryptableStub = {
    uint64: (v: bigint) => ({ raw: v }),
  };

  beforeEach(() => {
    encryptInputsAsyncStub.mockReset();
    encryptInputsAsyncStub.mockResolvedValue([
      {
        ctHash: 0x42n,
        securityZone: 0,
        utype: 5,
        signature: "0xenc",
      },
    ]);
    // Use unifiedWrite for requestUnshield + claimUnshield (not the AndWait variant)
    unifiedWriteMock.mockResolvedValue("0xrequest" as `0x${string}`);
  });

  it("no address -> false", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      smartAccount: { status: "no-passkey", account: null },
    });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.unshield("10", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(r).toBe(false);
  });

  it("empty amount -> 'Enter an amount to unshield' + false", async () => {
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.unshield("", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter an amount to unshield");
    expect(r).toBe(false);
  });

  it("4-step ladder: encrypting -> requesting -> decrypting -> claiming -> success", async () => {
    // ctHash refetch returns non-zero after request mines
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(result.current.unshieldStep).toBe("success");
  });

  it("requestUnshield args: [encAmount{ctHash, securityZone, utype, signature}] + gas 5M", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    const reqCall = unifiedWriteMock.mock.calls.find(
      (c) => c[0].functionName === "requestUnshield",
    );
    expect(reqCall).toBeDefined();
    expect(reqCall![0].address).toBe(VAULT);
    expect(reqCall![0].args[0]).toMatchObject({
      ctHash: 0x42n,
      securityZone: 0,
      utype: 5,
      signature: "0xenc",
    });
    expect(reqCall![0].gas).toBe(5_000_000n);
  });

  it("encryption batch input: Encryptable.uint64(parseUnits(amount, 6))", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    const batch = encryptInputsAsyncStub.mock.calls[0][0] as Array<{ raw: bigint }>;
    expect(batch[0].raw).toBe(5_000_000n); // 5 USDC at 6dp
  });

  it("persists pending unshield to localStorage with {requestedAt, txHash, amount}", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(setStoredJsonMock).toHaveBeenCalled();
    const stored = setStoredJsonMock.mock.calls[0][1] as { txHash: string; amount: string };
    expect(stored.txHash).toBe("0xrequest");
    expect(stored.amount).toBe("5");
  });

  it("ctHash still 0n after refetch -> 'handle missing' error + false", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0n });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(r).toBe(false);
    expect(result.current.unshieldStep).toBe("error");
    expect(result.current.unshieldError).toContain("handle missing");
  });

  it("claim success: removeStored + UNSHIELD activity + broadcasts + invalidate", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    unifiedWriteMock.mockImplementation(async (cfg: { functionName: string }) => {
      if (cfg.functionName === "requestUnshield") return "0xrequest";
      if (cfg.functionName === "claimUnshield") return "0xclaim";
      return "0xhash";
    });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(removeStoredMock).toHaveBeenCalled();
    const unshieldRow = insertActivityMock.mock.calls.find(
      (c) => c[0].activity_type === "unshield",
    );
    expect(unshieldRow).toBeDefined();
    expect(unshieldRow![0].note).toBe("Unshielded 5 USDC");
    expect(unshieldRow![0].tx_hash).toBe("0xclaim");
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
    expect(invalidateBalanceQueriesMock).toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("Unshielded 5 USDC!");
  });

  it("claim throws -> step='error' + does NOT removeStored (preserves for retry)", async () => {
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    unifiedWriteMock.mockImplementation(async (cfg: { functionName: string }) => {
      if (cfg.functionName === "requestUnshield") return "0xrequest";
      if (cfg.functionName === "claimUnshield") throw new Error("claim revert");
      return "0xhash";
    });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    expect(result.current.unshieldStep).toBe("error");
    expect(result.current.unshieldError).toBe("claim revert");
    expect(removeStoredMock).toHaveBeenCalledTimes(0);
  });

  it("decrypt timeout (60s budget) -> step='error' + 'Decryption timed out' error", async () => {
    vi.useFakeTimers();
    refetchPendingMock.mockResolvedValue({ data: 0x42n });
    decryptForTxMock.mockResolvedValue(null);
    const { result } = renderHook(() => useShield());
    let p!: Promise<boolean>;
    act(() => {
      p = result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    await vi.advanceTimersByTimeAsync(70_000);
    let r: unknown;
    await act(async () => {
      r = await p;
    });
    expect(r).toBe(false);
    expect(result.current.unshieldStep).toBe("error");
    expect(result.current.unshieldError).toContain("Decryption timed out");
  });

  it("encryption shape normalization: nested `data` envelope unwrapped", async () => {
    encryptInputsAsyncStub.mockResolvedValue([
      {
        data: {
          ctHash: 0x99n,
          securityZone: 1,
          utype: 5,
          signature: "0xnested",
        },
      },
    ]);
    refetchPendingMock.mockResolvedValue({ data: 0x99n });
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.unshield("5", encryptInputsAsyncStub, EncryptableStub);
    });
    const reqCall = unifiedWriteMock.mock.calls.find(
      (c) => c[0].functionName === "requestUnshield",
    );
    expect(reqCall![0].args[0]).toMatchObject({
      ctHash: 0x99n,
      securityZone: 1,
      signature: "0xnested",
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Auto-resume + retryUnshieldClaim
// ───────────────────────────────────────────────────────────

describe("useShield — auto-resume + retryUnshieldClaim (§15.x)", () => {
  it("auto-resume: mount with hasPendingUnshield + localStorage hint -> kicks _attemptClaim", async () => {
    setupReads({ pendingCtHash: 0x42n });
    getStoredJsonMock.mockReturnValue({ amount: "7", txHash: "0xreq" });
    unifiedWriteMock.mockResolvedValue("0xclaim" as `0x${string}`);
    const { result } = renderHook(() => useShield());
    // Effect fires async; wait for the decrypt poll to start
    await waitFor(() => {
      expect(decryptForTxMock).toHaveBeenCalled();
    });
    // claim follows
    await waitFor(() => {
      expect(result.current.unshieldStep).toBe("success");
    });
  });

  it("auto-resume skipped when no localStorage hint (pending on-chain but no local data)", async () => {
    setupReads({ pendingCtHash: 0x42n });
    getStoredJsonMock.mockReturnValue(null);
    renderHook(() => useShield());
    // Give the effect a tick to fire (or not)
    await new Promise((r) => setTimeout(r, 50));
    expect(decryptForTxMock).toHaveBeenCalledTimes(0);
  });

  it("auto-resume skipped when no pending unshield", async () => {
    setupReads({ pendingCtHash: 0n });
    getStoredJsonMock.mockReturnValue({ amount: "7" });
    renderHook(() => useShield());
    await new Promise((r) => setTimeout(r, 50));
    expect(decryptForTxMock).toHaveBeenCalledTimes(0);
  });

  it("retryUnshieldClaim: no pending -> returns false without firing decrypt", async () => {
    setupReads({ pendingCtHash: 0n });
    const { result } = renderHook(() => useShield());
    let r: unknown;
    await act(async () => {
      r = await result.current.retryUnshieldClaim();
    });
    expect(r).toBe(false);
    expect(decryptForTxMock).toHaveBeenCalledTimes(0);
  });

  it("retryUnshieldClaim: pending + localStorage hint -> drives _attemptClaim to success", async () => {
    setupReads({ pendingCtHash: 0x42n });
    getStoredJsonMock.mockReturnValue({ amount: "3" });
    unifiedWriteMock.mockResolvedValue("0xclaim" as `0x${string}`);
    const { result } = renderHook(() => useShield());
    // Wait for any auto-resume effect to settle, then call retry
    await waitFor(() => {
      expect(result.current.unshieldStep).toBe("success");
    });
    // retryUnshieldClaim should still work even after auto-resume completes
    let r: unknown;
    await act(async () => {
      r = await result.current.retryUnshieldClaim();
    });
    expect(r).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  reset
// ───────────────────────────────────────────────────────────

describe("useShield — reset (§15.x)", () => {
  it("reset clears shield + unshield state", async () => {
    setupReads({ publicBalance: 1_000_000_000n });
    unifiedWriteAndWaitMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useShield());
    await act(async () => {
      await result.current.shield("100");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("boom");
    act(() => result.current.reset());
    expect(result.current.step).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
    expect(result.current.unshieldStep).toBe("idle");
    expect(result.current.unshieldError).toBeNull();
  });
});
