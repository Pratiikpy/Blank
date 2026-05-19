import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useActivityFeed. Pins the cache-hydration → server-
// fetch flow, the 100ms insert-buffer debounce (#251 coalesces batch
// events into one setActivities), the dual-channel-per-address
// pattern (#88 fix: sender's own feed updates in realtime), the
// cross-tab sync, and addLocalActivity optimistic UI.

const fetchActivitiesMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const acceptTxMock = vi.hoisted(() => vi.fn());
const onCrossTabActionMock = vi.hoisted(() => vi.fn());

const channelHandlers = vi.hoisted(() => ({
  byChannelName: new Map<string, (payload: { new: Record<string, unknown> }) => void>(),
}));

const supabaseChannelMock = vi.hoisted(() => vi.fn());
const supabaseRemoveChannelMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: supabaseChannelMock,
    removeChannel: supabaseRemoveChannelMock,
  },
  fetchActivities: fetchActivitiesMock,
}));

vi.mock("@/lib/cross-tab", () => ({
  onCrossTabAction: onCrossTabActionMock,
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("./useActivityDedup", () => ({
  useActivityDedup: () => ({ accept: acceptTxMock }),
}));

import { useActivityFeed } from "./useActivityFeed";
import { STORAGE_KEYS } from "@/lib/storage";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALICE = "0xcccccccccccccccccccccccccccccccccccccccc";
const CHAIN = 11155111;

function channelByPrefix(prefix: string) {
  const key = Array.from(channelHandlers.byChannelName.keys()).find((name) => name.startsWith(prefix));
  return key ? channelHandlers.byChannelName.get(key) : undefined;
}

function row(opts: Partial<Record<string, unknown>> = {}) {
  return {
    tx_hash: "0xtx",
    user_from: ALICE,
    user_to: ME,
    activity_type: "payment",
    note: "",
    created_at: new Date().toISOString(),
    chain_id: CHAIN,
    contract_address: "0xhub",
    token_address: "0xusdc",
    block_number: 1,
    id: "row-1",
    ...opts,
  };
}

beforeEach(() => {
  fetchActivitiesMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  acceptTxMock.mockReset();
  onCrossTabActionMock.mockReset();
  supabaseChannelMock.mockReset();
  supabaseRemoveChannelMock.mockReset();
  channelHandlers.byChannelName.clear();
  localStorage.clear();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: undefined });
  useChainMock.mockReturnValue({ activeChainId: CHAIN });
  fetchActivitiesMock.mockResolvedValue([]);
  acceptTxMock.mockReturnValue(true);
  onCrossTabActionMock.mockReturnValue(() => {});

  supabaseChannelMock.mockImplementation((channelName: string) => {
    const chain: Record<string, unknown> = {
      on: (_evt: string, _opts: unknown, h: (payload: { new: Record<string, unknown> }) => void) => {
        channelHandlers.byChannelName.set(channelName, h);
        return chain;
      },
      subscribe: () => chain,
    };
    return chain;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useActivityFeed — cache hydration (§15.x)", () => {
  it("hydrates from localStorage on mount when address is connected", () => {
    const cached = [row({ tx_hash: "0xcached", id: "c1" })];
    localStorage.setItem(STORAGE_KEYS.activities(ME, CHAIN), JSON.stringify(cached));

    const { result } = renderHook(() => useActivityFeed());
    expect(result.current.activities[0].tx_hash).toBe("0xcached");
  });

  it("empty cache when no address is connected", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined, eoa: undefined });
    const { result } = renderHook(() => useActivityFeed());
    expect(result.current.activities).toEqual([]);
  });
});

describe("useActivityFeed — server fetch (§15.x)", () => {
  it("calls fetchActivities with the effective address on mount", async () => {
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    const args = fetchActivitiesMock.mock.calls[0];
    expect(args[0]).toContain(ME);
    expect(args[3]).toBe(CHAIN);
  });

  it("fetches with BOTH addresses when AA + EOA distinct (#190)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: EOA });
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    const args = fetchActivitiesMock.mock.calls[0];
    expect(args[0]).toContain(ME);
    expect(args[0]).toContain(EOA);
  });

  it("dedups addresses case-insensitively (eoa.toLowerCase === effectiveAddress.toLowerCase)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: ME.toUpperCase() });
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    const addrs = fetchActivitiesMock.mock.calls[0][0];
    expect(addrs.length).toBe(1);
  });

  it("populates activities from server response", async () => {
    fetchActivitiesMock.mockResolvedValue([
      row({ tx_hash: "0xA", id: "a" }),
      row({ tx_hash: "0xB", id: "b" }),
    ]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.activities.length).toBe(2));
    expect(result.current.isOffline).toBe(false);
  });

  it("sets isOffline=true when fetchActivities throws", async () => {
    fetchActivitiesMock.mockRejectedValue(new Error("RPC down"));
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.isOffline).toBe(true));
  });

  it("caches up to CACHE_CAP=100 rows to localStorage after server fetch", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      row({ tx_hash: `0x${i}`, id: `r${i}` }),
    );
    fetchActivitiesMock.mockResolvedValue(rows);
    renderHook(() => useActivityFeed());
    await waitFor(() => {
      const cached = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.activities(ME, CHAIN)) ?? "[]",
      );
      expect(cached.length).toBe(100);
    });
  });

  it("hasMore=true when server returns a full PAGE_SIZE (50)", async () => {
    fetchActivitiesMock.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => row({ tx_hash: `0x${i}`, id: `r${i}` })),
    );
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.activities.length).toBe(50));
    expect(result.current.hasMore).toBe(true);
  });

  it("hasMore=false on partial page (end of history)", async () => {
    fetchActivitiesMock.mockResolvedValue([row({ tx_hash: "0xA", id: "a" })]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.activities.length).toBe(1));
    expect(result.current.hasMore).toBe(false);
  });
});

describe("useActivityFeed — realtime channel registration (§15.x #88 fix)", () => {
  it("opens 2 channels per address: incoming (user_to) AND outgoing (user_from)", async () => {
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));
    expect(channelByPrefix(`activities_in_${ME.toLowerCase()}_`)).toBeDefined();
    expect(channelByPrefix(`activities_out_${ME.toLowerCase()}_`)).toBeDefined();
  });

  it("opens 4 total channels when AA + EOA distinct (2 per address)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: EOA });
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBe(4));
  });

  it("cleanup removes every channel via supabase.removeChannel", async () => {
    const { unmount } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));
    unmount();
    expect(supabaseRemoveChannelMock).toHaveBeenCalledTimes(2);
  });
});

describe("useActivityFeed — insert-buffer 100ms debounce (§15.x #251)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces multiple inserts within 100ms into a single setActivities call", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useActivityFeed());

    // Wait for channel registration via fake timers.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const handler = channelByPrefix(`activities_in_${ME.toLowerCase()}_`)!;
    expect(handler).toBeDefined();

    // Fire 3 inserts back-to-back (simulates a batchSend tx emitting N events).
    act(() => {
      handler({ new: row({ tx_hash: "0x1", id: "1" }) });
      handler({ new: row({ tx_hash: "0x2", id: "2" }) });
      handler({ new: row({ tx_hash: "0x3", id: "3" }) });
    });

    // Before 100ms: still buffered, activities not yet updated.
    expect(result.current.activities.length).toBe(0);

    // After 100ms flush.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.activities.length).toBe(3);
  });

  it("realtime handler respects acceptTx dedup (filters tx before buffering)", async () => {
    acceptTxMock.mockReturnValue(false);
    const { result } = renderHook(() => useActivityFeed());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const handler = channelByPrefix(`activities_in_${ME.toLowerCase()}_`)!;
    act(() => {
      handler({ new: row({ tx_hash: "0xdup", id: "d" }) });
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.activities.length).toBe(0);
  });
});

describe("useActivityFeed — cross-tab sync (§15.x)", () => {
  it("subscribes to cross-tab actions via onCrossTabAction", () => {
    renderHook(() => useActivityFeed());
    expect(onCrossTabActionMock).toHaveBeenCalled();
  });

  it("refetches activities on 'balance_changed' broadcast", async () => {
    let crossTabHandler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((cb: (action: string) => void) => {
      crossTabHandler = cb;
      return () => {};
    });

    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalledTimes(1));

    act(() => {
      crossTabHandler?.("balance_changed");
    });
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalledTimes(2));
  });

  it("refetches on 'activity_added' broadcast", async () => {
    let crossTabHandler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((cb: (action: string) => void) => {
      crossTabHandler = cb;
      return () => {};
    });

    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalledTimes(1));
    act(() => crossTabHandler?.("activity_added"));
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalledTimes(2));
  });

  it("IGNORES unknown cross-tab actions (no refetch storm)", async () => {
    let crossTabHandler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((cb: (action: string) => void) => {
      crossTabHandler = cb;
      return () => {};
    });
    renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalledTimes(1));
    act(() => crossTabHandler?.("unrelated_action"));
    // Brief wait then assert still 1 call.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchActivitiesMock).toHaveBeenCalledTimes(1);
  });
});

describe("useActivityFeed — addLocalActivity optimistic UI (§15.x)", () => {
  it("prepends a local activity to the feed without a server fetch", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());

    const fetchCallsBefore = fetchActivitiesMock.mock.calls.length;
    act(() => {
      result.current.addLocalActivity({
        tx_hash: "0xoptimistic",
        user_from: ME,
        user_to: ALICE,
        activity_type: "payment",
        note: "",
        chain_id: CHAIN,
        contract_address: "0xhub",
        token_address: "0xusdc",
        block_number: 0,
      } as never);
    });

    expect(result.current.activities[0].tx_hash).toBe("0xoptimistic");
    // No additional server fetch triggered.
    expect(fetchActivitiesMock.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("assigns a unique 'local_<timestamp>' id to addLocalActivity rows", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());

    act(() => {
      result.current.addLocalActivity({
        tx_hash: "0xlocal",
        user_from: ME,
        user_to: ALICE,
        activity_type: "payment",
        note: "",
        chain_id: CHAIN,
        contract_address: "0xhub",
        token_address: "0xusdc",
        block_number: 0,
      } as never);
    });
    expect(result.current.activities[0].id).toMatch(/^local_\d+$/);
  });

  it("addLocalActivity also writes to localStorage cache", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());

    act(() => {
      result.current.addLocalActivity({
        tx_hash: "0xcached-optimistic",
        user_from: ME,
        user_to: ALICE,
        activity_type: "payment",
        note: "",
        chain_id: CHAIN,
        contract_address: "0xhub",
        token_address: "0xusdc",
        block_number: 0,
      } as never);
    });

    const cached = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.activities(ME, CHAIN)) ?? "[]",
    );
    expect(cached.some((a: { tx_hash: string }) => a.tx_hash === "0xcached-optimistic")).toBe(true);
  });
});
