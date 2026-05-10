import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, act } from "@testing-library/react";

// §15.x test for RealtimeProvider. Pins the multiplexed pubsub
// contract: subscribe/unsubscribe lifecycle, server-side filter
// routing (case-insensitive string equality), dispatch isolation
// (one sub throwing must not break others), per-table dedup so
// the same row can't fire the bus twice, and case-insensitive
// filter comparison.

const channelHandlers = vi.hoisted(() => ({
  // Keyed by `${table}-${event}` so the test can invoke any one.
  byKey: new Map<string, (payload: { new?: unknown; old?: unknown }) => void>(),
}));

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("@/lib/supabase", () => {
  const channelObj: Record<string, unknown> = {};
  channelObj.on = (
    _evt: string,
    opts: { event: string; table: string },
    h: (payload: { new?: unknown; old?: unknown }) => void,
  ) => {
    channelHandlers.byKey.set(`${opts.table}-${opts.event}`, h);
    return channelObj;
  };
  channelObj.subscribe = () => channelObj;
  return {
    supabase: {
      channel: () => channelObj,
      removeChannel: vi.fn(),
    },
  };
});

import { RealtimeProvider, useRealtime } from "./RealtimeProvider";

const ME = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  sessionStorage.clear();
  channelHandlers.byKey.clear();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <RealtimeProvider>{children}</RealtimeProvider>;
}

describe("useRealtime — provider guard (§15.x)", () => {
  it("throws when used outside RealtimeProvider", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useRealtime())).toThrow(/must be used inside/);
    err.mockRestore();
  });

  it("returns subscribe + client inside the provider", () => {
    const { result } = renderHook(() => useRealtime(), { wrapper });
    expect(typeof result.current.subscribe).toBe("function");
    expect(result.current.client).toBeDefined();
  });
});

describe("subscribe / unsubscribe lifecycle (§15.x)", () => {
  it("registered handler fires for a matching INSERT event", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", { event: "INSERT" }, handler);
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    expect(channelHandler).toBeDefined();
    act(() => {
      channelHandler!({ new: { tx_hash: "0xtx1", id: "a" } });
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ tx_hash: "0xtx1", id: "a" });
  });

  it("returned unsubscribe stops further dispatch", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    let unsubscribe: () => void;
    act(() => {
      unsubscribe = result.current.subscribe("activities", { event: "INSERT" }, handler);
    });

    act(() => { unsubscribe!(); });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      channelHandler!({ new: { tx_hash: "0xtx1", id: "a" } });
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple subs on the same (table, event) all fire independently", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", { event: "INSERT" }, h1);
      result.current.subscribe("activities", { event: "INSERT" }, h2);
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      channelHandler!({ new: { tx_hash: "0xtx1", id: "a" } });
    });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("default event is INSERT when not specified", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", {}, handler);
    });

    const insertHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      insertHandler!({ new: { tx_hash: "0xtx1", id: "a" } });
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("server-side filter routing (§15.x)", () => {
  it("routes only rows whose filter column matches the value", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe(
        "activities",
        { event: "INSERT", filter: { column: "user_to", value: ME } },
        handler,
      );
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      channelHandler!({ new: { tx_hash: "0xa", id: "a", user_to: ME } });
      channelHandler!({ new: { tx_hash: "0xb", id: "b", user_to: "0xBBBb" } });
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].tx_hash).toBe("0xa");
  });

  it("filter comparison is case-insensitive for string columns", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe(
        "activities",
        { event: "INSERT", filter: { column: "user_to", value: ME.toUpperCase() } },
        handler,
      );
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      channelHandler!({ new: { tx_hash: "0xa", id: "a", user_to: ME.toLowerCase() } });
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch isolation (§15.x)", () => {
  it("one subscriber throwing does NOT prevent others from firing", () => {
    const throws = vi.fn(() => { throw new Error("buggy sub"); });
    const ok = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", { event: "INSERT" }, throws);
      result.current.subscribe("activities", { event: "INSERT" }, ok);
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    expect(() => {
      act(() => {
        channelHandler!({ new: { tx_hash: "0xa", id: "a" } });
      });
    }).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("per-table dedup (#247) (§15.x)", () => {
  it("same activities row received twice fires the bus only once", () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", { event: "INSERT" }, handler);
    });

    const channelHandler = channelHandlers.byKey.get("activities-INSERT");
    act(() => {
      channelHandler!({ new: { tx_hash: "0xshared", id: "a" } });
      channelHandler!({ new: { tx_hash: "0xshared", id: "b" } });
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("different tables don't share dedup state", () => {
    const actHandler = vi.fn();
    const invHandler = vi.fn();
    const { result } = renderHook(() => useRealtime(), { wrapper });
    act(() => {
      result.current.subscribe("activities", { event: "INSERT" }, actHandler);
      result.current.subscribe("invoices", { event: "INSERT" }, invHandler);
    });

    const actCh = channelHandlers.byKey.get("activities-INSERT");
    const invCh = channelHandlers.byKey.get("invoices-INSERT");
    act(() => {
      actCh!({ new: { tx_hash: "0xtxA", id: "a" } });
      invCh!({ new: { invoice_id: 1 } });
    });

    expect(actHandler).toHaveBeenCalledTimes(1);
    expect(invHandler).toHaveBeenCalledTimes(1);
  });
});

describe("address + chain guards (§15.x)", () => {
  it("does not register channel handlers when address is missing", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    render(
      <RealtimeProvider>
        <div />
      </RealtimeProvider>,
    );
    expect(channelHandlers.byKey.size).toBe(0);
  });
});
