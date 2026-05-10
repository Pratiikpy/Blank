import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  setQueryClient,
  invalidateBalanceQueries,
  invalidateAllQueries,
} from "./query-invalidation";

// §15.x lib test for the cross-tab + cross-component query
// invalidation helpers. These get called from non-React contexts
// (cofhe shim, cross-tab handler, useSmartAccount on chain switch),
// so they fall back to no-ops when the client isn't registered yet.

beforeEach(() => {
  // Reset module state to "no client registered". Passing an
  // unconfigured QueryClient and immediately swapping is the
  // simplest way to clear ref between tests.
  setQueryClient(undefined as unknown as QueryClient);
});

describe("query-invalidation", () => {
  it("invalidateBalanceQueries no-ops when no client registered", () => {
    // Just must not throw.
    expect(() => invalidateBalanceQueries()).not.toThrow();
  });

  it("invalidateAllQueries no-ops when no client registered", () => {
    expect(() => invalidateAllQueries()).not.toThrow();
  });

  it("invalidateBalanceQueries calls invalidateQueries with the readContract key", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    setQueryClient(client);

    invalidateBalanceQueries();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["readContract"] });
  });

  it("invalidateAllQueries calls invalidateQueries with no args", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    setQueryClient(client);

    invalidateAllQueries();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });

  it("setQueryClient swaps the active client cleanly", () => {
    const first = new QueryClient();
    const firstSpy = vi.spyOn(first, "invalidateQueries").mockResolvedValue();
    setQueryClient(first);

    const second = new QueryClient();
    const secondSpy = vi.spyOn(second, "invalidateQueries").mockResolvedValue();
    setQueryClient(second);

    invalidateBalanceQueries();
    expect(firstSpy).not.toHaveBeenCalled();
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });
});
