import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
}));

import { usePolling } from "./usePolling";
import { useAccount } from "wagmi";

const useAccountMock = useAccount as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  useAccountMock.mockReturnValue({
    address: "0xabc" as `0x${string}`,
    chain: { id: 11155111 },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePolling (§15.2.1)", () => {
  it("does NOT run when enabled is false", () => {
    const fn = vi.fn();
    renderHook(() =>
      usePolling({ fn, intervalMs: 1000, enabled: false, runImmediately: true }),
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs immediately when enabled + runImmediately default", async () => {
    const fn = vi.fn();
    renderHook(() => usePolling({ fn, intervalMs: 1000, enabled: true }));
    // The immediate tick runs in microtask scope from useEffect; flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ticks at intervalMs cadence", async () => {
    const fn = vi.fn();
    renderHook(() =>
      usePolling({ fn, intervalMs: 1000, enabled: true, runImmediately: false }),
    );
    expect(fn).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts the in-flight signal on unmount", async () => {
    let captured: AbortSignal | null = null;
    const fn = vi.fn(async (signal: AbortSignal) => {
      captured = signal;
    });
    const { unmount } = renderHook(() =>
      usePolling({ fn, intervalMs: 1000, enabled: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(false);

    unmount();
    expect(captured!.aborted).toBe(true);
  });

  it("clears the interval on unmount (no further ticks fire)", async () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() =>
      usePolling({ fn, intervalMs: 1000, enabled: true, runImmediately: false }),
    );
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
