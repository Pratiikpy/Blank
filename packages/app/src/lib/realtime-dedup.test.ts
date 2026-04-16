import { describe, it, expect, vi, afterEach } from "vitest";
import { RealtimeDedup } from "./realtime-dedup";

type Row = { tx_hash?: string; id?: string };

describe("RealtimeDedup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a new row on the first call", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: (r) => r.tx_hash ?? null });
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
  });

  it("rejects the same row on a second call within the window", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: (r) => r.tx_hash ?? null });
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(false);
  });

  it("accepts the row again after forget(key)", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: (r) => r.tx_hash ?? null });
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(false);
    dedup.forget("0x1");
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
  });

  it("accepts the row again after windowMs has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 1_000,
    });
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(1_500);
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
  });

  it("always accepts when the key function returns null", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: () => null });
    // Row without a tx_hash — always accepted
    expect(dedup.accept({})).toBe(true);
    expect(dedup.accept({})).toBe(true);
    expect(dedup.accept({})).toBe(true);
  });

  it("reset() clears all keys", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: (r) => r.tx_hash ?? null });
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x2" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x1" })).toBe(false);
    expect(dedup.accept({ tx_hash: "0x2" })).toBe(false);

    dedup.reset();

    expect(dedup.accept({ tx_hash: "0x1" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0x2" })).toBe(true);
  });
});
