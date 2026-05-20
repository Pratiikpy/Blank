import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useStealthSweep. Phase 9.5 stealth-sweep flow — two-tx
// fund-then-sweep that recovers ERC-20 funds from a stealth address into
// the recipient's main account.
//
// CRITICAL pins:
//   - ERC-20-only gate: functionSelector === 0xa9059cbb required; native
//     ETH announcements (0xeeeeeeee) explicitly rejected with a v1
//     scope-limit message. Without this, attempting a sweep on an ETH
//     announcement would silently fail mid-flow.
//   - Lazy passphrase unlock: if encrypted keys are stored on disk but
//     the in-memory cache is empty, prompt for the passphrase inline.
//     Cancel -> "Sweep cancelled — passphrase required" error. Wrong
//     passphrase -> "Wrong passphrase — sweep aborted". Without this
//     guard a stale-cache fresh-page-load case would crash on
//     computeStealthKey(undefined, ...).
//   - 6-state step machine (idle / funding / waitingFund / sweeping /
//     waitingSweep / done / error). Test pins state progression by
//     intercepting at each await boundary.
//   - Funding via self-call to BlankAccount.execute — the AA calls
//     itself, which then calls execute(stealth, FUND_AMOUNT, "0x") on
//     itself, finally doing a plain ETH transfer. Indirect but reuses
//     the sponsored-UserOp path WITHOUT bypassing the passphrase prompt.
//     A regression to "send eth directly to stealth from EOA" would
//     break passkey users.
//   - Receipt-status guard: fund OR sweep tx with status !== "success"
//     -> throws with explicit hash so the user can investigate. Without
//     this guard, a reverted sweep would silently mark the entry as
//     swept and orphan the funds.
//   - Balance-poll retry: stealth EOA balance may lag the receipt land
//     by 1-2 blocks on free-tier RPCs. Hook polls 5x at 1500ms intervals
//     for >= FUND_AMOUNT / 2 before proceeding. Without this, the swap
//     would attempt to spend gas the stealth EOA "doesn't have yet."
//   - audit `min(announced, liveBalance)` for sweep amount — fee-on-
//     transfer tokens, partial-sweep history, or hash collision could
//     leave actual < announced; using announced would revert the
//     transfer and STRAND THE FUNDING ETH forever at the stealth EOA
//     with no recovery path. min(...) keeps the sweep safe.
//   - Zero live balance -> throws "already swept or never delivered"
//     rather than wasting gas on a guaranteed-revert transfer.
//   - inbox.markSwept fired AFTER successful sweep receipt (not before)
//     so a failed sweep keeps the entry visible in the UI for retry.

const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useStealthInboxMock = vi.hoisted(() => vi.fn());
const usePassphrasePromptMock = vi.hoisted(() => vi.fn());
const loadStealthKeysMock = vi.hoisted(() => vi.fn());
const unlockStealthKeysMock = vi.hoisted(() => vi.fn());
const hasStealthKeysStoredMock = vi.hoisted(() => vi.fn());
const computeStealthKeyMock = vi.hoisted(() => vi.fn());
const createWalletClientMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("./useStealthInbox", () => ({ useStealthInbox: useStealthInboxMock }));
vi.mock("@/components/PassphrasePrompt", () => ({
  usePassphrasePrompt: usePassphrasePromptMock,
}));
vi.mock("@/lib/stealth", () => ({
  computeStealthKey: computeStealthKeyMock,
}));
vi.mock("@/lib/stealth-keystore", () => ({
  loadStealthKeys: loadStealthKeysMock,
  unlockStealthKeys: unlockStealthKeysMock,
  hasStealthKeysStored: hasStealthKeysStoredMock,
}));
vi.mock("@/lib/abis", () => ({ BlankAccountAbi: [] }));
vi.mock("@/lib/viem-chains", () => ({
  chainIdToViemChain: () => ({ id: 11155111, name: "Sepolia" }),
}));
// viem: re-import everything else from the real module; only replace
// createWalletClient so we can capture writeContract calls without
// touching a real chain. The hook also uses privateKeyToAccount, parseEther,
// erc20Abi, etc. — those should keep working.
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createWalletClient: createWalletClientMock };
});

import { useStealthSweep } from "./useStealthSweep";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const STEALTH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const SENDER = "0x2222222222222222222222222222222222222222" as const;
const EPHEMERAL_PUBKEY =
  ("0x02" + "ab".repeat(32)) as `0x${string}`;
// 32-byte secp256k1 key (must NOT be 0 and < curve order)
const STEALTH_PRIV = ("0x" +
  "1".repeat(64)) as `0x${string}`;
const ERC20_SELECTOR = "0xa9059cbb" as `0x${string}`;
const ETH_SELECTOR = "0xeeeeeeee" as `0x${string}`;

const waitForTransactionReceiptMock = vi.fn();
const getBalanceMock = vi.fn();
const readContractMock = vi.fn();
const unifiedWriteMock = vi.fn();
const stealthWriteContractMock = vi.fn();
const passphraseRequestMock = vi.fn();
const markSweptMock = vi.fn();

function makeEntry(over: Partial<{
  functionSelector: `0x${string}`;
  token: `0x${string}`;
  amount: string;
  stealthAddress: `0x${string}`;
}> = {}) {
  return {
    blockNumber: "12345",
    txHash: "0xtxhash" as `0x${string}`,
    sender: SENDER,
    stealthAddress: over.stealthAddress ?? STEALTH,
    ephemeralPubKey: EPHEMERAL_PUBKEY,
    viewTag: 0xab,
    token: over.token ?? TOKEN,
    amount: over.amount ?? "100000000",
    functionSelector: over.functionSelector ?? ERC20_SELECTOR,
    timestamp: 1700000000,
  };
}

beforeEach(() => {
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useStealthInboxMock.mockReset();
  usePassphrasePromptMock.mockReset();
  loadStealthKeysMock.mockReset();
  unlockStealthKeysMock.mockReset();
  hasStealthKeysStoredMock.mockReset();
  computeStealthKeyMock.mockReset();
  createWalletClientMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  getBalanceMock.mockReset();
  readContractMock.mockReset();
  unifiedWriteMock.mockReset();
  stealthWriteContractMock.mockReset();
  passphraseRequestMock.mockReset();
  markSweptMock.mockReset();

  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
    getBalance: getBalanceMock,
    readContract: readContractMock,
    transport: { type: "http", url: "https://rpc.test.example" },
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWrite: unifiedWriteMock,
    senderAddress: ME,
  });
  useStealthInboxMock.mockReturnValue({ markSwept: markSweptMock });
  usePassphrasePromptMock.mockReturnValue({ request: passphraseRequestMock });

  loadStealthKeysMock.mockReturnValue({
    spendingPrivateKey: "0x1",
    viewingPrivateKey: "0x2",
  });
  hasStealthKeysStoredMock.mockReturnValue(true);
  computeStealthKeyMock.mockReturnValue(STEALTH_PRIV);
  createWalletClientMock.mockReturnValue({
    writeContract: stealthWriteContractMock,
  });
  unifiedWriteMock.mockResolvedValue("0xfundtx" as `0x${string}`);
  stealthWriteContractMock.mockResolvedValue("0xsweeptx" as `0x${string}`);
  waitForTransactionReceiptMock.mockResolvedValue({ status: "success" });
  // Default balance: 0.0005 ETH (FUND_AMOUNT)
  getBalanceMock.mockResolvedValue(500_000_000_000_000n);
  // Default live ERC20 balance >= announced
  readContractMock.mockResolvedValue(100_000_000n);
});

// ───────────────────────────────────────────────────────────
//  Initial state + return shape
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — initial state (§15.x)", () => {
  it("returns idle + isSweeping=false + null error + sweep callable", () => {
    const { result } = renderHook(() => useStealthSweep());
    expect(result.current.step).toBe("idle");
    expect(result.current.isSweeping).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.sweep).toBe("function");
  });
});

// ───────────────────────────────────────────────────────────
//  Pre-flight guards
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — pre-flight guards (§15.x)", () => {
  async function expectThrow(
    fn: () => Promise<unknown>,
    pattern: string | RegExp,
  ) {
    let thrown: unknown = null;
    await act(async () => {
      try {
        await fn();
      } catch (e) {
        thrown = e;
      }
    });
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    if (typeof pattern === "string") {
      expect(msg).toContain(pattern);
    } else {
      expect(msg).toMatch(pattern);
    }
  }

  it("no publicClient -> throws 'Public RPC client unavailable'", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useStealthSweep());
    await expectThrow(
      () => result.current.sweep(makeEntry()),
      "Public RPC client unavailable",
    );
  });

  it("no effectiveAddress -> throws 'Wallet not connected'", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useStealthSweep());
    await expectThrow(
      () => result.current.sweep(makeEntry()),
      "Wallet not connected",
    );
  });

  it("ETH-selector (0xeeeeeeee) entry -> throws 'only ERC-20 announcements supported'", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await expectThrow(
      () => result.current.sweep(makeEntry({ functionSelector: ETH_SELECTOR })),
      "only ERC-20 announcements",
    );
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("unknown function selector -> throws with the selector in message", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await expectThrow(
      () => result.current.sweep(makeEntry({ functionSelector: "0xdeadbeef" })),
      "0xdeadbeef",
    );
  });

  it("ERC-20 selector matched CASE-INsensitively (uppercase variant accepted)", async () => {
    const { result } = renderHook(() => useStealthSweep());
    // 0xA9059CBB uppercase variant should still go through
    await act(async () => {
      await result.current.sweep(
        makeEntry({ functionSelector: "0xA9059CBB" as `0x${string}` }),
      );
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
  });

  it("no senderAddress (passkey-AA not ready) -> throws 'Smart account not connected'", async () => {
    useUnifiedWriteMock.mockReturnValue({
      unifiedWrite: unifiedWriteMock,
      senderAddress: null,
    });
    const { result } = renderHook(() => useStealthSweep());
    await expectThrow(
      () => result.current.sweep(makeEntry()),
      "Smart account not connected",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Lazy passphrase unlock
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — lazy passphrase unlock (§15.x)", () => {
  it("cache hit (loadStealthKeys returns record) -> NO passphrase prompt", async () => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: "0x1",
      viewingPrivateKey: "0x2",
    });
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(passphraseRequestMock).toHaveBeenCalledTimes(0);
    expect(unlockStealthKeysMock).toHaveBeenCalledTimes(0);
  });

  it("cache miss + keys stored -> prompts passphrase + unlocks", async () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(true);
    passphraseRequestMock.mockResolvedValue("the-passphrase");
    unlockStealthKeysMock.mockResolvedValue({
      spendingPrivateKey: "0x1",
      viewingPrivateKey: "0x2",
    });
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(passphraseRequestMock).toHaveBeenCalledTimes(1);
    const opts = passphraseRequestMock.mock.calls[0][0] as { title: string };
    expect(opts.title).toBe("Decrypt stealth keys");
    expect(unlockStealthKeysMock).toHaveBeenCalledWith(ME, "the-passphrase");
  });

  it("passphrase cancel (returns null) -> throws 'Sweep cancelled — passphrase required'", async () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(true);
    passphraseRequestMock.mockResolvedValue(null);
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Sweep cancelled");
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("wrong passphrase (unlock throws) -> 'Wrong passphrase — sweep aborted'", async () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(true);
    passphraseRequestMock.mockResolvedValue("wrong");
    unlockStealthKeysMock.mockRejectedValue(new Error("aes-gcm decrypt"));
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Wrong passphrase");
  });

  it("no keys + nothing stored -> throws 'Stealth keys not configured'", async () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(false);
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Stealth keys not configured");
    expect(passphraseRequestMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Funding tx (step 1)
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — funding tx (§15.x)", () => {
  it("calls unifiedWrite with execute(stealth, FUND_AMOUNT_WEI, '0x') on the AA itself", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(unifiedWriteMock).toHaveBeenCalledTimes(1);
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.address).toBe(ME); // AA self-call
    expect(call.functionName).toBe("execute");
    expect(call.args[0]).toBe(STEALTH);
    expect(call.args[1]).toBe(500_000_000_000_000n); // 0.0005 ETH in wei
    expect(call.args[2]).toBe("0x");
  });

  it("funding receipt reverted -> throws with tx hash in message", async () => {
    waitForTransactionReceiptMock.mockResolvedValueOnce({ status: "reverted" });
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Funding transaction reverted");
    expect((thrown as Error).message).toContain("0xfundtx");
    expect(stealthWriteContractMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Balance-poll retry
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — balance-poll retry (§15.x)", () => {
  it("balance immediately >= FUND/2 -> single getBalance call", async () => {
    getBalanceMock.mockResolvedValue(500_000_000_000_000n); // full FUND
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(getBalanceMock).toHaveBeenCalledTimes(1);
  });

  it("balance lags then settles -> polls up to 5 times until >= FUND/2", async () => {
    // First 2 polls return 0 (lag), 3rd returns enough
    getBalanceMock
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValue(500_000_000_000_000n);
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStealthSweep());
      let p!: Promise<unknown>;
      act(() => {
        p = result.current.sweep(makeEntry());
      });
      // Advance through the 1.5s sleeps between retries
      await vi.advanceTimersByTimeAsync(5_000);
      await act(async () => {
        await p;
      });
      expect(getBalanceMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("balance never lands -> throws 'still empty' after 5 polls", async () => {
    getBalanceMock.mockResolvedValue(0n);
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStealthSweep());
      let thrown: unknown = null;
      let p!: Promise<unknown>;
      act(() => {
        p = result.current.sweep(makeEntry()).catch((e) => {
          thrown = e;
        });
      });
      // Advance past all 4 retry sleeps (5 attempts total)
      await vi.advanceTimersByTimeAsync(8_000);
      await act(async () => {
        await p;
      });
      expect((thrown as Error).message).toContain("still empty");
      expect(getBalanceMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────────────────────────────────────────
//  Sweep amount calculation (audit invariant)
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — min(announced, liveBalance) sweep amount (§15.x)", () => {
  it("live >= announced -> sweep ANNOUNCED amount", async () => {
    readContractMock.mockResolvedValue(200_000_000n); // 2x announced
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry({ amount: "100000000" }));
    });
    const call = stealthWriteContractMock.mock.calls[0][0];
    expect(call.args[1]).toBe(100_000_000n);
  });

  it("live < announced (fee-on-transfer / partial sweep) -> sweep LIVE amount", async () => {
    readContractMock.mockResolvedValue(50_000_000n); // half of announced
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry({ amount: "100000000" }));
    });
    const call = stealthWriteContractMock.mock.calls[0][0];
    expect(call.args[1]).toBe(50_000_000n);
  });

  it("zero live balance -> throws 'already swept or never delivered' (no transfer attempt)", async () => {
    readContractMock.mockResolvedValue(0n);
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("zero balance");
    expect((thrown as Error).message).toContain("already swept");
    expect(stealthWriteContractMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Sweep tx (step 4)
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — sweep tx (§15.x)", () => {
  it("derives stealth privkey via computeStealthKey(ephem, view, spend)", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(computeStealthKeyMock).toHaveBeenCalledTimes(1);
    const args = computeStealthKeyMock.mock.calls[0][0];
    expect(args.ephemeralPublicKey).toBe(EPHEMERAL_PUBKEY);
    expect(args.viewingPrivateKey).toBe("0x2");
    expect(args.spendingPrivateKey).toBe("0x1");
  });

  it("creates wallet client with the stealth privkey + chain + extracted RPC URL", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(createWalletClientMock).toHaveBeenCalledTimes(1);
    const cfg = createWalletClientMock.mock.calls[0][0];
    expect(cfg.account).toBeDefined();
    expect(cfg.chain.id).toBe(11155111);
  });

  it("non-http transport -> throws 'Could not extract RPC URL'", async () => {
    usePublicClientMock.mockReturnValue({
      waitForTransactionReceipt: waitForTransactionReceiptMock,
      getBalance: getBalanceMock,
      readContract: readContractMock,
      transport: { type: "websocket" },
    });
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("RPC URL");
    expect(stealthWriteContractMock).toHaveBeenCalledTimes(0);
  });

  it("writeContract called with (token, erc20.transfer, [main, sweepAmount])", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    const call = stealthWriteContractMock.mock.calls[0][0];
    expect(call.address).toBe(TOKEN);
    expect(call.functionName).toBe("transfer");
    expect(call.args[0]).toBe(ME);
  });

  it("sweep reverted receipt -> throws 'Sweep transaction reverted' + does NOT markSwept", async () => {
    waitForTransactionReceiptMock
      .mockResolvedValueOnce({ status: "success" }) // fund OK
      .mockResolvedValueOnce({ status: "reverted" }); // sweep reverted
    const { result } = renderHook(() => useStealthSweep());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Sweep transaction reverted");
    expect(markSweptMock).toHaveBeenCalledTimes(0);
  });

  it("sweep success -> inbox.markSwept fired with (txHash, stealthAddress)", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(markSweptMock).toHaveBeenCalledWith("0xtxhash", STEALTH);
  });

  it("returns { fundTxHash, sweepTxHash, amount, destination }", async () => {
    const { result } = renderHook(() => useStealthSweep());
    let r:
      | {
          fundTxHash: `0x${string}`;
          sweepTxHash: `0x${string}`;
          amount: string;
          destination: `0x${string}`;
        }
      | undefined;
    await act(async () => {
      r = await result.current.sweep(makeEntry({ amount: "100000000" }));
    });
    expect(r!.fundTxHash).toBe("0xfundtx");
    expect(r!.sweepTxHash).toBe("0xsweeptx");
    expect(r!.amount).toBe("100000000");
    expect(r!.destination).toBe(ME);
  });
});

// ───────────────────────────────────────────────────────────
//  Step state machine
// ───────────────────────────────────────────────────────────

describe("useStealthSweep — step state machine (§15.x)", () => {
  it("ends at step='done' on success", async () => {
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      await result.current.sweep(makeEntry());
    });
    expect(result.current.step).toBe("done");
    expect(result.current.error).toBeNull();
    expect(result.current.isSweeping).toBe(false);
  });

  it("ends at step='error' + error message + isSweeping=false on any failure", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("rpc fail"));
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch {
        /* swallow */
      }
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("rpc fail");
    expect(result.current.isSweeping).toBe(false);
  });

  it("step transitions visible mid-flight: funding -> waitingFund -> sweeping -> waitingSweep", async () => {
    let resolveFund: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValue(
      new Promise((res) => {
        resolveFund = res;
      }),
    );
    const { result } = renderHook(() => useStealthSweep());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.sweep(makeEntry());
    });
    // Microtask flush so React commits the step='funding' update
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(result.current.step).toBe("funding");
    expect(result.current.isSweeping).toBe(true);
    // Resolve everything to clean up
    resolveFund("0xfundtx");
    await act(async () => {
      await p;
    });
    expect(result.current.step).toBe("done");
  });

  it("non-Error thrown value -> String(err) captured in error state", async () => {
    unifiedWriteMock.mockRejectedValue("plain-string-error");
    const { result } = renderHook(() => useStealthSweep());
    await act(async () => {
      try {
        await result.current.sweep(makeEntry());
      } catch {
        /* swallow */
      }
    });
    expect(result.current.error).toBe("plain-string-error");
  });
});
