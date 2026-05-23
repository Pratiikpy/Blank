import { useMemo } from "react";
import { useActivityFeed } from "./useActivityFeed";
import { useEffectiveAddress } from "./useEffectiveAddress";
import type { ActivityRow } from "@/lib/supabase";

// Wave 5 Block 4 — encrypted analytics (v1).
//
// Honest scope (per CLAUDE.md §D anti-half-baked rule):
//
//   What this v1 ships:
//     - Monthly event counts (sends, receives, invoices, etc.)
//     - Top counterparties by event count
//     - Category breakdown by event count
//     - CSV export of event log
//
//   What this v1 does NOT ship:
//     - Amount totals. Amounts are encrypted on-chain and per-row
//       decrypt-via-Privara is too slow for a 100-row aggregation
//       (3-8s per encrypt × 100 = 5-10min). Batch decrypt that lets
//       FHE.add aggregate before reveal ships in Wave 6 once Privara
//       supports it.
//
// Privacy: all data lives in the user's local activity-feed cache
// (which is IndexedDB-backed for the smart-wallet-aware feed). No
// amount values are pulled to compute anything — only event counts
// and counterparty handles. Blank backend never sees aggregation
// queries; everything is client-side over already-cached rows.

export interface MonthlyBucket {
  yyyymm: number;       // 202611
  yearMonth: string;    // "2026-11"
  sent: number;
  received: number;
  total: number;
}

export interface CounterpartyAggregate {
  address: string;
  isSender: number;   // count where I received from this address
  isReceiver: number; // count where I sent to this address
  total: number;
}

export interface CategoryAggregate {
  category: string;
  count: number;
}

export interface InsightsSnapshot {
  totalEvents: number;
  sent: number;
  received: number;
  monthly: MonthlyBucket[];
  counterparties: CounterpartyAggregate[];
  categories: CategoryAggregate[];
  /** Rows grouped by yyyymm key for the export path. */
  byMonth: Map<string, ActivityRow[]>;
}

// CLAUDE.md §writing-voice scope rule: no marketing labels. Use short
// inferred category names from the activity_type slug.
const CATEGORY_MAP: Record<string, string> = {
  // Sends
  payment_sent: "Payments",
  payment_received: "Payments",
  send: "Payments",
  group_split: "Group",
  group_settle: "Group",
  // Invoices
  invoice_created: "Invoices",
  invoice_paid: "Invoices",
  invoice_refunded: "Invoices",
  // Gifts
  gift_created: "Gifts",
  gift_claimed: "Gifts",
  // Claim links
  claim_link_created: "Claim Links",
  claim_link_claimed: "Claim Links",
  claim_link_refunded: "Claim Links",
  // Escrow
  escrow_created: "Escrow",
  escrow_released: "Escrow",
  escrow_refunded: "Escrow",
  escrow_disputed: "Escrow",
  // Storefront
  listing_bought: "Storefront",
  listing_bid: "Storefront",
  listing_refunded: "Storefront",
  // Crowdfund
  crowdfund_contributed: "Crowdfund",
  crowdfund_refunded: "Crowdfund",
  crowdfund_claimed: "Crowdfund",
  // Stealth
  stealth_sent: "Stealth",
  stealth_received: "Stealth",
  // Tip / creator
  tip_sent: "Creator support",
  tip_received: "Creator support",
  // Wave 5 offramp
  offramp_offer_created: "Offramp",
  offramp_fill_locked: "Offramp",
  offramp_proof_submitted: "Offramp",
  offramp_released: "Offramp",
  offramp_disputed: "Offramp",
  offramp_resolved_taker: "Offramp",
  offramp_resolved_maker: "Offramp",
  offramp_expired: "Offramp",
};

function categoryFor(activityType: string): string {
  return CATEGORY_MAP[activityType] ?? "Other";
}

function yyyymmFromIso(iso: string): { yyyymm: number; yearMonth: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { yyyymm: 0, yearMonth: "unknown" };
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return {
    yyyymm: y * 100 + m,
    yearMonth: `${y}-${String(m).padStart(2, "0")}`,
  };
}

export function useEncryptedAnalytics() {
  const { effectiveAddress } = useEffectiveAddress();
  const feed = useActivityFeed();

  const snapshot: InsightsSnapshot = useMemo(() => {
    const address = effectiveAddress?.toLowerCase() ?? "";
    const monthlyMap = new Map<number, MonthlyBucket>();
    const cpMap = new Map<string, CounterpartyAggregate>();
    const catMap = new Map<string, CategoryAggregate>();
    const byMonth = new Map<string, ActivityRow[]>();

    let sent = 0;
    let received = 0;

    for (const row of feed.activities) {
      const from = (row.user_from ?? "").toLowerCase();
      const to = (row.user_to ?? "").toLowerCase();
      const iAmSender = from === address;
      const iAmReceiver = to === address;
      if (!iAmSender && !iAmReceiver) continue; // skip rows where I'm neither party

      const { yyyymm, yearMonth } = yyyymmFromIso(row.created_at);

      // Monthly bucket
      const mb =
        monthlyMap.get(yyyymm) ??
        { yyyymm, yearMonth, sent: 0, received: 0, total: 0 };
      if (iAmSender) {
        mb.sent += 1;
        sent += 1;
      }
      if (iAmReceiver) {
        mb.received += 1;
        received += 1;
      }
      mb.total += 1;
      monthlyMap.set(yyyymm, mb);

      // Counterparty bucket (the other side)
      const counterparty =
        iAmSender ? to :
        iAmReceiver ? from :
        "";
      if (counterparty && counterparty !== address && counterparty !== "0x0000000000000000000000000000000000000000") {
        const cp =
          cpMap.get(counterparty) ??
          { address: counterparty, isSender: 0, isReceiver: 0, total: 0 };
        if (iAmReceiver) cp.isSender += 1;
        if (iAmSender) cp.isReceiver += 1;
        cp.total += 1;
        cpMap.set(counterparty, cp);
      }

      // Category
      const cat = categoryFor(row.activity_type);
      const ce = catMap.get(cat) ?? { category: cat, count: 0 };
      ce.count += 1;
      catMap.set(cat, ce);

      // By-month export bucket
      const bucket = byMonth.get(yearMonth) ?? [];
      bucket.push(row);
      byMonth.set(yearMonth, bucket);
    }

    const monthly = Array.from(monthlyMap.values()).sort((a, b) => b.yyyymm - a.yyyymm);
    const counterparties = Array.from(cpMap.values()).sort((a, b) => b.total - a.total);
    const categories = Array.from(catMap.values()).sort((a, b) => b.count - a.count);

    return {
      totalEvents: sent + received,
      sent,
      received,
      monthly,
      counterparties,
      categories,
      byMonth,
    };
  }, [feed.activities, effectiveAddress]);

  const csv = useMemo(() => {
    // CSV columns chosen to be operator-friendly: timestamp, direction,
    // counterparty (truncated for readability), category, activity_type,
    // tx_hash, chain_id, note. Amounts deliberately excluded.
    const rows = [
      [
        "timestamp_utc", "direction", "counterparty",
        "category", "activity_type", "tx_hash", "chain_id", "note",
      ],
    ];
    const address = effectiveAddress?.toLowerCase() ?? "";
    for (const row of snapshot.byMonth.size ? [...snapshot.byMonth.values()].flat() : []) {
      const from = (row.user_from ?? "").toLowerCase();
      const to = (row.user_to ?? "").toLowerCase();
      const direction = from === address ? "sent" : to === address ? "received" : "other";
      const cp = direction === "sent" ? to : from;
      rows.push([
        row.created_at,
        direction,
        cp,
        categoryFor(row.activity_type),
        row.activity_type,
        row.tx_hash,
        String(row.chain_id ?? ""),
        (row.note ?? "").replace(/[\n,]/g, " ").slice(0, 200),
      ]);
    }
    return rows
      .map((r) => r.map((c) => (/["\n,]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
  }, [snapshot, effectiveAddress]);

  return {
    snapshot,
    csv,
    isLoading: feed.isLoading,
    isOffline: feed.isOffline,
  };
}
