/**
 * Typed activity-type constants.
 *
 * Every insertActivity call must use one of these. No string literals in
 * hooks. This lets TypeScript catch typos at compile time and lets the
 * notification formatter registry in `activity-messages.ts` be exhaustively
 * checked against this enum.
 *
 * Adding a new activity type:
 *   1. Add it here.
 *   2. Add a formatter in `activity-messages.ts`.
 *   3. TypeScript will fail the build if you forget either.
 */
export const ACTIVITY_TYPES = {
  // Simple payments
  PAYMENT: "payment",
  BATCH_PAYMENT: "batch_payment",
  AGENT_PAYMENT: "agent_payment",
  TIP: "tip",

  // Requests
  REQUEST_CREATED: "request_created",
  REQUEST_FULFILLED: "request_fulfilled",
  REQUEST_CANCELLED: "request_cancelled",

  // Gifts
  GIFT_CREATED: "gift_created",
  GIFT_CLAIMED: "gift_claimed",
  GIFT_DEACTIVATED: "gift_deactivated",
  GIFT_EXPIRY_CHANGED: "gift_expiry_changed",

  // Business (invoicing, payroll, escrow)
  PAYROLL: "payroll",
  INVOICE_CREATED: "invoice_created",
  INVOICE_PAYMENT: "invoice_payment",
  INVOICE_PAID: "invoice_paid",
  INVOICE_FINALIZED: "invoice_finalized",
  INVOICE_DISPUTED: "invoice_disputed",
  INVOICE_CANCELLED: "invoice_cancelled",
  ESCROW_CREATED: "escrow_created",
  ESCROW_ARBITER_NAMED: "escrow_arbiter_named",
  ESCROW_DELIVERED: "escrow_delivered",
  ESCROW_RELEASED: "escrow_released",
  ESCROW_DISPUTED: "escrow_disputed",
  ESCROW_EXPIRED: "escrow_expired",
  ESCROW_EXPIRED_CLAIMED: "escrow_expired_claimed",
  ESCROW_ARBITER_DECIDED: "escrow_arbiter_decided",
  ESCROW_RESOLVED: "escrow_resolved",

  // Groups
  GROUP_EXPENSE: "group_expense",
  GROUP_SETTLEMENT: "group_settlement",
  GROUP_VOTE: "group_vote",
  GROUP_LEFT: "group_left",
  GROUP_ARCHIVED: "group_archived",
  DEBT_SETTLED: "debt_settled",

  // Creators
  CREATOR_SUPPORT: "creator_support",
  CREATOR_PROFILE_UPDATED: "creator_profile_updated",

  // P2P exchange
  OFFER_CREATED: "offer_created",
  OFFER_FILLED: "offer_filled",
  OFFER_CANCELLED: "offer_cancelled",
  EXCHANGE_VERIFIED: "exchange_verified",
  EXCHANGE_INVALID: "exchange_invalid",

  // Stealth
  STEALTH_SENT: "stealth_sent",
  STEALTH_CLAIM_STARTED: "stealth_claim_started",
  STEALTH_CLAIMED: "stealth_claimed",

  // Shielding
  SHIELD: "shield",
  UNSHIELD: "unshield",
  UNSHIELD_CLAIM: "unshield_claim",
  MINT: "mint",

  // Privacy router swaps
  SWAP_INITIATED: "swap_initiated",
  SWAP_SETTLED: "swap_settled",
  SWAP_CANCELLED: "swap_cancelled",

  // Inheritance
  INHERITANCE_SET: "inheritance_set",
  INHERITANCE_HEIR_SET: "heir_set",
  INHERITANCE_HEIR_REMOVED: "inheritance_heir_removed",
  INHERITANCE_VAULTS_SET: "inheritance_vaults_set",
  INHERITANCE_PULSE: "heartbeat",
  INHERITANCE_CLAIM_STARTED: "inheritance_claim_started",
  INHERITANCE_CLAIM_CANCELLED: "inheritance_claim_cancelled",
  INHERITANCE_CLAIM_FINALIZED: "inheritance_claim_finalized",

  // Proofs
  PROOF_CREATED: "proof_created",
  PROOF_PUBLISHED: "proof_published",
} as const;

export type ActivityType = typeof ACTIVITY_TYPES[keyof typeof ACTIVITY_TYPES];

/** Runtime check that a string is a known activity type. */
export function isKnownActivityType(s: string): s is ActivityType {
  return Object.values(ACTIVITY_TYPES).includes(s as ActivityType);
}
