// Wave 5 Block 5 — notification event catalog.
//
// Mirror of WAVE5_PLAN.md §5.1 (12 event types). Each entry carries
// the channels the event SHOULD fire on. Block 5 wiring uses this
// catalog to look up handler logic + email-template name + push body
// formatter.

import { keccak256, toBytes } from "viem";

export type NotificationChannel = "push" | "email" | "bell";

export type NotificationEventType =
  | "invoice_paid"
  | "escrow_released"
  | "escrow_refunded"
  | "escrow_disputed"
  | "claim_link_consumed"
  | "gift_opened"
  | "heir_start_claim"
  | "heartbeat_overdue"
  | "recovery_approval_requested"
  | "offramp_offer_taken"
  | "offramp_proof_submitted"
  | "offramp_release";

export interface NotificationEventDef {
  type: NotificationEventType;
  channels: NotificationChannel[];
  /** Short human label for the in-app bell + push title. */
  label: string;
  /** Long-form body template; `{counterparty}` etc replaced by payload. */
  bodyTemplate: string;
}

export const NOTIFICATION_EVENTS: Record<NotificationEventType, NotificationEventDef> = {
  invoice_paid: {
    type: "invoice_paid",
    channels: ["push", "email", "bell"],
    label: "Invoice paid",
    bodyTemplate: "{counterparty} paid your invoice.",
  },
  escrow_released: {
    type: "escrow_released",
    channels: ["push", "bell"],
    label: "Escrow released",
    bodyTemplate: "Escrow #{ref} released. Funds delivered.",
  },
  escrow_refunded: {
    type: "escrow_refunded",
    channels: ["push", "bell"],
    label: "Escrow refunded",
    bodyTemplate: "Escrow #{ref} refunded.",
  },
  escrow_disputed: {
    type: "escrow_disputed",
    channels: ["push", "email"],
    label: "Escrow disputed",
    bodyTemplate: "Escrow #{ref} entered dispute. Arbiter will resolve.",
  },
  claim_link_consumed: {
    type: "claim_link_consumed",
    channels: ["push", "bell"],
    label: "Claim link used",
    bodyTemplate: "Your claim link was just consumed by {counterparty}.",
  },
  gift_opened: {
    type: "gift_opened",
    channels: ["push", "bell"],
    label: "Gift opened",
    bodyTemplate: "{counterparty} opened your gift.",
  },
  heir_start_claim: {
    type: "heir_start_claim",
    channels: ["push", "email"],
    label: "Heir started inheritance claim",
    bodyTemplate: "Your heir initiated the inheritance claim. Heartbeat within {graceDays} days to cancel.",
  },
  heartbeat_overdue: {
    type: "heartbeat_overdue",
    channels: ["push", "email"],
    label: "Heartbeat overdue",
    bodyTemplate: "Your inheritance heartbeat is due in {daysLeft} days. Visit /app/inheritance to ping.",
  },
  recovery_approval_requested: {
    type: "recovery_approval_requested",
    channels: ["push", "email"],
    label: "Recovery approval requested",
    bodyTemplate: "Guardian recovery requested for an account you protect. Review at /recover/{handle}.",
  },
  offramp_offer_taken: {
    type: "offramp_offer_taken",
    channels: ["push", "bell"],
    label: "Offer taken",
    bodyTemplate: "Your offramp offer #{ref} was taken. Wait for the taker's proof.",
  },
  offramp_proof_submitted: {
    type: "offramp_proof_submitted",
    channels: ["push", "bell"],
    label: "Proof submitted",
    bodyTemplate: "The taker on offramp fill #{ref} submitted a Reclaim proof. Dispute window open.",
  },
  offramp_release: {
    type: "offramp_release",
    channels: ["bell"],
    label: "Offramp released",
    bodyTemplate: "Offramp fill #{ref} released. USDC transferred to taker.",
  },
};

export const ALL_EVENT_TYPES = Object.keys(NOTIFICATION_EVENTS) as NotificationEventType[];

/**
 * Deterministic event id used as the unique key in the notifications
 * table. Re-emitting the same chain event lands the same key, so
 * Supabase `insert on conflict do nothing` dedupes naturally.
 */
export function buildEventId(args: {
  txHash: string;
  logIndex: number;
  eventType: NotificationEventType;
  handle: string;
}): string {
  const blob = `${args.txHash.toLowerCase()}|${args.logIndex}|${args.eventType}|${args.handle.toLowerCase()}`;
  return keccak256(toBytes(blob));
}

/**
 * Fill a body template with a key-value bag. Missing keys are kept as
 * `{name}` so debugging is easier.
 */
export function fillBody(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    if (k in vars) return String(vars[k]);
    return `{${k}}`;
  });
}
