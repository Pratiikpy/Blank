import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSubmissionGuard } from "./useSubmissionGuard";

// §15.2.1: hook test for the in-flight submission guard.
// Behavior: prevents double-submit across all entry shapes
// (double-click, Enter + onClick, StrictMode double-mount).

describe("useSubmissionGuard", () => {
  it("first call runs and returns guarded=false with the result", async () => {
    const { result } = renderHook(() => useSubmissionGuard());
    const out = await result.current(async () => 42);
    expect(out).toEqual({ result: 42, guarded: false });
  });

  it("second call while first is in-flight returns guarded=true immediately", async () => {
    const { result } = renderHook(() => useSubmissionGuard());

    let releaseFirst: (() => void) | null = null;
    const firstPromise = result.current(async () => {
      await new Promise<void>((res) => {
        releaseFirst = res;
      });
      return "first-done";
    });

    // Second call lands while first is still pending.
    const secondPromise = result.current(async () => "second-done");
    const second = await secondPromise;
    expect(second).toEqual({ result: undefined, guarded: true });

    releaseFirst!();
    const first = await firstPromise;
    expect(first).toEqual({ result: "first-done", guarded: false });
  });

  it("guard releases after the first call finishes so a later call works", async () => {
    const { result } = renderHook(() => useSubmissionGuard());
    await result.current(async () => "a");
    const out = await result.current(async () => "b");
    expect(out).toEqual({ result: "b", guarded: false });
  });

  it("guard releases when the wrapped function throws", async () => {
    const { result } = renderHook(() => useSubmissionGuard());
    await expect(
      result.current(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Next call must be admitted; if the guard had stuck, this would
    // return {guarded: true} forever.
    const out = await result.current(async () => "after-error");
    expect(out).toEqual({ result: "after-error", guarded: false });
  });

  it("returns a stable callback identity across re-renders", () => {
    const { result, rerender } = renderHook(() => useSubmissionGuard());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
