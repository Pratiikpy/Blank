import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RealtimeDedup,
  createActivityDedup,
  createInvoiceDedup,
  createEscrowDedup,
  createPaymentRequestDedup,
  createExchangeOfferDedup,
  createGroupExpenseDedup,
  createIdDedup,
} from "./realtime-dedup";

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

// §15.x extension: serialization (toJSON / fromJSON) + maxSize
// eviction + the 7 factory functions per table type. The persistence
// path is what survives sessionStorage reloads — without it, every
// page refresh would re-fire toasts for activities the user already
// dismissed.

describe("RealtimeDedup — toJSON / fromJSON persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("toJSON returns the current state with windowMs and entries[]", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 30_000,
    });
    dedup.accept({ tx_hash: "0xa" });
    dedup.accept({ tx_hash: "0xb" });
    const snapshot = dedup.toJSON();
    expect(snapshot.windowMs).toBe(30_000);
    expect(snapshot.entries.length).toBe(2);
    const keys = snapshot.entries.map(([k]) => k).sort();
    expect(keys).toEqual(["0xa", "0xb"]);
  });

  it("toJSON filters out entries past the window (no point exporting them)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 1_000,
    });
    dedup.accept({ tx_hash: "0xold" });
    // Advance past the window before adding 0xfresh.
    vi.advanceTimersByTime(2_000);
    dedup.accept({ tx_hash: "0xfresh" });
    const snapshot = dedup.toJSON();
    const keys = snapshot.entries.map(([k]) => k);
    expect(keys).toContain("0xfresh");
    expect(keys).not.toContain("0xold");
  });

  it("fromJSON restores entries that still fit the window", () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(baseTime);
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 30_000,
    });
    // Inject a snapshot directly.
    dedup.fromJSON({
      entries: [
        ["0xa", baseTime - 5_000],
        ["0xb", baseTime - 1_000],
      ],
      windowMs: 30_000,
    });
    // Both keys should now be rejected as duplicates.
    expect(dedup.accept({ tx_hash: "0xa" })).toBe(false);
    expect(dedup.accept({ tx_hash: "0xb" })).toBe(false);
  });

  it("fromJSON skips entries already past the window (no stale leak)", () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(baseTime);
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 1_000,
    });
    dedup.fromJSON({
      entries: [
        // 5 seconds old, but windowMs is 1 second -> already expired.
        ["0xstale", baseTime - 5_000],
      ],
      windowMs: 1_000,
    });
    // 0xstale must be accepted (skipped during restore).
    expect(dedup.accept({ tx_hash: "0xstale" })).toBe(true);
  });

  it("fromJSON handles null / undefined snapshot without crashing", () => {
    const dedup = new RealtimeDedup<Row>({ keyFn: (r) => r.tx_hash ?? null });
    expect(() => dedup.fromJSON(null)).not.toThrow();
    expect(() => dedup.fromJSON(undefined)).not.toThrow();
    // State is clean after either call.
    expect(dedup.accept({ tx_hash: "0xa" })).toBe(true);
  });

  it("fromJSON skips malformed entry shapes (non-string key, non-number ts)", () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(baseTime);
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 30_000,
    });
    dedup.fromJSON({
      entries: [
        [123 as unknown as string, baseTime - 1_000],
        ["0xa", "not-a-number" as unknown as number],
        ["0xvalid", baseTime - 5_000],
      ],
      windowMs: 30_000,
    });
    // Only 0xvalid was actually restored.
    expect(dedup.accept({ tx_hash: "0xvalid" })).toBe(false);
    // The malformed entries were skipped.
    expect(dedup.accept({ tx_hash: "0xa" })).toBe(true);
  });

  it("toJSON round-trips through fromJSON (the persistence contract)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const a = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 30_000,
    });
    a.accept({ tx_hash: "0xa" });
    a.accept({ tx_hash: "0xb" });
    const snapshot = a.toJSON();

    const b = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      windowMs: 30_000,
    });
    b.fromJSON(snapshot);
    expect(b.accept({ tx_hash: "0xa" })).toBe(false);
    expect(b.accept({ tx_hash: "0xb" })).toBe(false);
    expect(b.accept({ tx_hash: "0xc" })).toBe(true);
  });
});

describe("RealtimeDedup — maxSize eviction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("toJSON caps at maxSize newest entries (sessionStorage doesn't blow up)", () => {
    vi.useFakeTimers();
    const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(baseTime);
    const dedup = new RealtimeDedup<Row>({
      keyFn: (r) => r.tx_hash ?? null,
      maxSize: 5,
      windowMs: 1_000_000,
    });
    // Inject 10 entries through fromJSON so we have more than maxSize.
    dedup.fromJSON({
      entries: Array.from({ length: 10 }, (_, i) => [
        `0x${i}`,
        baseTime - (10 - i) * 100, // newer entries have larger timestamps
      ]) as Array<[string, number]>,
      windowMs: 1_000_000,
    });
    const snapshot = dedup.toJSON();
    expect(snapshot.entries.length).toBe(5);
    // Newest entries kept — sort descending by ts and pick the first 5.
    const keys = snapshot.entries.map(([k]) => k).sort();
    // 0x5..0x9 are the 5 newest by the construction above.
    expect(keys).toEqual(["0x5", "0x6", "0x7", "0x8", "0x9"]);
  });
});

// §15.x extension: factory functions per Supabase table type. Each
// factory specializes the keyFn for the table's primary identifier;
// a regression that swapped or misspelled one would silently
// dedup-collide across unrelated rows.

describe("RealtimeDedup — convenience factories per table type", () => {
  it("createActivityDedup keys on tx_hash", () => {
    const dedup = createActivityDedup();
    expect(dedup.accept({ tx_hash: "0xabc" })).toBe(true);
    expect(dedup.accept({ tx_hash: "0xabc" })).toBe(false);
    // Different tx_hash accepted.
    expect(dedup.accept({ tx_hash: "0xdef" })).toBe(true);
    // Missing tx_hash treated as null key (always accepted).
    expect(dedup.accept({})).toBe(true);
    expect(dedup.accept({})).toBe(true);
  });

  it("createInvoiceDedup keys on invoice_id (different field than activity dedup)", () => {
    const dedup = createInvoiceDedup();
    expect(dedup.accept({ invoice_id: "inv-1" })).toBe(true);
    expect(dedup.accept({ invoice_id: "inv-1" })).toBe(false);
    expect(dedup.accept({ invoice_id: "inv-2" })).toBe(true);
  });

  it("createEscrowDedup keys on escrow_id", () => {
    const dedup = createEscrowDedup();
    expect(dedup.accept({ escrow_id: "esc-1" })).toBe(true);
    expect(dedup.accept({ escrow_id: "esc-1" })).toBe(false);
  });

  it("createPaymentRequestDedup keys on request_id", () => {
    const dedup = createPaymentRequestDedup();
    expect(dedup.accept({ request_id: "req-1" })).toBe(true);
    expect(dedup.accept({ request_id: "req-1" })).toBe(false);
  });

  it("createExchangeOfferDedup keys on offer_id", () => {
    const dedup = createExchangeOfferDedup();
    expect(dedup.accept({ offer_id: "offer-1" })).toBe(true);
    expect(dedup.accept({ offer_id: "offer-1" })).toBe(false);
  });

  it("createGroupExpenseDedup keys on expense_id", () => {
    const dedup = createGroupExpenseDedup();
    expect(dedup.accept({ expense_id: "exp-1" })).toBe(true);
    expect(dedup.accept({ expense_id: "exp-1" })).toBe(false);
  });

  it("createIdDedup coerces numeric id via String() (handles tables with bigserial primary keys)", () => {
    const dedup = createIdDedup();
    expect(dedup.accept({ id: 42 })).toBe(true);
    expect(dedup.accept({ id: 42 })).toBe(false);
    // Number 42 and string "42" share the dedup key after String() coercion.
    expect(dedup.accept({ id: "42" })).toBe(false);
  });

  it("createIdDedup with id=null|undefined accepts every row (no false dedup)", () => {
    const dedup = createIdDedup();
    expect(dedup.accept({ id: null as unknown as string })).toBe(true);
    expect(dedup.accept({ id: undefined })).toBe(true);
    expect(dedup.accept({})).toBe(true);
  });

  it("each factory is independent (separate seen-maps, no cross-table collision)", () => {
    const activity = createActivityDedup();
    const invoice = createInvoiceDedup();
    // Same string used as both tx_hash AND invoice_id — independent dedup.
    expect(activity.accept({ tx_hash: "shared" })).toBe(true);
    expect(invoice.accept({ invoice_id: "shared" })).toBe(true);
    // Each factory rejects ITS OWN second-call.
    expect(activity.accept({ tx_hash: "shared" })).toBe(false);
    expect(invoice.accept({ invoice_id: "shared" })).toBe(false);
  });

  it("every factory uses the documented 30-second window (consistent default across tables)", () => {
    // Use toJSON to inspect the windowMs without exposing internals.
    expect(createActivityDedup().toJSON().windowMs).toBe(30_000);
    expect(createInvoiceDedup().toJSON().windowMs).toBe(30_000);
    expect(createEscrowDedup().toJSON().windowMs).toBe(30_000);
    expect(createPaymentRequestDedup().toJSON().windowMs).toBe(30_000);
    expect(createExchangeOfferDedup().toJSON().windowMs).toBe(30_000);
    expect(createGroupExpenseDedup().toJSON().windowMs).toBe(30_000);
    expect(createIdDedup().toJSON().windowMs).toBe(30_000);
  });
});
