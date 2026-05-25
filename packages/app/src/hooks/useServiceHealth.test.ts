import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { getHealthEndpoint, useServiceHealth } from "./useServiceHealth";

// §15.x hook test for the /api/health poller. Drives the
// ServiceHealthBanner; misclassification means the user sees a
// false "service down" message OR misses a real outage.

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mockHealthResponse(derived: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ derived }),
    })) as unknown as typeof fetch,
  );
}

describe("useServiceHealth (§15.x)", () => {
  it("uses central production health for branded subdomains", () => {
    expect(getHealthEndpoint("app.myblank.app")).toBe("https://www.myblank.app/api/health");
    expect(getHealthEndpoint("docs.myblank.app")).toBe("https://www.myblank.app/api/health");
    expect(getHealthEndpoint("www.myblank.app")).toBe("/api/health");
    expect(getHealthEndpoint("localhost")).toBe("/api/health");
  });

  it("starts loading=true with optimistic-default reachability", () => {
    mockHealthResponse({});
    const { result } = renderHook(() => useServiceHealth());
    // First render: defaults are all-reachable + loading.
    expect(result.current.loading).toBe(true);
    expect(result.current.agentsReachable).toBe(true);
    expect(result.current.relayReachable).toBe(true);
    expect(result.current.fhenixReachable).toBe(true);
  });

  it("flips loading=false after the first probe resolves", async () => {
    mockHealthResponse({
      agentsReachable: true,
      relayReachable: true,
      fhenixReachable: true,
    });
    const { result } = renderHook(() => useServiceHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("propagates derived flags from /api/health into state", async () => {
    mockHealthResponse({
      agentsReachable: false,
      relayReachable: true,
      fhenixReachable: false,
    });
    const { result } = renderHook(() => useServiceHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.agentsReachable).toBe(false);
    expect(result.current.relayReachable).toBe(true);
    expect(result.current.fhenixReachable).toBe(false);
  });

  it("does NOT flip ALL services to down when /api/health throws (preserves prior state)", async () => {
    // Mock fetch to throw — simulates Vercel fn cold-start timeout.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    );
    const { result } = renderHook(() => useServiceHealth());
    // Wait for the catch branch to run + flip loading off.
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Reachability stays at the optimistic defaults rather than
    // flipping everything to false. Honest "we don't know" state.
    expect(result.current.agentsReachable).toBe(true);
    expect(result.current.relayReachable).toBe(true);
    expect(result.current.fhenixReachable).toBe(true);
  });

  it("treats a missing 'derived' block as all-reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    const { result } = renderHook(() => useServiceHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // !== false logic: undefined → reachable=true.
    expect(result.current.agentsReachable).toBe(true);
    expect(result.current.relayReachable).toBe(true);
    expect(result.current.fhenixReachable).toBe(true);
  });
});
