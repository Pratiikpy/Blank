import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useConnectionHealth. Pin the 2-failure RPC
// threshold (single flake should NOT raise the banner), the
// recovery-on-first-success behavior, and the realtime SUBSCRIBED
// vs CLOSED / CHANNEL_ERROR / TIMED_OUT mapping.

const getBlockNumberMock = vi.hoisted(() => vi.fn());
const subscribeCallback = vi.hoisted(() => ({ cb: null as null | ((s: string) => void) }));

vi.mock("wagmi", () => ({
  usePublicClient: () => ({ getBlockNumber: getBlockNumberMock }),
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: () => ({ activeChainId: 11155111 }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: vi.fn(() => ({
      subscribe: (cb: (s: string) => void) => {
        subscribeCallback.cb = cb;
        return { topic: "connection_health_probe" };
      },
    })),
    removeChannel: vi.fn(),
  },
}));

import { useConnectionHealth } from "./useConnectionHealth";

beforeEach(() => {
  vi.useFakeTimers();
  getBlockNumberMock.mockReset();
  subscribeCallback.cb = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useConnectionHealth — RPC probe (§15.x)", () => {
  it("starts not-degraded and stays so when probes succeed", async () => {
    getBlockNumberMock.mockResolvedValue(123n);
    const { result } = renderHook(() => useConnectionHealth());

    // Flush the initial probe (kicked off on mount).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.rpcDegraded).toBe(false);
  });

  it("a SINGLE failure does NOT raise rpcDegraded (2-failure threshold)", async () => {
    getBlockNumberMock.mockRejectedValueOnce(new Error("net down"));
    getBlockNumberMock.mockResolvedValueOnce(123n);
    const { result } = renderHook(() => useConnectionHealth());

    // First (failing) probe.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rpcDegraded).toBe(false);
  });

  it("raises rpcDegraded after 2 consecutive failures", async () => {
    getBlockNumberMock.mockRejectedValue(new Error("net down"));
    const { result } = renderHook(() => useConnectionHealth());

    // Initial probe (fail #1).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rpcDegraded).toBe(false);

    // Advance 15s and let the next probe run (fail #2).
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rpcDegraded).toBe(true);
  });

  it("clears rpcDegraded on a successful probe after degradation", async () => {
    // Start by rejecting all probes -> degraded after 2 fails.
    getBlockNumberMock.mockRejectedValue(new Error("net down"));
    const { result } = renderHook(() => useConnectionHealth());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rpcDegraded).toBe(true);

    // Flip the mock to succeed and advance to trigger the next probe.
    getBlockNumberMock.mockReset();
    getBlockNumberMock.mockResolvedValue(456n);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rpcDegraded).toBe(false);
  });
});

describe("useConnectionHealth — realtime probe (§15.x)", () => {
  beforeEach(() => {
    getBlockNumberMock.mockResolvedValue(1n);
  });

  it("starts not-degraded, becomes healthy on SUBSCRIBED", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.realtimeDegraded).toBe(false);

    await act(async () => {
      subscribeCallback.cb!("SUBSCRIBED");
    });
    expect(result.current.realtimeDegraded).toBe(false);
  });

  it("becomes degraded on CLOSED", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      subscribeCallback.cb!("CLOSED");
    });
    expect(result.current.realtimeDegraded).toBe(true);
  });

  it("becomes degraded on CHANNEL_ERROR", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      subscribeCallback.cb!("CHANNEL_ERROR");
    });
    expect(result.current.realtimeDegraded).toBe(true);
  });

  it("becomes degraded on TIMED_OUT", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      subscribeCallback.cb!("TIMED_OUT");
    });
    expect(result.current.realtimeDegraded).toBe(true);
  });

  it("recovers on SUBSCRIBED after a CLOSED", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      subscribeCallback.cb!("CLOSED");
    });
    expect(result.current.realtimeDegraded).toBe(true);

    await act(async () => {
      subscribeCallback.cb!("SUBSCRIBED");
    });
    expect(result.current.realtimeDegraded).toBe(false);
  });

  it("ignores unknown status values (no state change)", async () => {
    const { result } = renderHook(() => useConnectionHealth());
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      subscribeCallback.cb!("SOMETHING_ELSE");
    });
    expect(result.current.realtimeDegraded).toBe(false);
  });
});
