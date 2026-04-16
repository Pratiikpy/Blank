import { createContext, useContext, useEffect, useRef, useCallback, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import {
  RealtimeDedup,
  createActivityDedup,
  createInvoiceDedup,
  createEscrowDedup,
  createPaymentRequestDedup,
  createExchangeOfferDedup,
  createGroupExpenseDedup,
  createIdDedup,
} from "@/lib/realtime-dedup";

/**
 * Multiplexed Supabase realtime — ONE channel per address, fanning out
 * INSERT/UPDATE events to multiple subscribers. Frees us from the
 * free-tier concurrent-channel cap.
 *
 * Usage:
 *   const { subscribe } = useRealtime();
 *   useEffect(() => subscribe("activities", { filter: { column: "user_to", value: addr } }, (row) => {
 *     // row is the postgres_changes payload `.new`
 *   }), [subscribe, addr]);
 *
 * Subscribers can filter server-side (via the `filter` arg) AND
 * client-side (by inspecting the row they receive). Server-side filter
 * is a shorthand for `.on({ filter: "<col>=eq.<value>" })`.
 *
 * Dedup (#247): per-table — each table is deduped by its natural ID column
 * (tx_hash for activities, invoice_id for invoices, etc.) within a rolling
 * 30s window. Prevents a single insert event from firing the bus twice.
 *
 * Dedup persistence (#228): the per-table dedup state is persisted to
 * sessionStorage so it survives across long-lived sessions and channel
 * resubscribes within the same tab. Persistence is throttled to ~5s.
 */

type TableName =
  | "activities"
  | "payment_requests"
  | "invoices"
  | "escrows"
  | "exchange_offers"
  | "group_memberships"
  | "group_expenses"
  | "creator_supporters";

type Event = "INSERT" | "UPDATE" | "DELETE";

// Per-table dedup factory — keyed by each table's natural ID column.
function createDedupForTable(table: TableName): RealtimeDedup<Record<string, unknown>> {
  switch (table) {
    case "activities":
      return createActivityDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "invoices":
      return createInvoiceDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "escrows":
      return createEscrowDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "payment_requests":
      return createPaymentRequestDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "exchange_offers":
      return createExchangeOfferDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "group_expenses":
      return createGroupExpenseDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
    case "group_memberships":
    case "creator_supporters":
    default:
      return createIdDedup() as unknown as RealtimeDedup<Record<string, unknown>>;
  }
}

const ALL_TABLES: TableName[] = [
  "activities",
  "payment_requests",
  "invoices",
  "escrows",
  "exchange_offers",
  "group_memberships",
  "group_expenses",
  "creator_supporters",
];

const PERSIST_THROTTLE_MS = 5_000;

function dedupStorageKey(addrLower: string, chainId: number): string {
  return `blank:rt-dedup:${addrLower}:${chainId}`;
}

interface Filter {
  column: string;
  value: string;
}

interface Subscription {
  id: number;
  table: TableName;
  event: Event;
  filter?: Filter;
  handler: (row: Record<string, unknown>) => void;
}

interface RealtimeContextValue {
  subscribe: (
    table: TableName,
    opts: { event?: Event; filter?: Filter },
    handler: (row: Record<string, unknown>) => void,
  ) => () => void;
  /** Raw supabase client — escape hatch if a table isn't in TableName. */
  client: typeof supabase;
}

const Ctx = createContext<RealtimeContextValue | null>(null);

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRealtime must be used inside <RealtimeProvider>");
  return ctx;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const subsRef = useRef<Subscription[]>([]);
  const nextIdRef = useRef(1);
  // #247: per-table dedup so non-activity tables also get dedup'd.
  const dedupsRef = useRef<Map<TableName, RealtimeDedup<Record<string, unknown>>>>(new Map());

  // Single channel per (address, chain). Opens one multiplex subscription per
  // TableName we care about; handlers dispatch to registered subs.
  useEffect(() => {
    if (!supabase || !address) return;
    const addr = address.toLowerCase();
    const storageKey = dedupStorageKey(addr, activeChainId);

    // #247: instantiate one dedup per table.
    // #228: restore previous state from sessionStorage so dedup survives
    // long-lived sessions and channel resubscribes within the same tab.
    const dedups = new Map<TableName, RealtimeDedup<Record<string, unknown>>>();
    let restored: Record<string, unknown> | null = null;
    try {
      if (typeof window !== "undefined") {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw) restored = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      restored = null;
    }
    for (const t of ALL_TABLES) {
      const d = createDedupForTable(t);
      const snap = restored && typeof restored === "object" ? (restored as Record<string, unknown>)[t] : null;
      if (snap) {
        try { d.fromJSON(snap as never); } catch { /* ignore corrupt snapshot */ }
      }
      dedups.set(t, d);
    }
    dedupsRef.current = dedups;

    // #228: throttle persistence to avoid blocking the channel handler on
    // every accept(). flushPersist() reschedules itself after each call.
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersistAt = 0;
    const persistNow = () => {
      lastPersistAt = Date.now();
      try {
        if (typeof window === "undefined") return;
        const out: Record<string, unknown> = {};
        for (const [t, d] of dedupsRef.current.entries()) {
          out[t] = d.toJSON();
        }
        window.sessionStorage.setItem(storageKey, JSON.stringify(out));
      } catch {
        // sessionStorage may be unavailable / quota'd — best-effort.
      }
    };
    const schedulePersist = () => {
      if (persistTimer) return;
      const elapsed = Date.now() - lastPersistAt;
      const delay = Math.max(0, PERSIST_THROTTLE_MS - elapsed);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistNow();
      }, delay);
    };

    const channel = supabase.channel(`blank_realtime_${addr}_${activeChainId}`);

    for (const table of ALL_TABLES) {
      for (const event of ["INSERT", "UPDATE"] as Event[]) {
        channel.on(
          "postgres_changes",
          { event, schema: "public", table },
          (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
            const row = (payload.new ?? payload.old) as Record<string, unknown>;
            if (!row) return;
            // #247: per-table dedup. INSERT events on every table are deduped
            // by their natural ID; UPDATE events also pass through dedup so
            // back-to-back identical updates collapse.
            const dedup = dedupsRef.current.get(table);
            if (dedup && !dedup.accept(row)) return;
            // #228: persist after admit (throttled).
            schedulePersist();
            // Dispatch to interested subs
            for (const sub of subsRef.current) {
              if (sub.table !== table || sub.event !== event) continue;
              if (sub.filter) {
                const v = row[sub.filter.column];
                if (typeof v === "string") {
                  if (v.toLowerCase() !== sub.filter.value.toLowerCase()) continue;
                } else if (v !== sub.filter.value) continue;
              }
              try { sub.handler(row); } catch { /* sub shouldn't break bus */ }
            }
          },
        );
      }
    }

    channel.subscribe();

    return () => {
      supabase!.removeChannel(channel);
      // Keep subs registered — next mount re-attaches them.
      // #228: do NOT reset dedups or clear sessionStorage on resubscribe —
      // we want dedup state to survive teardown so a tab reconnect doesn't
      // re-fire events the user already saw.
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // Best-effort final flush so the latest accepts make it to storage.
      persistNow();
    };
  }, [address, activeChainId]);

  const subscribe = useCallback<RealtimeContextValue["subscribe"]>(
    (table, opts, handler) => {
      const id = nextIdRef.current++;
      const sub: Subscription = {
        id,
        table,
        event: opts.event ?? "INSERT",
        filter: opts.filter,
        handler,
      };
      subsRef.current.push(sub);
      return () => {
        subsRef.current = subsRef.current.filter((s) => s.id !== id);
      };
    },
    [],
  );

  return <Ctx.Provider value={{ subscribe, client: supabase }}>{children}</Ctx.Provider>;
}
