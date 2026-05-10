import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// §15.x test for useLiveActivities. Pin the dual-dedup (tx_hash +
// id) — frontend and indexer may both insert the same tx under
// different ids; without tx_hash dedup users would see the same
// payment twice in their feed. Plus the stable sort tie-breaker
// (#223) which keeps two clients viewing the same stream in agreement
// when created_at ties.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const channelHandlerRef = vi.hoisted(() => ({
  handler: null as null | ((payload: { new: Record<string, unknown> }) => void),
}));

const supabaseSelectChain = vi.hoisted(() => ({
  rows: [] as unknown[],
  setRows(rows: unknown[]) { this.rows = rows; },
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/lib/supabase", () => {
  const fromChain = {
    select: () => fromChain,
    order: () => fromChain,
    limit: () => Promise.resolve({ data: supabaseSelectChain.rows, error: null }),
  };
  const channelObj = {
    on: (_evt: string, _opts: unknown, h: typeof channelHandlerRef.handler) => {
      channelHandlerRef.handler = h;
      return channelObj;
    },
    subscribe: () => channelObj,
  };
  return {
    supabase: {
      from: () => fromChain,
      channel: () => channelObj,
      removeChannel: vi.fn(),
    },
  };
});

vi.mock("@/lib/realtime-dedup", () => {
  const seen = new Set<string>();
  return {
    createActivityDedup: () => ({
      accept: ({ tx_hash }: { tx_hash?: string }) => {
        if (!tx_hash) return true;
        if (seen.has(tx_hash)) return false;
        seen.add(tx_hash);
        return true;
      },
      reset: () => seen.clear(),
    }),
  };
});

import { useLiveActivities } from "./useLiveActivities";

const ME = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  vi.useFakeTimers();
  useEffectiveAddressMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  channelHandlerRef.handler = null;
  supabaseSelectChain.setRows([]);
});

afterEach(() => {
  vi.useRealTimers();
});

function row(id: string, tx: string, when: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tx_hash: tx,
    created_at: when,
    user_from: ME,
    user_to: ME,
    activity_type: "payment",
    note: "",
    ...extra,
  } as Record<string, unknown>;
}

describe("useLiveActivities — initial fetch (§15.x)", () => {
  it("loads initial rows from supabase + flips isLoading=false", async () => {
    supabaseSelectChain.setRows([
      row("a", "0xtx1", "2026-05-10T12:00:00Z"),
      row("b", "0xtx2", "2026-05-10T11:00:00Z"),
    ]);

    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    expect(result.current.activities).toHaveLength(2);
    expect(result.current.supabaseConfigured).toBe(true);
  });

  it("sorts by created_at DESC", async () => {
    supabaseSelectChain.setRows([
      row("older", "0xtx1", "2026-05-10T10:00:00Z"),
      row("newer", "0xtx2", "2026-05-10T12:00:00Z"),
    ]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.activities[0].id).toBe("newer");
    expect(result.current.activities[1].id).toBe("older");
  });

  it("stable secondary sort by tx_hash DESC when created_at ties (#223)", async () => {
    supabaseSelectChain.setRows([
      row("a", "0xaaa", "2026-05-10T12:00:00Z"),
      row("b", "0xbbb", "2026-05-10T12:00:00Z"),
    ]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);
    // tx_hash DESC: "0xbbb" > "0xaaa", so id="b" comes first.
    expect(result.current.activities[0].id).toBe("b");
    expect(result.current.activities[1].id).toBe("a");
  });
});

describe("useLiveActivities — realtime INSERT (§15.x)", () => {
  it("prepends a realtime row + marks isNew=true", async () => {
    supabaseSelectChain.setRows([row("a", "0xtx1", "2026-05-10T10:00:00Z")]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    expect(channelHandlerRef.handler).not.toBeNull();
    act(() => {
      channelHandlerRef.handler!({ new: row("b", "0xtx2", "2026-05-10T12:00:00Z") });
    });

    expect(result.current.activities).toHaveLength(2);
    expect(result.current.activities[0].id).toBe("b");
    expect(result.current.activities[0].isNew).toBe(true);
  });

  it("clears isNew=false after the 1600ms flash window", async () => {
    supabaseSelectChain.setRows([]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    act(() => {
      channelHandlerRef.handler!({ new: row("b", "0xtx2", "2026-05-10T12:00:00Z") });
    });
    expect(result.current.activities[0].isNew).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1700);
    });
    expect(result.current.activities[0].isNew).toBe(false);
  });

  it("dedups by tx_hash — frontend + indexer dual-insert under different ids stays at length 1 (#248)", async () => {
    supabaseSelectChain.setRows([]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    act(() => {
      channelHandlerRef.handler!({ new: row("frontend-id", "0xshared-tx", "2026-05-10T12:00:00Z") });
    });
    act(() => {
      channelHandlerRef.handler!({ new: row("indexer-id", "0xshared-tx", "2026-05-10T12:00:00Z") });
    });

    expect(result.current.activities).toHaveLength(1);
  });

  it("dedups by id — Supabase replay of the same row stays at length 1", async () => {
    supabaseSelectChain.setRows([]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    act(() => {
      channelHandlerRef.handler!({ new: row("dup", "0xtxA", "2026-05-10T12:00:00Z") });
    });
    act(() => {
      channelHandlerRef.handler!({ new: row("dup", "0xtxB", "2026-05-10T12:00:00Z") });
    });

    expect(result.current.activities).toHaveLength(1);
  });

  it("rejects realtime rows with no id (defensive guard)", async () => {
    supabaseSelectChain.setRows([]);
    const { result } = renderHook(() => useLiveActivities(50));
    await flushMicrotasks();
    expect(result.current.isLoading).toBe(false);

    act(() => {
      channelHandlerRef.handler!({ new: { tx_hash: "0x123", created_at: "2026-05-10T12:00:00Z" } });
    });

    expect(result.current.activities).toHaveLength(0);
  });

  it("enforces the row-cap by trimming oldest rows beyond `limit`", async () => {
    supabaseSelectChain.setRows([
      row("a", "0xtxA", "2026-05-10T10:00:00Z"),
      row("b", "0xtxB", "2026-05-10T11:00:00Z"),
    ]);
    const { result } = renderHook(() => useLiveActivities(2));
    await flushMicrotasks();
    expect(result.current.activities).toHaveLength(2);

    act(() => {
      channelHandlerRef.handler!({ new: row("c", "0xtxC", "2026-05-10T12:00:00Z") });
    });

    // Cap=2: newest row 'c' kept, oldest 'a' dropped.
    expect(result.current.activities).toHaveLength(2);
    expect(result.current.activities.find((a) => a.id === "a")).toBeUndefined();
    expect(result.current.activities.find((a) => a.id === "c")).toBeDefined();
  });
});
