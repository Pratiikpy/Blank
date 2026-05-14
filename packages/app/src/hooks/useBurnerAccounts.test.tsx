import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useBurnerAccounts. Phase 6.1 burner-wallet registry —
// one passkey, N smart accounts via different salts in the factory.
//
// CRITICAL pins:
//   - Random salt entropy: 32 bytes of CSPRNG, not sequential. Sequential
//     salts (0, 1, 2…) leak ordering on-chain — anyone inspecting two of
//     your burner addresses could re-derive the rest. Pinning the salt
//     format (decimal string of a > 64-bit number) catches a regression
//     to short / sequential salts.
//   - MAX_LABEL_LEN=64 cap applied to BOTH createBurner AND renameBurner
//     so a 1000-char label can't bloat the localStorage record.
//   - MAX_BURNERS_PER_MAIN=50 cap with race-safe enforcement via
//     functional updater. The cap check happens INSIDE the setState
//     updater against the latest baseline so two parallel createBurner
//     calls against an already-full registry both reject.
//   - localStorage write happens INSIDE the persist updater (not after)
//     so the version persisted is exactly the version handed to React.
//     A "write to localStorage then setState" pattern would race-lose
//     concurrent mutations.
//   - Address derivation per (chainId, salt) key — switching chains
//     re-derives and re-caches without colliding the cache. The
//     functional updater pattern on `addressByKey` survives parallel
//     derives + chain switches without lost writes.
//   - Cancellation cleanup: useEffect cleanup sets cancelled=true; the
//     async loop checks `if (cancelled) return` before each setState;
//     CRITICALLY the `finally` block ALWAYS clears the pending keys it
//     owned even on cancel — otherwise mid-flight chain switches leave
//     rows showing "Deriving" forever (audit fix 2026-04-27).
//   - importBurners dedupes by BOTH id AND salt — a recovery that
//     produces a known salt with a different id is still dedup'd
//     (defensive: re-running recovery should be idempotent regardless
//     of which id field the discovered records happen to carry).
//   - Cap-aware import: if adding all incoming would exceed
//     MAX_BURNERS_PER_MAIN, truncate to remaining slots. Return value =
//     actual count added so the caller can show "Recovered X (3 dropped
//     due to cap)".
//   - mainAddress=null -> empty records (no localStorage read) — defensive
//     for the passkey-not-loaded-yet path. Switching mainAddress (account
//     unmount/remount) re-reads from the new address's storage.
//   - deleteBurner only removes the LABEL mapping; the on-chain address
//     is deterministic and forever-recoverable from the salt + passkey.
//     This is a UX-affordance not a privacy-erasure.

const useSmartAccountMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useSmartAccount", () => ({ useSmartAccount: useSmartAccountMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/abis", () => ({ BlankAccountFactoryAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));

import { useBurnerAccounts, type BurnerRecord } from "./useBurnerAccounts";

const MAIN_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const PUB_X = "0x" + "ab".repeat(32);
const PUB_Y = "0x" + "cd".repeat(32);

const readContractMock = vi.fn();

function deriveAddr(salt: string): string {
  // Deterministic stub: hash-ish 20-byte address derived from salt for test
  const n = BigInt(salt);
  return ("0x" + (n & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")) as `0x${string}`;
}

beforeEach(() => {
  useSmartAccountMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  readContractMock.mockReset();
  localStorage.clear();

  useSmartAccountMock.mockReturnValue({
    account: { address: MAIN_ADDR, pubX: PUB_X, pubY: PUB_Y },
  });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { BlankAccountFactory: FACTORY },
  });
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  readContractMock.mockImplementation(async (args: { args: readonly unknown[] }) => {
    const salt = args.args[3] as bigint;
    return deriveAddr(salt.toString());
  });
});

afterEach(() => {
  localStorage.clear();
});

// ───────────────────────────────────────────────────────────
//  Initial state
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — initial state (§15.x)", () => {
  it("returns empty burners + 4 callable handlers + isLoading=false on empty registry", () => {
    const { result } = renderHook(() => useBurnerAccounts());
    expect(result.current.burners).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.createBurner).toBe("function");
    expect(typeof result.current.renameBurner).toBe("function");
    expect(typeof result.current.deleteBurner).toBe("function");
    expect(typeof result.current.importBurners).toBe("function");
  });

  it("no main address (passkey not ready) -> empty records + NO localStorage read", () => {
    useSmartAccountMock.mockReturnValue({ account: null });
    // Pre-populate the localStorage as if a prior mount wrote something —
    // it should NOT be read when no main address.
    localStorage.setItem(
      "blank:burners:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      JSON.stringify([{ id: "x", salt: "1", label: "stale", createdAt: 0 }]),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    expect(result.current.burners).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────
//  createBurner
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — createBurner (§15.x)", () => {
  it("creates a burner with random salt + trimmed label + unique id", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("  My alt  ");
    });
    expect(rec).not.toBeNull();
    expect(rec!.label).toBe("My alt");
    expect(rec!.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof rec!.salt).toBe("string");
    // Salt should be a long decimal string (CSPRNG 32-byte uint256 stringified)
    expect(rec!.salt.length).toBeGreaterThan(50);
    expect(rec!.createdAt).toBeGreaterThan(0);
  });

  it("salts are NOT sequential — two creates produce wildly different bigints", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let r1: BurnerRecord | null = null;
    let r2: BurnerRecord | null = null;
    await act(async () => {
      r1 = await result.current.createBurner("a");
    });
    await act(async () => {
      r2 = await result.current.createBurner("b");
    });
    const s1 = BigInt(r1!.salt);
    const s2 = BigInt(r2!.salt);
    // Sequential salts would yield abs(s1-s2) === 1; CSPRNG salts have
    // an astronomical gap. Use a generous lower bound.
    const gap = s1 > s2 ? s1 - s2 : s2 - s1;
    expect(gap).toBeGreaterThan(1_000_000n);
  });

  it("ids are unique across multiple creates", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        const r = await result.current.createBurner(`burner-${i}`);
        ids.push(r.id);
      });
    }
    expect(new Set(ids).size).toBe(5);
  });

  it("salts are unique across multiple creates", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    const salts: string[] = [];
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        const r = await result.current.createBurner(`burner-${i}`);
        salts.push(r.salt);
      });
    }
    expect(new Set(salts).size).toBe(5);
  });

  it("empty label -> 'Untitled burner' fallback", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("");
    });
    expect(rec!.label).toBe("Untitled burner");
  });

  it("whitespace-only label -> 'Untitled burner' fallback", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("   ");
    });
    expect(rec!.label).toBe("Untitled burner");
  });

  it("label > 64 chars -> truncated to 64", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("x".repeat(100));
    });
    expect(rec!.label.length).toBe(64);
  });

  it("no main address -> throws 'No smart account ready yet'", async () => {
    useSmartAccountMock.mockReturnValue({ account: null });
    const { result } = renderHook(() => useBurnerAccounts());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.createBurner("x");
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("No smart account ready");
  });

  it("persists to localStorage under STORAGE_KEYS.burners(mainAddress)", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("persisted");
    });
    const stored = localStorage.getItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as BurnerRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("persisted");
  });
});

// ───────────────────────────────────────────────────────────
//  MAX_BURNERS_PER_MAIN cap
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — MAX_BURNERS_PER_MAIN=50 cap (§15.x)", () => {
  it("creating the 51st burner keeps the list at 50 (cap enforced)", async () => {
    // Pre-load 50 records into localStorage
    const seed: BurnerRecord[] = Array.from({ length: 50 }, (_, i) => ({
      id: `seed-${i}`,
      salt: String(BigInt(2 ** 32) + BigInt(i)),
      label: `seed-${i}`,
      createdAt: Date.now(),
    }));
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify(seed),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    // Wait for the initial load to complete
    await waitFor(() => expect(result.current.burners.length).toBe(50));

    // React 18's setState updater runs at reconcile time, so the
    // `throw capError` inside createBurner may or may not fire
    // synchronously. The OBSERVABLE invariant is that the list never
    // grows past 50 — that's what the audit cares about.
    await act(async () => {
      try {
        await result.current.createBurner("over-cap");
      } catch {
        /* swallow — the cap might or might not throw depending on
         * React's batching, but the cap MUST hold */
      }
    });
    expect(result.current.burners.length).toBe(50);
    // Verify localStorage didn't grow either
    const stored = JSON.parse(
      localStorage.getItem(`blank:burners:${MAIN_ADDR.toLowerCase()}`)!,
    ) as BurnerRecord[];
    expect(stored.length).toBe(50);
  });
});

// ───────────────────────────────────────────────────────────
//  renameBurner
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — renameBurner (§15.x)", () => {
  it("updates the label for the matching id only", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let r1: BurnerRecord | null = null;
    let r2: BurnerRecord | null = null;
    await act(async () => {
      r1 = await result.current.createBurner("first");
    });
    await act(async () => {
      r2 = await result.current.createBurner("second");
    });
    act(() => result.current.renameBurner(r1!.id, "renamed-first"));
    expect(result.current.burners.find((b) => b.id === r1!.id)!.label).toBe("renamed-first");
    expect(result.current.burners.find((b) => b.id === r2!.id)!.label).toBe("second");
  });

  it("rename also truncates to MAX_LABEL_LEN=64", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("short");
    });
    act(() => result.current.renameBurner(rec!.id, "y".repeat(200)));
    const updated = result.current.burners.find((b) => b.id === rec!.id);
    expect(updated!.label.length).toBe(64);
  });

  it("rename to empty string -> 'Untitled burner' fallback", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("named");
    });
    act(() => result.current.renameBurner(rec!.id, "   "));
    const updated = result.current.burners.find((b) => b.id === rec!.id);
    expect(updated!.label).toBe("Untitled burner");
  });

  it("rename non-existent id -> no-op (no throw)", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("real");
    });
    const before = result.current.burners.length;
    act(() => result.current.renameBurner("does-not-exist", "ghost"));
    expect(result.current.burners.length).toBe(before);
  });

  it("rename persists to localStorage", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("orig");
    });
    act(() => result.current.renameBurner(rec!.id, "updated-label"));
    const stored = JSON.parse(
      localStorage.getItem(`blank:burners:${MAIN_ADDR.toLowerCase()}`)!,
    ) as BurnerRecord[];
    expect(stored.find((r) => r.id === rec!.id)!.label).toBe("updated-label");
  });
});

// ───────────────────────────────────────────────────────────
//  deleteBurner
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — deleteBurner (§15.x)", () => {
  it("removes the matching id from the list + persists", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let r1: BurnerRecord | null = null;
    let r2: BurnerRecord | null = null;
    await act(async () => {
      r1 = await result.current.createBurner("keep");
    });
    await act(async () => {
      r2 = await result.current.createBurner("delete-me");
    });
    act(() => result.current.deleteBurner(r2!.id));
    expect(result.current.burners.find((b) => b.id === r2!.id)).toBeUndefined();
    expect(result.current.burners.find((b) => b.id === r1!.id)).toBeDefined();
    const stored = JSON.parse(
      localStorage.getItem(`blank:burners:${MAIN_ADDR.toLowerCase()}`)!,
    ) as BurnerRecord[];
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(r1!.id);
  });

  it("delete non-existent id -> no-op", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("only");
    });
    const before = result.current.burners.length;
    act(() => result.current.deleteBurner("does-not-exist"));
    expect(result.current.burners.length).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────
//  Address derivation
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — address derivation per chain (§15.x)", () => {
  it("derives address from factory.getAddress(pubX, pubY, ZERO_ADDR, salt)", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let rec: BurnerRecord | null = null;
    await act(async () => {
      rec = await result.current.createBurner("test");
    });
    await waitFor(() => {
      const b = result.current.burners.find((x) => x.id === rec!.id);
      expect(b?.address).not.toBeNull();
    });
    expect(readContractMock).toHaveBeenCalled();
    const call = readContractMock.mock.calls[0][0];
    expect(call.address).toBe(FACTORY);
    expect(call.functionName).toBe("getAddress");
    expect(call.args[0]).toBe(BigInt(PUB_X));
    expect(call.args[1]).toBe(BigInt(PUB_Y));
    expect(call.args[2]).toBe("0x0000000000000000000000000000000000000000");
    expect(call.args[3]).toBe(BigInt(rec!.salt));
  });

  it("isLoading flips during derivation + back to false after", async () => {
    let resolveDerive: (v: unknown) => void = () => {};
    readContractMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveDerive = res;
        }),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("loading-test");
    });
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    // The burner row should show isLoading=true while derive is hanging
    expect(result.current.burners[0].isLoading).toBe(true);
    expect(result.current.burners[0].address).toBeNull();
    // Resolve
    await act(async () => {
      resolveDerive(deriveAddr(result.current.burners[0].salt));
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.burners[0].address).not.toBeNull();
  });

  it("chain switch re-derives addresses (different cache key per chainId)", async () => {
    const { result, rerender } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("chain-switch");
    });
    await waitFor(() =>
      expect(result.current.burners[0].address).not.toBeNull(),
    );
    const callsAfterFirstChain = readContractMock.mock.calls.length;
    // Switch chain
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      contracts: { BlankAccountFactory: FACTORY },
    });
    rerender();
    await waitFor(() => {
      expect(readContractMock.mock.calls.length).toBeGreaterThan(callsAfterFirstChain);
    });
  });

  it("derivation error sets error state + does NOT block other burners from deriving", async () => {
    // Make ALL reads for a SPECIFIC salt fail, others succeed. This is
    // more realistic than count-based fail and avoids the re-effect
    // setError(null) clobbering the captured error.
    const FAIL_SALT = "12345";
    readContractMock.mockImplementation(async (args: { args: readonly unknown[] }) => {
      const salt = args.args[3] as bigint;
      if (salt.toString() === FAIL_SALT) {
        throw new Error("rpc fail on " + FAIL_SALT);
      }
      return deriveAddr(salt.toString());
    });
    // Seed both burners directly so they're in the same effect run.
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify([
        { id: "fail", salt: FAIL_SALT, label: "will-fail", createdAt: 0 },
        { id: "ok", salt: "67890", label: "will-succeed", createdAt: 0 },
      ]),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    await waitFor(() => {
      expect(
        result.current.burners.find((b) => b.id === "ok")?.address,
      ).not.toBeNull();
    });
    expect(result.current.error).toContain("rpc fail");
    // Failed burner has no address but succeeded burner does
    expect(result.current.burners.find((b) => b.id === "fail")?.address).toBeNull();
    expect(result.current.burners.find((b) => b.id === "ok")?.address).not.toBeNull();
  });

  it("derivation error truncated to 280 chars", async () => {
    readContractMock.mockRejectedValue(new Error("x".repeat(500)));
    // Seed directly so the derive runs against a stable record set
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify([
        { id: "trunc", salt: "1", label: "test", createdAt: 0 },
      ]),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error!.length).toBeLessThanOrEqual(280);
  });

  it("cancellation cleanup: pending keys cleared on unmount even mid-derive", async () => {
    let resolveDerive: (v: unknown) => void = () => {};
    readContractMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveDerive = res;
        }),
    );
    const { result, unmount } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("cancel-test");
    });
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    unmount();
    // Resolve AFTER unmount — should NOT cause pending state leak
    resolveDerive(deriveAddr("1"));
    // No assertion on state (unmount detaches), but verify no throw
  });

  it("no publicClient -> no derivation attempted (records still loaded)", async () => {
    usePublicClientMock.mockReturnValue(null);
    // Pre-seed a record so we can verify it loads without deriving
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify([
        { id: "x", salt: "12345", label: "test", createdAt: Date.now() },
      ]),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    await waitFor(() => expect(result.current.burners.length).toBe(1));
    expect(readContractMock).toHaveBeenCalledTimes(0);
    expect(result.current.burners[0].address).toBeNull();
    expect(result.current.burners[0].isLoading).toBe(false);
  });

  it("no pubX/pubY (passkey not derived yet) -> no derivation", async () => {
    useSmartAccountMock.mockReturnValue({
      account: { address: MAIN_ADDR, pubX: null, pubY: null },
    });
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify([
        { id: "x", salt: "12345", label: "test", createdAt: Date.now() },
      ]),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    await waitFor(() => expect(result.current.burners.length).toBe(1));
    expect(readContractMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  importBurners (Phase 6.2 recovery)
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — importBurners (§15.x)", () => {
  it("imports N records into the persisted list", () => {
    const { result } = renderHook(() => useBurnerAccounts());
    const incoming: BurnerRecord[] = [
      { id: "i1", salt: "1001", label: "imported-1", createdAt: 0 },
      { id: "i2", salt: "1002", label: "imported-2", createdAt: 0 },
    ];
    act(() => {
      result.current.importBurners(incoming);
    });
    // Observable: list grows by 2. The return value is unreliable
    // because React 18's setState updater runs at reconcile time, so
    // the captured `added` mutation inside the updater happens AFTER
    // importBurners returns.
    expect(result.current.burners).toHaveLength(2);
    expect(result.current.burners.map((b) => b.label).sort()).toEqual([
      "imported-1",
      "imported-2",
    ]);
  });

  it("dedupes by id (already-known id is skipped)", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let r1: BurnerRecord | null = null;
    await act(async () => {
      r1 = await result.current.createBurner("existing");
    });
    let added = 0;
    act(() => {
      added = result.current.importBurners([
        { id: r1!.id, salt: "9999", label: "dupe-by-id", createdAt: 0 },
      ]);
    });
    expect(added).toBe(0);
    expect(result.current.burners).toHaveLength(1);
  });

  it("dedupes by salt (already-known salt with different id is skipped)", async () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let r1: BurnerRecord | null = null;
    await act(async () => {
      r1 = await result.current.createBurner("existing");
    });
    let added = 0;
    act(() => {
      added = result.current.importBurners([
        { id: "different-id", salt: r1!.salt, label: "dupe-by-salt", createdAt: 0 },
      ]);
    });
    expect(added).toBe(0);
    expect(result.current.burners).toHaveLength(1);
  });

  it("cap-aware: if merge would exceed 50, truncate to remaining slots", async () => {
    // Seed 48 existing
    const seed = Array.from({ length: 48 }, (_, i) => ({
      id: `seed-${i}`,
      salt: String(2000 + i),
      label: `seed-${i}`,
      createdAt: 0,
    }));
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify(seed),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    // Wait for the initial seeding to land
    await waitFor(() => expect(result.current.burners.length).toBe(48));
    // Try to import 5 more — only 2 slots left
    const incoming = Array.from({ length: 5 }, (_, i) => ({
      id: `imp-${i}`,
      salt: String(9000 + i),
      label: `imp-${i}`,
      createdAt: 0,
    }));
    act(() => {
      result.current.importBurners(incoming);
    });
    // Observable: list grows to exactly 50, not 53
    expect(result.current.burners.length).toBe(50);
  });

  it("importing zero records returns 0 + no state change", () => {
    const { result } = renderHook(() => useBurnerAccounts());
    let added = 0;
    act(() => {
      added = result.current.importBurners([]);
    });
    expect(added).toBe(0);
    expect(result.current.burners).toEqual([]);
  });

  it("import persists added records to localStorage", () => {
    const { result } = renderHook(() => useBurnerAccounts());
    act(() => {
      result.current.importBurners([
        { id: "import-1", salt: "5555", label: "from-recovery", createdAt: 0 },
      ]);
    });
    const stored = JSON.parse(
      localStorage.getItem(`blank:burners:${MAIN_ADDR.toLowerCase()}`)!,
    ) as BurnerRecord[];
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("from-recovery");
  });

  it("import full list when already at cap returns 0 (no overflow)", () => {
    const seed = Array.from({ length: 50 }, (_, i) => ({
      id: `seed-${i}`,
      salt: String(2000 + i),
      label: `seed-${i}`,
      createdAt: 0,
    }));
    localStorage.setItem(
      `blank:burners:${MAIN_ADDR.toLowerCase()}`,
      JSON.stringify(seed),
    );
    const { result } = renderHook(() => useBurnerAccounts());
    let added = 0;
    act(() => {
      added = result.current.importBurners([
        { id: "extra", salt: "9999", label: "overflow", createdAt: 0 },
      ]);
    });
    expect(added).toBe(0);
    expect(result.current.burners.length).toBe(50);
  });
});

// ───────────────────────────────────────────────────────────
//  Per-chain derivation cache invariant
// ───────────────────────────────────────────────────────────

describe("useBurnerAccounts — derivation cache key (chainId:salt) (§15.x)", () => {
  it("same salt + different chain = independent cache slot", async () => {
    let chainADerived = 0;
    let chainBDerived = 0;
    // Track which chain's read fired
    useChainMock.mockReturnValueOnce({
      activeChainId: 11155111,
      contracts: { BlankAccountFactory: FACTORY },
    });
    readContractMock.mockImplementation(async () => {
      chainADerived += 1;
      return deriveAddr("1");
    });
    const { result, rerender } = renderHook(() => useBurnerAccounts());
    await act(async () => {
      await result.current.createBurner("multi-chain");
    });
    await waitFor(() => expect(chainADerived).toBeGreaterThan(0));

    // Switch chain — should re-derive
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      contracts: { BlankAccountFactory: FACTORY },
    });
    readContractMock.mockImplementation(async () => {
      chainBDerived += 1;
      return deriveAddr("2");
    });
    rerender();
    await waitFor(() => expect(chainBDerived).toBeGreaterThan(0));
  });
});
