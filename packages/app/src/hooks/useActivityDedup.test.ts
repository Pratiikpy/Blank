import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useActivityDedup, __resetSharedActivityDedups } from "./useActivityDedup";

// §15.2.1: hook test for the shared activity-dedup primitive (#249).
// Behavior: dedup by tx_hash within a 60s window per (address, chainId).
// Same key shares the underlying RealtimeDedup instance across mounts.

describe("useActivityDedup", () => {
  beforeEach(() => {
    __resetSharedActivityDedups();
  });

  it("admits everything when address is undefined", () => {
    const { result } = renderHook(() => useActivityDedup(undefined, 11155111));
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
  });

  it("rejects a duplicate tx_hash within the dedup window", () => {
    const { result } = renderHook(() => useActivityDedup("0xAlice", 11155111));
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(false);
  });

  it("admits distinct tx_hashes", () => {
    const { result } = renderHook(() => useActivityDedup("0xAlice", 11155111));
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
    expect(result.current.accept({ tx_hash: "0xb" })).toBe(true);
  });

  it("forget allows the same tx_hash to be re-accepted", () => {
    const { result } = renderHook(() => useActivityDedup("0xAlice", 11155111));
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(false);
    result.current.forget("0xa");
    expect(result.current.accept({ tx_hash: "0xa" })).toBe(true);
  });

  it("isolates dedup windows by (address, chainId) pair", () => {
    const a = renderHook(() => useActivityDedup("0xAlice", 11155111));
    const b = renderHook(() => useActivityDedup("0xBob", 11155111));
    const c = renderHook(() => useActivityDedup("0xAlice", 84532));

    expect(a.result.current.accept({ tx_hash: "0xa" })).toBe(true);
    // bob's window is independent
    expect(b.result.current.accept({ tx_hash: "0xa" })).toBe(true);
    // alice on a different chain is also independent
    expect(c.result.current.accept({ tx_hash: "0xa" })).toBe(true);
    // alice's original window still rejects
    expect(a.result.current.accept({ tx_hash: "0xa" })).toBe(false);
  });

  it("shares the same dedup instance across mounts for the same key", () => {
    const first = renderHook(() => useActivityDedup("0xAlice", 11155111));
    expect(first.result.current.accept({ tx_hash: "0xa" })).toBe(true);
    first.unmount();

    // Re-mount with the same key. The module-level map preserves the
    // instance, so the previously-seen tx_hash is still in the window.
    const second = renderHook(() => useActivityDedup("0xAlice", 11155111));
    expect(second.result.current.accept({ tx_hash: "0xa" })).toBe(false);
  });

  it("address case is normalized so 0xAlice and 0xalice share a window", () => {
    const upper = renderHook(() => useActivityDedup("0xABCD", 11155111));
    const lower = renderHook(() => useActivityDedup("0xabcd", 11155111));

    expect(upper.result.current.accept({ tx_hash: "0xa" })).toBe(true);
    expect(lower.result.current.accept({ tx_hash: "0xa" })).toBe(false);
  });
});
