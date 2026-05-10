import { describe, it, expect, vi } from "vitest";
import { checkRateLimit, writeRateLimitHeaders } from "./rate-limit.js";

// §15.x server-side test for the shared rate limiter. Drives every
// /api/* endpoint that needs per-IP throttling (faucet, relay,
// oracle, scheduled-sends). Off-by-one on the max comparison
// means either rejecting legitimate users at max-1 OR accepting
// max+1 requests; either is a correctness bug.

// Use unique keys per test (memCache is module-level) to avoid
// cross-test pollution.
let counter = 0;
function nextKey() {
  counter += 1;
  return `test-${counter}-${Date.now()}`;
}

describe("checkRateLimit (memCache fallback)", () => {
  it("first call passes with remaining = max-1", async () => {
    const res = await checkRateLimit({
      ip: "1.1.1.1",
      key: nextKey(),
      windowMs: 60_000,
      max: 5,
    });
    expect(res.ok).toBe(true);
    expect(res.remaining).toBe(4);
  });

  it("counts each call within the window", async () => {
    const key = nextKey();
    const ip = "1.1.1.1";
    for (let i = 1; i <= 5; i++) {
      const res = await checkRateLimit({ ip, key, windowMs: 60_000, max: 5 });
      expect(res.ok).toBe(true);
      expect(res.remaining).toBe(5 - i);
    }
  });

  it("rejects the (max+1)-th call with ok=false", async () => {
    const key = nextKey();
    const ip = "2.2.2.2";
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit({ ip, key, windowMs: 60_000, max: 3 });
      expect(r.ok).toBe(true);
    }
    const denied = await checkRateLimit({ ip, key, windowMs: 60_000, max: 3 });
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("isolates buckets by IP", async () => {
    const key = nextKey();
    for (let i = 0; i < 3; i++) {
      await checkRateLimit({ ip: "3.3.3.3", key, windowMs: 60_000, max: 3 });
    }
    // 3.3.3.3 is exhausted, but 4.4.4.4 should pass freely.
    const fresh = await checkRateLimit({
      ip: "4.4.4.4",
      key,
      windowMs: 60_000,
      max: 3,
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.remaining).toBe(2);
  });

  it("isolates buckets by key (e.g. faucet vs. relay)", async () => {
    const ip = "5.5.5.5";
    const k1 = nextKey();
    const k2 = nextKey();
    for (let i = 0; i < 3; i++) {
      await checkRateLimit({ ip, key: k1, windowMs: 60_000, max: 3 });
    }
    // k1 is exhausted, but k2 (different feature) should pass.
    const fresh = await checkRateLimit({
      ip,
      key: k2,
      windowMs: 60_000,
      max: 3,
    });
    expect(fresh.ok).toBe(true);
  });

  it("clears expired entries after the window passes", async () => {
    vi.useFakeTimers();
    try {
      const start = 1_700_000_000_000;
      vi.setSystemTime(new Date(start));
      const ip = "6.6.6.6";
      const key = nextKey();

      // Use up the budget at t=0
      for (let i = 0; i < 3; i++) {
        await checkRateLimit({ ip, key, windowMs: 60_000, max: 3 });
      }
      const denied = await checkRateLimit({
        ip, key, windowMs: 60_000, max: 3,
      });
      expect(denied.ok).toBe(false);

      // Jump past the window — old entries get dropped on next read.
      vi.setSystemTime(new Date(start + 61_000));
      const recovered = await checkRateLimit({
        ip, key, windowMs: 60_000, max: 3,
      });
      expect(recovered.ok).toBe(true);
      expect(recovered.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("max=0 always rejects", async () => {
    const res = await checkRateLimit({
      ip: "7.7.7.7", key: nextKey(), windowMs: 60_000, max: 0,
    });
    expect(res.ok).toBe(false);
  });
});

describe("writeRateLimitHeaders", () => {
  it("writes RateLimit-Remaining + RateLimit-Reset", () => {
    const setHeader = vi.fn();
    writeRateLimitHeaders({ setHeader }, { ok: false, remaining: 0, resetSeconds: 42 });
    expect(setHeader).toHaveBeenCalledWith("RateLimit-Remaining", "0");
    expect(setHeader).toHaveBeenCalledWith("RateLimit-Reset", "42");
  });

  it("is a no-op when res has no setHeader (e.g. test stubs)", () => {
    expect(() => writeRateLimitHeaders({}, { ok: true, remaining: 1, resetSeconds: 1 })).not.toThrow();
  });
});
