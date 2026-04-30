import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPPORTED_CHAIN_ID } from "./constants";
import { ACTIVITY_TYPES } from "./activity-types";

// Reactive chain id for activity inserts. ChainProvider keeps this in sync
// via setSupabaseActiveChain() so rows written after a reload-free chain
// switch carry the correct chain_id. Fallback is the module-load value.
let _activeChainIdForSupabase: number = SUPPORTED_CHAIN_ID;
export function setSupabaseActiveChain(id: number) {
  _activeChainIdForSupabase = id;
}

// ═══════════════════════════════════════════════════════════════════
//  CLIENT
// ═══════════════════════════════════════════════════════════════════

export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// Warn if running without Supabase
if (!supabase) {
  console.warn("[Blank] Running in offline mode — Supabase not configured. Activities, requests, and groups will not sync.");
}

export function isOfflineMode(): boolean {
  return supabase === null;
}

// ═══════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ActivityRow {
  id: string;
  tx_hash: string;
  user_from: string;
  user_to: string;
  activity_type: string;
  contract_address: string;
  note: string;
  token_address: string;
  block_number: number;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

export interface PaymentRequestRow {
  id: string;
  request_id: number;
  /** The PAYER — the person who owes / will send money */
  from_address: string;
  /** The REQUESTER — the person who created the request and wants money */
  to_address: string;
  token_address: string;
  note: string;
  status: "pending" | "fulfilled" | "cancelled";
  tx_hash: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  /** Optional email of the payer. Phase 1.3 sends a request email when set. */
  payer_email?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMembershipRow {
  id: string;
  group_id: number;
  group_name: string;
  member_address: string;
  is_admin: boolean;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

export interface GroupExpenseRow {
  id: string;
  group_id: number;
  expense_id: number;
  payer_address: string;
  description: string;
  member_count: number;
  tx_hash: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

export interface CreatorProfileRow {
  address: string;
  name: string;
  bio: string;
  avatar_url: string;
  tier1_threshold: number;
  tier2_threshold: number;
  tier3_threshold: number;
  supporter_count: number;
  is_active: boolean;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
  updated_at: string;
}

export interface CreatorSupporterRow {
  id: string;
  creator_address: string;
  supporter_address: string;
  message: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

export interface InvoiceRow {
  id: string;
  invoice_id: number;
  vendor_address: string;
  client_address: string;
  description: string;
  due_date: string | null;
  status: "pending" | "paid" | "cancelled" | "payment_pending" | "disputed";
  tx_hash: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  /** IPFS CID of the rendered invoice PDF. Populated async after invoice
   *  creation via Phase 1.1 (renderAndPinInvoicePdf). NULL on legacy rows
   *  written before the column existed. */
  pdf_cid?: string | null;
  /** Optional email of the client (recipient). Phase 1.3 sends a
   *  transactional invoice email when present. NEVER on-chain. */
  client_email?: string | null;
  /** Optional email of the vendor (creator). Used as Reply-To. */
  vendor_email?: string | null;
  /** Timestamp of the last reminder fired by /api/cron/invoice-reminders.
   *  Used to dedupe within 22h windows. NULL = never reminded. */
  last_reminder_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EscrowRow {
  id: string;
  escrow_id: number;
  depositor_address: string;
  beneficiary_address: string;
  arbiter_address: string;
  description: string;
  plaintext_amount?: number;
  deadline: string | null;
  status: "active" | "released" | "disputed" | "expired";
  tx_hash: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  /** IPFS CID of an attached project file (brief, contract, deliverable).
   *  Populated by Phase 3.4 escrow flow; NULL on legacy rows. */
  attachment_cid?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExchangeOfferRow {
  id: string;
  offer_id: number;
  maker_address: string;
  token_give: string;
  token_want: string;
  amount_give: number;
  amount_want: number;
  expiry: string | null;
  status: "active" | "filled" | "cancelled";
  taker_address: string;
  tx_hash: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

export interface ContactRow {
  id: string;
  owner_address: string;
  contact_address: string;
  nickname: string;
  /** Optional for backwards compat with rows written before the chain_id column existed. */
  chain_id?: number;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════
//  RETRY WRAPPER
// ═══════════════════════════════════════════════════════════════════

// Production schema drift: several tables (activities, payment_requests,
// invoices, escrows…) live in production with fewer columns than the
// TypeScript types declare. Inserts that include a column the live schema
// lacks fail with PGRST204 ("Could not find the 'X' column of 'Y' in the
// schema cache"). Previously every insert helper warned to console and
// dropped the row, so on-chain actions silently lost their Supabase mirror.
//
// `insertWithSchemaStrip` retries the insert without any columns the
// server says are missing, caches the dropped columns per-table so we
// don't keep wasting round-trips, and returns the final result. Once the
// migration runs and the column exists, the cache stops dropping it on
// the next page-load.
const _missingColsByTable = new Map<string, Set<string>>();

function stripMissingCols<T extends Record<string, unknown>>(table: string, row: T): T {
  const missing = _missingColsByTable.get(table);
  if (!missing || missing.size === 0) return row;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (!missing.has(k)) out[k] = row[k];
  return out as T;
}

function recordMissingCol(table: string, col: string) {
  if (!_missingColsByTable.has(table)) _missingColsByTable.set(table, new Set());
  _missingColsByTable.get(table)!.add(col);
}

function parseMissingColFromError(msg: string): string | null {
  // PostgREST error format: "Could not find the 'X' column of 'Y' in the schema cache"
  const m = msg.match(/find the '([^']+)' column of/);
  return m ? m[1] : null;
}

export async function insertWithSchemaStrip(
  table: string,
  row: Record<string, unknown>,
  options?: { onConflict?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: "supabase not configured" };

  // Up to 5 strip-and-retry passes — protects against multi-column drift
  // (e.g. invoices table missing client_email + pdf_cid + vendor_email).
  let attempts = 0;
  while (attempts < 6) {
    attempts++;
    const stripped = stripMissingCols(table, row);
    try {
      // Use upsert when the caller specified a conflict target; else insert.
      const q = options?.onConflict
        ? supabase.from(table).upsert(stripped, { onConflict: options.onConflict })
        : supabase.from(table).insert(stripped);
      const { error } = await q;
      if (!error) return { ok: true };
      const errAny = error as { message?: string; code?: string };
      const msg = errAny.message ?? JSON.stringify(error);
      const code = errAny.code ?? "";
      if (code === "PGRST204" || /schema cache/i.test(msg)) {
        const missing = parseMissingColFromError(msg);
        if (!missing) {
          // Couldn't extract the column name — give up rather than loop.
          return { ok: false, error: msg };
        }
        if (!(missing in stripped)) {
          // Column wasn't in the request body — something else is wrong;
          // don't loop.
          return { ok: false, error: msg };
        }
        recordMissingCol(table, missing);
        continue; // retry with stripped row
      }
      return { ok: false, error: msg };
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      return { ok: false, error: msg };
    }
  }
  return { ok: false, error: `gave up after ${attempts} schema-strip retries` };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error("Unreachable");
}

// ═══════════════════════════════════════════════════════════════════
//  ACTIVITIES
// ═══════════════════════════════════════════════════════════════════

// Module-level cache for activities.chain_id column presence.
//
// null = not probed yet (we'll discover on first read/write, or via
//        explicit probe below)
// true = column exists (filters + inserts include it)
// false = column missing (PGRST204 fallback path; legacy behaviour)
//
// Re-evaluated per-page-load so a schema migration is picked up without
// code changes. Audit Top-28 #5 needs this to be `true` in production —
// the migration `ALTER TABLE activities ADD COLUMN chain_id INT` enables
// the cross-chain isolation filter on reads.
let _activitiesHasChainId: boolean | null = null;

// Probe promise that all fetch/insert callers await before firing — without
// this, the first dozen parallel fetches all race past the probe with
// `_activitiesHasChainId = null` and each independently fails 400. Awaiting
// the same promise coalesces them: only the probe hits the wire; consumers
// pick up the cached flag.
// Persist the probe result so we don't 400 the activities endpoint on
// every page-load. The schema migration is a manual step the operator
// runs once; after that, clearing this localStorage key (or running for
// 7 days, see TTL below) re-probes and picks up the change.
const PROBE_STORAGE_KEY = "blank:activities_has_chain_id";
const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function readCachedProbe(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PROBE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v: boolean; t: number };
    if (Date.now() - parsed.t > PROBE_TTL_MS) {
      localStorage.removeItem(PROBE_STORAGE_KEY);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function writeCachedProbe(v: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify({ v, t: Date.now() }));
  } catch {
    /* noop — quota or disabled */
  }
}

const _activitiesChainIdProbe: Promise<void> = (async () => {
  if (!supabase) {
    _activitiesHasChainId = false;
    return;
  }
  // Use cached value if fresh — avoids a 400 on every page-load when the
  // column is missing.
  const cached = readCachedProbe();
  if (cached !== null) {
    _activitiesHasChainId = cached;
    return;
  }
  try {
    // Probe by selecting a row with all columns (`*`) — never 400s if
    // the table exists at all, and the response shape tells us whether
    // chain_id is present. We pick limit=1 + a definitely-non-matching
    // filter so we don't pull real data, just learn the column shape.
    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .limit(1);
    if (error) {
      _activitiesHasChainId = false;
      writeCachedProbe(false);
      return;
    }
    // If the table is empty, `data` is [] — we can't tell shape. Default
    // to false in that case (safe; first real insert will probe via the
    // existing PGRST204 fallback path in insertActivity).
    if (!data || data.length === 0) {
      _activitiesHasChainId = false;
      writeCachedProbe(false);
      return;
    }
    const has = Object.prototype.hasOwnProperty.call(data[0], "chain_id");
    _activitiesHasChainId = has;
    writeCachedProbe(has);
  } catch {
    _activitiesHasChainId = false;
    writeCachedProbe(false);
  }
})();

export async function insertActivity(activity: Omit<ActivityRow, "id" | "created_at">) {
  if (!supabase) return;
  // Wait for the chain_id-column probe so we send the right shape on the
  // very first insert. Without this, parallel inserts at app startup all
  // race past the probe and each independently bounces off PGRST204.
  await _activitiesChainIdProbe;
  // Build the row both with and without chain_id so we can fall back fast.
  const baseRow = {
    ...activity,
  };
  const rowWithChainId = {
    ...baseRow,
    chain_id: activity.chain_id ?? _activeChainIdForSupabase,
  };

  try {
    await withRetry(async () => {
      // Treat null (unprobed) as optimistic — try with chain_id; the
      // catch below falls back if the column is missing.
      const row = _activitiesHasChainId === false ? baseRow : rowWithChainId;
      const { error } = await supabase!.from("activities").upsert(row, { onConflict: "tx_hash" });
      if (error) throw error;
      if (_activitiesHasChainId === null) _activitiesHasChainId = true;
    });
  } catch (err) {
    // Supabase throws PostgrestError plain objects, not Error instances.
    // `err.message` / `err.code` are the canonical fields. Stringify as a
    // backstop so we always have something to grep.
    const errObj = err as { message?: string; code?: string } | undefined;
    const msg = errObj?.message ?? (err instanceof Error ? err.message : JSON.stringify(err));
    const code = errObj?.code ?? "";
    console.warn("[insertActivity] caught error", { code, msg, raw: err });
    // R3 #229 follow-up: prod Supabase schema lacks `chain_id` on
    // `activities`. Cache the discovery + retry without it. Once the
    // migration runs, this fallback never trips.
    if (
      _activitiesHasChainId !== false &&
      (code === "PGRST204" || msg.includes("PGRST204") || /chain_id.*schema cache/i.test(msg))
    ) {
      _activitiesHasChainId = false;
      console.warn(
        "[supabase] activities.chain_id column missing — disabling chain_id on inserts. " +
          "Run a SQL migration `ALTER TABLE activities ADD COLUMN chain_id INT` to fix.",
      );
      try {
        await withRetry(async () => {
          const { error } = await supabase!
            .from("activities")
            .upsert(baseRow, { onConflict: "tx_hash" });
          if (error) throw error;
        });
        return;
      } catch (retryErr) {
        console.warn(
          "insertActivity retry without chain_id failed:",
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
        return;
      }
    }
    console.warn("insertActivity:", msg);
  }
}

export async function fetchActivityById(id: string): Promise<ActivityRow | null> {
  if (!supabase) return null;
  try {
    return await withRetry(async () => {
      const { data, error } = await supabase!
        .from("activities")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    });
  } catch (err) {
    console.warn("fetchActivityById:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Activity rows that mention a specific invoice id, scoped to a chain.
 *
 * Used by InvoicePage to show the proof-of-payment panel: tx hashes,
 * timestamps, and the activity_type so we can render explorer links
 * for the funded / paid / refunded events the contract emitted.
 *
 * Implementation note: we filter by `note ILIKE '%invoice #X%'` because
 * that's the canonical phrase BusinessHub-related hooks (`payInvoice`,
 * `payInvoiceEscrow`, `releaseInvoiceEscrow`, `refundDisputedInvoice`)
 * use when writing activities. Storing the invoice id as a structured
 * field would be the better long-term fix, but it'd require a schema
 * migration; for now this is the smallest correct version.
 */
export async function fetchInvoiceActivities(
  chainId: number,
  invoiceId: number,
): Promise<ActivityRow[]> {
  if (!supabase) return [];
  try {
    return await withRetry(async () => {
      // Two phrase shapes are written by hooks:
      //   "Paid invoice #N", "Cancelled invoice #N", "invoice_refunded"  → useBusinessHub
      //   "Funded escrow for invoice #N"                                  → useInvoiceEscrow.payEscrow
      //   "Released escrow #N to vendor", "Refunded escrow #N (...)"      → useInvoiceEscrow.releaseEscrow
      // Server-side ilike does a coarse match; client-side regex pins it
      // to the exact id (so #1 doesn't match #10).
      const phrase = `#${invoiceId}`;
      let q = supabase!
        .from("activities")
        .select("*")
        .ilike("note", `%${phrase}%`)
        .order("created_at", { ascending: true });
      if (_activitiesHasChainId === true) {
        q = q.eq("chain_id", chainId);
      }
      const { data, error } = await q;
      if (error) throw error;
      // Match either "invoice #N" or "escrow #N" with a trailing boundary.
      const exact = new RegExp(`(invoice|escrow) #${invoiceId}\\b`, "i");
      return (data ?? []).filter((row) => exact.test(row.note ?? ""));
    });
  } catch (err) {
    console.warn("fetchInvoiceActivities:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Return all `heir_set` activities where this address is the heir (user_to).
 * Used by "Plans naming you" so an heir can discover plans that designate
 * them without asking the principal for their address.
 */
export async function fetchHeirAssignments(heirAddress: string): Promise<ActivityRow[]> {
  if (!supabase) return [];
  const lower = heirAddress.toLowerCase();
  try {
    return await withRetry(async () => {
      const { data, error } = await supabase!
        .from("activities")
        .select("*")
        .eq("activity_type", ACTIVITY_TYPES.INHERITANCE_HEIR_SET)
        .eq("user_to", lower)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    });
  } catch (err) {
    console.warn("fetchHeirAssignments:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch recent activities touching one or more addresses.
 *
 * #190: smart-wallet users have TWO addresses (EOA + AA). Callers that pass
 * an array — typically `[effectiveAddress, eoa]` — get rows where either
 * address appears as user_from or user_to. Passing a single string preserves
 * the original single-address behaviour for non-AA callers.
 *
 * Audit Top-28 #5: chainId prevents cross-chain data leak when the schema
 * supports it. Production Supabase currently lacks `chain_id` on the
 * activities table (R3 #229 follow-up); inserts gate this behind
 * `_activitiesHasChainId` and the same gate is applied here. Once the
 * `ALTER TABLE activities ADD COLUMN chain_id INT` migration runs, the
 * flag flips true on the next successful insert and reads will start
 * filtering. Until then we degrade to the legacy unfiltered query — the
 * cross-chain leak stays open until the migration lands, but at least the
 * page doesn't 400 on every fetch.
 */
export async function fetchActivities(
  addressOrAddresses: string | string[],
  limit = 50,
  beforeCreatedAt?: string, // ISO timestamp cursor
  chainId?: number,
): Promise<ActivityRow[]> {
  if (!supabase) return [];
  // Coalesce all parallel fetchActivities callers behind one probe so the
  // chain_id filter shape is decided once per page-load rather than racing.
  await _activitiesChainIdProbe;

  const addrs = (Array.isArray(addressOrAddresses)
    ? addressOrAddresses
    : [addressOrAddresses]
  )
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .map((a) => a.toLowerCase());

  // Dedupe in case a caller accidentally passes the same address twice
  // (e.g. smart-account not active → EOA == effectiveAddress).
  const unique = Array.from(new Set(addrs));
  if (unique.length === 0) return [];

  const addressFilter = unique
    .flatMap((a) => [`user_from.eq.${a}`, `user_to.eq.${a}`])
    .join(",");

  const tryFetch = async (includeChainFilter: boolean): Promise<ActivityRow[]> => {
    return await withRetry(async () => {
      let q = supabase!
        .from("activities")
        .select("*")
        .or(addressFilter)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (includeChainFilter && typeof chainId === "number") {
        // Match rows on this chain plus any legacy rows lacking chain_id.
        q = q.or(`chain_id.eq.${chainId},chain_id.is.null`);
      }
      if (beforeCreatedAt) q = q.lt("created_at", beforeCreatedAt);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    });
  };

  try {
    // Optimistic: when the probe hasn't completed yet (null), assume the
    // column exists. The catch below corrects this if it doesn't.
    const result = await tryFetch(_activitiesHasChainId !== false);
    if (_activitiesHasChainId === null) _activitiesHasChainId = true;
    return result;
  } catch (err) {
    const errObj = err as { message?: string; code?: string } | undefined;
    const msg = errObj?.message ?? (err instanceof Error ? err.message : JSON.stringify(err));
    const code = errObj?.code ?? "";
    // PGRST204 / "schema cache" — chain_id column missing in prod schema.
    // Cache the discovery + retry without the filter (legacy behaviour).
    if (
      _activitiesHasChainId !== false &&
      (code === "PGRST204" || msg.includes("PGRST204") || /chain_id.*schema cache/i.test(msg))
    ) {
      _activitiesHasChainId = false;
      console.warn(
        "[supabase] activities.chain_id column missing — fetchActivities falling back to unfiltered. Run migration to enable cross-chain isolation.",
      );
      try {
        return await tryFetch(false);
      } catch (retryErr) {
        console.warn(
          "fetchActivities retry without chain_id failed:",
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
        return [];
      }
    }
    console.warn("fetchActivities:", msg);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PAYMENT REQUESTS
// ═══════════════════════════════════════════════════════════════════

export async function insertPaymentRequest(request: Omit<PaymentRequestRow, "id" | "created_at" | "updated_at">) {
  // Schema drift: prod lacks `payer_email`. Helper strips missing columns
  // and retries so on-chain-confirmed requests still land in Supabase.
  const result = await insertWithSchemaStrip("payment_requests", {
    ...request,
    chain_id: request.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertPaymentRequest:", result.error);
}

export async function fetchIncomingRequests(address: string): Promise<PaymentRequestRow[]> {
  if (!supabase) return [];
  // Incoming = requests where I am asked to pay (from_address = me means I owe)
  // Actually: from_address is the PAYER. If someone requests money FROM me, from_address = my address
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("from_address", address.toLowerCase()) // I am the payer
    .eq("status", "pending")
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchIncomingRequests:", error.message); return []; }
  return data || [];
}

export async function fetchOutgoingRequests(address: string): Promise<PaymentRequestRow[]> {
  if (!supabase) return [];
  // Outgoing = requests I created (to_address = me means I'm the requester)
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("to_address", address.toLowerCase()) // I created the request
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchOutgoingRequests:", error.message); return []; }
  return data || [];
}

export async function updateRequestStatus(requestId: string, status: "fulfilled" | "cancelled") {
  if (!supabase) return;
  const { error } = await supabase
    .from("payment_requests")
    .update({ status })
    .eq("request_id", requestId);
  if (error) console.warn("updateRequestStatus:", error.message);
}

// ═══════════════════════════════════════════════════════════════════
//  GROUPS
// ═══════════════════════════════════════════════════════════════════

export async function insertGroupMembership(membership: Omit<GroupMembershipRow, "id" | "created_at">) {
  // Normalize member_address to lowercase so fetchUserGroups (which uses
  // .eq(member_address, addr.toLowerCase())) matches. Same class of bug as
  // the invoice/payment-request lookups. Schema-strip helper covers any
  // missing columns.
  const result = await insertWithSchemaStrip(
    "group_memberships",
    {
      ...membership,
      member_address: membership.member_address.toLowerCase(),
      chain_id: membership.chain_id ?? _activeChainIdForSupabase,
    },
    { onConflict: "group_id,member_address" },
  );
  if (!result.ok) console.warn("insertGroupMembership:", result.error);
}

export async function fetchUserGroups(address: string): Promise<GroupMembershipRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("group_memberships")
    .select("*")
    .eq("member_address", address.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchUserGroups:", error.message); return []; }
  return data || [];
}

/**
 * Look up any membership row for a group_id. Returns null if not found.
 * Used by the "Join by ID" UI to discover a group's name and verify that
 * it exists before inserting a self-membership row.
 */
export async function fetchGroupById(groupId: number): Promise<GroupMembershipRow | null> {
  if (!supabase) return null;
  try {
    return await withRetry(async () => {
      const { data, error } = await supabase!
        .from("group_memberships")
        .select("*")
        .eq("group_id", groupId)
        .eq("chain_id", _activeChainIdForSupabase)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as GroupMembershipRow | null) ?? null;
    });
  } catch (err) {
    console.warn("fetchGroupById:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Insert a self-membership row so `fetchUserGroups(address)` starts returning
 * the group. UI-only: the contract function `joinGroup(uint256)` does NOT
 * exist yet, so there is no on-chain membership check. With open RLS this
 * lets any signer add themselves to any group row they can see.
 *
 * TODO (#83): gate this with a contract-side membership validation when
 * `joinGroup(uint256)` is deployed, or tighten RLS so only an admin can
 * insert a member row. Until then this is discovery-only for already-added
 * members or trusted environments.
 */
export async function addSelfToGroup(groupId: number, address: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    // Reuse an existing row for the group_name (and to verify existence)
    const existing = await fetchGroupById(groupId);
    if (!existing) return false;
    const row: Omit<GroupMembershipRow, "id" | "created_at"> = {
      group_id: groupId,
      group_name: existing.group_name,
      member_address: address.toLowerCase(),
      is_admin: false,
    };
    await insertGroupMembership(row);
    return true;
  } catch (err) {
    console.warn("addSelfToGroup:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function insertGroupExpense(expense: Omit<GroupExpenseRow, "id" | "created_at">) {
  const result = await insertWithSchemaStrip("group_expenses", {
    ...expense,
    chain_id: expense.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertGroupExpense:", result.error);
}

export async function fetchGroupExpenses(groupId: number): Promise<GroupExpenseRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("group_expenses")
    .select("*")
    .eq("group_id", groupId)
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchGroupExpenses:", error.message); return []; }
  return data || [];
}

// ═══════════════════════════════════════════════════════════════════
//  CREATORS
// ═══════════════════════════════════════════════════════════════════

export async function upsertCreatorProfile(profile: CreatorProfileRow) {
  // upsertCreatorProfile lacks a known unique constraint to target so we
  // pass undefined onConflict — schema-strip helper falls through to
  // .insert() which works because the supabase upsert default uses PK.
  // For now, mirror existing behavior + add column-strip protection.
  if (!supabase) return;
  const row = stripMissingCols("creator_profiles", {
    ...profile,
    chain_id: profile.chain_id ?? _activeChainIdForSupabase,
  });
  try {
    const { error } = await supabase.from("creator_profiles").upsert(row);
    if (error) {
      const code = (error as { code?: string }).code ?? "";
      const msg = error.message ?? "";
      if (code === "PGRST204" || /schema cache/i.test(msg)) {
        const missing = parseMissingColFromError(msg);
        if (missing) {
          recordMissingCol("creator_profiles", missing);
          // Retry once after recording — caller doesn't need exhaustive loop.
          const stripped = stripMissingCols("creator_profiles", row);
          const { error: e2 } = await supabase.from("creator_profiles").upsert(stripped);
          if (e2) console.warn("upsertCreatorProfile:", e2.message);
          return;
        }
      }
      console.warn("upsertCreatorProfile:", error.message);
    }
  } catch (err) {
    console.warn("upsertCreatorProfile:", err instanceof Error ? err.message : err);
  }
}

export async function fetchCreatorProfiles(): Promise<CreatorProfileRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("*")
    .eq("is_active", true)
    .eq("chain_id", _activeChainIdForSupabase)
    .order("supporter_count", { ascending: false });
  if (error) { console.warn("fetchCreatorProfiles:", error.message); return []; }
  return data || [];
}

export async function fetchCreatorProfile(address: string): Promise<CreatorProfileRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("*")
    .eq("address", address.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .single();
  if (error) { console.warn("fetchCreatorProfile:", error.message); return null; }
  return data;
}

/**
 * Recompute supporter_count on a creator's profile from the authoritative
 * creator_supporters rows.
 *
 * Previous read-modify-write increment silently no-oped when the profile row
 * didn't match on both address AND chain_id, and didn't backfill counts
 * from tips that happened before the column was maintained. Recomputing
 * from the source table is idempotent (safe to retry) and self-heals drift.
 */
export async function recomputeCreatorSupporterCount(creatorAddress: string) {
  if (!supabase) return;
  const { count, error: countErr } = await supabase
    .from("creator_supporters")
    .select("*", { count: "exact", head: true })
    .eq("creator_address", creatorAddress.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase);
  if (countErr) { console.warn("recomputeCreatorSupporterCount (count):", countErr.message); return; }
  const { error: updateErr } = await supabase
    .from("creator_profiles")
    .update({ supporter_count: count ?? 0 })
    .eq("address", creatorAddress.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase);
  if (updateErr) console.warn("recomputeCreatorSupporterCount (update):", updateErr.message);
}

export async function insertCreatorSupporter(supporter: Omit<CreatorSupporterRow, "id" | "created_at">) {
  const result = await insertWithSchemaStrip("creator_supporters", {
    ...supporter,
    creator_address: supporter.creator_address.toLowerCase(),
    supporter_address: supporter.supporter_address.toLowerCase(),
    chain_id: supporter.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertCreatorSupporter:", result.error);
}

export async function fetchCreatorSupporters(creatorAddress: string): Promise<CreatorSupporterRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("creator_supporters")
    .select("*")
    .eq("creator_address", creatorAddress.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchCreatorSupporters:", error.message); return []; }
  return data || [];
}

/** Fetch creators that I (the current user) have supported. */
export async function fetchMySupportedCreators(supporterAddress: string): Promise<CreatorSupporterRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("creator_supporters")
    .select("*")
    .eq("supporter_address", supporterAddress.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchMySupportedCreators:", error.message); return []; }
  return data || [];
}

// ═══════════════════════════════════════════════════════════════════
//  INVOICES
// ═══════════════════════════════════════════════════════════════════

export async function insertInvoice(invoice: Omit<InvoiceRow, "id" | "created_at" | "updated_at">) {
  // Normalize addresses to lowercase so later .eq() lookups by toLowerCase()
  // match (fetchClientInvoices / fetchVendorInvoices do this). Without this
  // a checksummed address passed through createInvoice writes a row the
  // client's Invoices tab can never find.
  // Schema drift: prod is missing pdf_cid, client_email, vendor_email,
  // last_reminder_at — helper strips them and retries.
  const result = await insertWithSchemaStrip("invoices", {
    ...invoice,
    vendor_address: invoice.vendor_address.toLowerCase(),
    client_address: invoice.client_address.toLowerCase(),
    tx_hash: invoice.tx_hash.toLowerCase(),
    chain_id: invoice.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertInvoice:", result.error);
}

export async function fetchVendorInvoices(address: string): Promise<InvoiceRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("vendor_address", address.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchVendorInvoices:", error.message); return []; }
  return data || [];
}

export async function fetchClientInvoices(address: string): Promise<InvoiceRow[]> {
  if (!supabase) return [];
  // Include "payment_pending" so the client can see in-flight invoices and
  // click Finalize — without this the row disappears between payInvoice and
  // payInvoiceFinalize and the client has no way to complete the transfer.
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("client_address", address.toLowerCase())
    .in("status", ["pending", "payment_pending"])
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchClientInvoices:", error.message); return []; }
  return data || [];
}

export async function updateInvoiceStatus(
  invoiceId: number,
  status: "paid" | "cancelled" | "payment_pending" | "refunded",
) {
  if (!supabase) return;
  // Match by invoice_id (stable key), not tx_hash. Callers used to pass the
  // current operation's tx_hash here, which never matched the row (the row's
  // tx_hash is the CREATE tx; pay/finalize/cancel each mint a distinct tx).
  // Result: status updates silently no-oped for months. Fixed by switching
  // the selector to the unique invoice_id.
  const { error } = await supabase
    .from("invoices")
    .update({ status })
    .eq("invoice_id", invoiceId);
  if (error) console.warn("updateInvoiceStatus:", error.message);
}

/** Persist the IPFS CID of the rendered invoice PDF. Best-effort: no-op
 *  when supabase is offline, logs (but does not throw) on error so the
 *  caller's main flow isn't disrupted by a Supabase hiccup. */
export async function setInvoicePdfCid(invoiceId: number, cid: string) {
  if (!supabase) return;
  const { error } = await supabase
    .from("invoices")
    .update({ pdf_cid: cid })
    .eq("invoice_id", invoiceId);
  if (error) console.warn("setInvoicePdfCid:", error.message);
}

/** Persist the IPFS CID of an escrow attachment (project brief, contract,
 *  deliverable file). Best-effort, same pattern as setInvoicePdfCid. */
export async function setEscrowAttachmentCid(escrowId: number, cid: string) {
  if (!supabase) return;
  const { error } = await supabase
    .from("escrows")
    .update({ attachment_cid: cid })
    .eq("escrow_id", escrowId);
  if (error) console.warn("setEscrowAttachmentCid:", error.message);
}

// ═══════════════════════════════════════════════════════════════════
//  ESCROWS
// ═══════════════════════════════════════════════════════════════════

export async function insertGroupSettlement(settlement: {
  tx_hash: string;
  user_from: string;
  user_to: string;
  group_id: number;
  note: string;
  contract_address: string;
  token_address: string;
  block_number: number;
}) {
  return insertActivity({
    tx_hash: settlement.tx_hash,
    user_from: settlement.user_from,
    user_to: settlement.user_to,
    activity_type: ACTIVITY_TYPES.GROUP_SETTLEMENT,
    contract_address: settlement.contract_address,
    note: settlement.note,
    token_address: settlement.token_address,
    block_number: settlement.block_number,
  });
}

export async function insertEscrow(escrow: Omit<EscrowRow, "id" | "created_at" | "updated_at">) {
  // Strip plaintext_amount — the Supabase schema doesn't include it (we
  // deliberately don't store plaintext amounts server-side for privacy).
  // Also lowercase addresses to match .eq(addr.toLowerCase()) lookups —
  // same class of bug as insertInvoice / insertGroupMembership.
  // Schema-drift helper covers any other missing columns (attachment_cid).
  const { plaintext_amount, ...rest } = escrow as EscrowRow & { plaintext_amount?: number };
  void plaintext_amount;
  const result = await insertWithSchemaStrip("escrows", {
    ...rest,
    depositor_address: escrow.depositor_address.toLowerCase(),
    beneficiary_address: escrow.beneficiary_address.toLowerCase(),
    arbiter_address: escrow.arbiter_address
      ? escrow.arbiter_address.toLowerCase()
      : escrow.arbiter_address,
    tx_hash: escrow.tx_hash.toLowerCase(),
    chain_id: escrow.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertEscrow:", result.error);
}

export async function fetchUserEscrows(address: string): Promise<EscrowRow[]> {
  if (!supabase) return [];
  const lower = address.toLowerCase();
  const { data, error } = await supabase
    .from("escrows")
    .select("*")
    .or(`depositor_address.eq.${lower},beneficiary_address.eq.${lower},arbiter_address.eq.${lower}`)
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchUserEscrows:", error.message); return []; }
  return data || [];
}

export async function updateEscrowStatus(escrowId: number, status: EscrowRow["status"]) {
  if (!supabase) return;
  const { error } = await supabase.from("escrows").update({ status }).eq("escrow_id", escrowId);
  if (error) console.warn("updateEscrowStatus:", error.message);
}

// ═══════════════════════════════════════════════════════════════════
//  P2P EXCHANGE
// ═══════════════════════════════════════════════════════════════════

export async function insertExchangeOffer(offer: Omit<ExchangeOfferRow, "id" | "created_at">) {
  const result = await insertWithSchemaStrip("exchange_offers", {
    ...offer,
    chain_id: offer.chain_id ?? _activeChainIdForSupabase,
  });
  if (!result.ok) console.warn("insertExchangeOffer:", result.error);
}

export async function fetchActiveOffers(): Promise<ExchangeOfferRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("exchange_offers")
    .select("*")
    .eq("status", "active")
    .eq("chain_id", _activeChainIdForSupabase)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchActiveOffers:", error.message); return []; }
  return data || [];
}

// Filled offers where the user was either the maker or the taker.
// Used by the post-fill "Verify trade" UI in the P2PExchange screen.
export async function fetchFilledOffersForUser(userAddress: string): Promise<ExchangeOfferRow[]> {
  if (!supabase) return [];
  const lower = userAddress.toLowerCase();
  const { data, error } = await supabase
    .from("exchange_offers")
    .select("*")
    .eq("status", "filled")
    .eq("chain_id", _activeChainIdForSupabase)
    .or(`maker_address.eq.${lower},taker_address.eq.${lower}`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) { console.warn("fetchFilledOffersForUser:", error.message); return []; }
  return data || [];
}

export async function updateOfferStatus(offerId: number, status: "filled" | "cancelled", takerAddress?: string) {
  if (!supabase) return;
  const update: Record<string, unknown> = { status };
  if (takerAddress) update.taker_address = takerAddress;
  const { error } = await supabase.from("exchange_offers").update(update).eq("offer_id", offerId);
  if (error) console.warn("updateOfferStatus:", error.message);
}

// ═══════════════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════════════

export async function fetchContacts(ownerAddress: string): Promise<ContactRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("owner_address", ownerAddress.toLowerCase())
    .eq("chain_id", _activeChainIdForSupabase)
    .order("nickname", { ascending: true });
  if (error) { console.warn("fetchContacts:", error.message); return []; }
  return data || [];
}

export async function upsertContact(contact: Omit<ContactRow, "id" | "created_at">) {
  if (!supabase) return;
  const row = {
    ...contact,
    chain_id: contact.chain_id ?? _activeChainIdForSupabase,
  };
  const { error } = await supabase.from("contacts").upsert(row, { onConflict: "owner_address,contact_address" });
  if (error) console.warn("upsertContact:", error.message);
}

export async function deleteContact(ownerAddress: string, contactAddress: string) {
  if (!supabase) return;
  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("owner_address", ownerAddress.toLowerCase())
    .eq("contact_address", contactAddress.toLowerCase());
  if (error) console.warn("deleteContact:", error.message);
}
