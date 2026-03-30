import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./constants";

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
  created_at: string;
  updated_at: string;
}

export interface GroupMembershipRow {
  id: string;
  group_id: number;
  group_name: string;
  member_address: string;
  is_admin: boolean;
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
  created_at: string;
  updated_at: string;
}

export interface CreatorSupporterRow {
  id: string;
  creator_address: string;
  supporter_address: string;
  message: string;
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
  created_at: string;
}

export interface ContactRow {
  id: string;
  owner_address: string;
  contact_address: string;
  nickname: string;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════
//  RETRY WRAPPER
// ═══════════════════════════════════════════════════════════════════

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

export async function insertActivity(activity: Omit<ActivityRow, "id" | "created_at">) {
  if (!supabase) return;
  try {
    await withRetry(async () => {
      const { error } = await supabase!.from("activities").upsert(activity, { onConflict: "tx_hash" });
      if (error) throw error;
    });
  } catch (err) {
    console.warn("insertActivity:", err instanceof Error ? err.message : err);
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

export async function fetchActivities(address: string, limit = 50): Promise<ActivityRow[]> {
  if (!supabase) return [];
  try {
    return await withRetry(async () => {
      const { data, error } = await supabase!
        .from("activities")
        .select("*")
        .or(`user_from.eq.${address},user_to.eq.${address}`)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    });
  } catch (err) {
    console.warn("fetchActivities:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PAYMENT REQUESTS
// ═══════════════════════════════════════════════════════════════════

export async function insertPaymentRequest(request: Omit<PaymentRequestRow, "id" | "created_at" | "updated_at">) {
  if (!supabase) return;
  try {
    await withRetry(async () => {
      const { error } = await supabase!.from("payment_requests").insert(request);
      if (error) throw error;
    });
  } catch (err) {
    console.warn("insertPaymentRequest:", err instanceof Error ? err.message : err);
  }
}

export async function fetchIncomingRequests(address: string): Promise<PaymentRequestRow[]> {
  if (!supabase) return [];
  // Incoming = requests where I am asked to pay (from_address = me means I owe)
  // Actually: from_address is the PAYER. If someone requests money FROM me, from_address = my address
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("from_address", address) // I am the payer
    .eq("status", "pending")
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
    .eq("to_address", address) // I created the request
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
  if (!supabase) return;
  const { error } = await supabase.from("group_memberships").upsert(membership, { onConflict: "group_id,member_address" });
  if (error) console.warn("insertGroupMembership:", error.message);
}

export async function fetchUserGroups(address: string): Promise<GroupMembershipRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("group_memberships")
    .select("*")
    .eq("member_address", address)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchUserGroups:", error.message); return []; }
  return data || [];
}

export async function insertGroupExpense(expense: Omit<GroupExpenseRow, "id" | "created_at">) {
  if (!supabase) return;
  const { error } = await supabase.from("group_expenses").insert(expense);
  if (error) console.warn("insertGroupExpense:", error.message);
}

export async function fetchGroupExpenses(groupId: number): Promise<GroupExpenseRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("group_expenses")
    .select("*")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchGroupExpenses:", error.message); return []; }
  return data || [];
}

// ═══════════════════════════════════════════════════════════════════
//  CREATORS
// ═══════════════════════════════════════════════════════════════════

export async function upsertCreatorProfile(profile: CreatorProfileRow) {
  if (!supabase) return;
  const { error } = await supabase.from("creator_profiles").upsert(profile);
  if (error) console.warn("upsertCreatorProfile:", error.message);
}

export async function fetchCreatorProfiles(): Promise<CreatorProfileRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("*")
    .eq("is_active", true)
    .order("supporter_count", { ascending: false });
  if (error) { console.warn("fetchCreatorProfiles:", error.message); return []; }
  return data || [];
}

export async function fetchCreatorProfile(address: string): Promise<CreatorProfileRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("*")
    .eq("address", address)
    .single();
  if (error) { console.warn("fetchCreatorProfile:", error.message); return null; }
  return data;
}

export async function insertCreatorSupporter(supporter: Omit<CreatorSupporterRow, "id" | "created_at">) {
  if (!supabase) return;
  const { error } = await supabase.from("creator_supporters").insert(supporter);
  if (error) console.warn("insertCreatorSupporter:", error.message);
}

export async function fetchCreatorSupporters(creatorAddress: string): Promise<CreatorSupporterRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("creator_supporters")
    .select("*")
    .eq("creator_address", creatorAddress)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchCreatorSupporters:", error.message); return []; }
  return data || [];
}

// ═══════════════════════════════════════════════════════════════════
//  INVOICES
// ═══════════════════════════════════════════════════════════════════

export async function insertInvoice(invoice: Omit<InvoiceRow, "id" | "created_at" | "updated_at">) {
  if (!supabase) return;
  const { error } = await supabase.from("invoices").insert(invoice);
  if (error) console.warn("insertInvoice:", error.message);
}

export async function fetchVendorInvoices(address: string): Promise<InvoiceRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("vendor_address", address)
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchVendorInvoices:", error.message); return []; }
  return data || [];
}

export async function fetchClientInvoices(address: string): Promise<InvoiceRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("client_address", address)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchClientInvoices:", error.message); return []; }
  return data || [];
}

export async function updateInvoiceStatus(txHash: string, status: "paid" | "cancelled" | "payment_pending") {
  if (!supabase) return;
  const { error } = await supabase.from("invoices").update({ status }).eq("tx_hash", txHash);
  if (error) console.warn("updateInvoiceStatus:", error.message);
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
    activity_type: "group_settlement",
    contract_address: settlement.contract_address,
    note: settlement.note,
    token_address: settlement.token_address,
    block_number: settlement.block_number,
  });
}

export async function insertEscrow(escrow: Omit<EscrowRow, "id" | "created_at" | "updated_at">) {
  if (!supabase) return;
  const { error } = await supabase.from("escrows").insert(escrow);
  if (error) console.warn("insertEscrow:", error.message);
}

export async function fetchUserEscrows(address: string): Promise<EscrowRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("escrows")
    .select("*")
    .or(`depositor_address.eq.${address},beneficiary_address.eq.${address}`)
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
  if (!supabase) return;
  const { error } = await supabase.from("exchange_offers").insert(offer);
  if (error) console.warn("insertExchangeOffer:", error.message);
}

export async function fetchActiveOffers(): Promise<ExchangeOfferRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("exchange_offers")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) { console.warn("fetchActiveOffers:", error.message); return []; }
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
    .eq("owner_address", ownerAddress)
    .order("nickname", { ascending: true });
  if (error) { console.warn("fetchContacts:", error.message); return []; }
  return data || [];
}

export async function upsertContact(contact: Omit<ContactRow, "id" | "created_at">) {
  if (!supabase) return;
  const { error } = await supabase.from("contacts").upsert(contact, { onConflict: "owner_address,contact_address" });
  if (error) console.warn("upsertContact:", error.message);
}

export async function deleteContact(ownerAddress: string, contactAddress: string) {
  if (!supabase) return;
  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("owner_address", ownerAddress)
    .eq("contact_address", contactAddress);
  if (error) console.warn("deleteContact:", error.message);
}
