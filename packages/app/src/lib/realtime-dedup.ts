/**
 * Dedup wrapper for Supabase realtime handlers.
 *
 * Problem: the same activity can arrive twice —
 *   (a) our own insertActivity resolves, our own realtime subscription fires
 *   (b) cross-tab broadcast invalidates + refetch shows it again
 *   (c) Supabase rarely replays events under poor network conditions
 *
 * Without dedup the user sees double toasts and doubled list entries. Dedup
 * by a stable identifier (tx_hash for activities, request_id for requests,
 * etc.) within a rolling window.
 */

/** Persistable form of a RealtimeDedup state. */
export interface RealtimeDedupSnapshot {
  /** Pairs of [key, timestampMs]. */
  entries: Array<[string, number]>;
  windowMs: number;
}

export class RealtimeDedup<TRow extends object> {
  private seen = new Map<string, number>();
  private keyFn: (row: TRow) => string | null;
  private windowMs: number;
  private maxSize: number;

  constructor(opts: {
    keyFn: (row: TRow) => string | null;
    windowMs?: number;
    maxSize?: number;
  }) {
    this.keyFn = opts.keyFn;
    this.windowMs = opts.windowMs ?? 30_000;
    this.maxSize = opts.maxSize ?? 500;
  }

  /** Returns true if this is a new row (not seen in the window). */
  accept(row: TRow): boolean {
    const key = this.keyFn(row);
    if (!key) return true;
    const now = Date.now();
    // Evict expired entries
    if (this.seen.size > this.maxSize) {
      for (const [k, ts] of this.seen) {
        if (now - ts > this.windowMs) this.seen.delete(k);
      }
    }
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.seen.set(key, now);
    return true;
  }

  /** Drop the cached key — call if a row's state transitions and we want a fresh event to fire. */
  forget(key: string): void {
    this.seen.delete(key);
  }

  reset(): void {
    this.seen.clear();
  }

  /**
   * Serialize the current dedup state. Suitable for JSON.stringify and
   * persisting to sessionStorage. Only entries within the current window are
   * exported (older entries would be admitted anyway).
   */
  toJSON(): RealtimeDedupSnapshot {
    const now = Date.now();
    const entries: Array<[string, number]> = [];
    for (const [k, ts] of this.seen) {
      if (now - ts < this.windowMs) entries.push([k, ts]);
    }
    // Cap to maxSize newest entries to avoid blowing up sessionStorage.
    if (entries.length > this.maxSize) {
      entries.sort((a, b) => b[1] - a[1]);
      entries.length = this.maxSize;
    }
    return { entries, windowMs: this.windowMs };
  }

  /**
   * Restore previously serialized entries. Replaces any existing state.
   * Entries already past the current window are skipped.
   */
  fromJSON(snapshot: RealtimeDedupSnapshot | null | undefined): void {
    this.seen.clear();
    if (!snapshot || !Array.isArray(snapshot.entries)) return;
    const now = Date.now();
    for (const [k, ts] of snapshot.entries) {
      if (typeof k !== "string" || typeof ts !== "number") continue;
      if (now - ts >= this.windowMs) continue;
      this.seen.set(k, ts);
    }
  }
}

/** Convenience factory keyed by tx_hash. */
export function createActivityDedup() {
  return new RealtimeDedup<{ tx_hash?: string }>({
    keyFn: (row) => row.tx_hash ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by invoice_id. */
export function createInvoiceDedup() {
  return new RealtimeDedup<{ invoice_id?: string }>({
    keyFn: (row) => row.invoice_id ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by escrow_id. */
export function createEscrowDedup() {
  return new RealtimeDedup<{ escrow_id?: string }>({
    keyFn: (row) => row.escrow_id ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by request_id. */
export function createPaymentRequestDedup() {
  return new RealtimeDedup<{ request_id?: string }>({
    keyFn: (row) => row.request_id ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by offer_id. */
export function createExchangeOfferDedup() {
  return new RealtimeDedup<{ offer_id?: string }>({
    keyFn: (row) => row.offer_id ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by expense_id. */
export function createGroupExpenseDedup() {
  return new RealtimeDedup<{ expense_id?: string }>({
    keyFn: (row) => row.expense_id ?? null,
    windowMs: 30_000,
  });
}

/** Convenience factory keyed by primary `id` (for tables without a domain ID). */
export function createIdDedup() {
  return new RealtimeDedup<{ id?: string | number }>({
    keyFn: (row) => (row.id != null ? String(row.id) : null),
    windowMs: 30_000,
  });
}
