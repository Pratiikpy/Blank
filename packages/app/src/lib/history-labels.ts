// Wave 4 task #246 — centralized History row formatting.
//
// History.tsx used to render rows as either the activity's free-text note
// OR a truncated address ("0x1234..."). That meant every row read like
// "0x1234 sent you 50 USDC" with no context about WHAT it was.
//
// This module provides:
//   - getHistoryLabel(type, isIncoming)  → headline ("Invoice paid", "Claim link sent")
//   - getHistorySubject(type, isIncoming) → side ("from"/"to"/"with") to use with the counterparty
//   - getHistoryIcon(type) → consistent icon + color per activity category
//
// The label is type-aware AND direction-aware: an "invoice_paid" event
// reads "Invoice paid" to the recipient and "Invoice paid by you" to
// the sender. Centralizing this keeps it consistent across History,
// notifications, and the transaction-detail screen.

import {
  ArrowDownLeft,
  ArrowLeftRight,
  Briefcase,
  Coins,
  FileText,
  Ghost,
  Gift,
  HandCoins,
  Heart,
  KeyRound,
  Link2,
  Megaphone,
  Receipt,
  Send,
  Shield,
  ShieldQuestion,
  ShoppingBag,
  Sparkles,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { ACTIVITY_TYPES, type ActivityType } from "./activity-types";

// ─── Headline label per type ──────────────────────────────────────────

interface LabelEntry {
  /** Headline shown on the row. May vary by direction. */
  in: string;
  out: string;
}

const LABELS: Record<ActivityType, LabelEntry> = {
  [ACTIVITY_TYPES.PAYMENT]:               { in: "Payment received",     out: "Payment sent" },
  [ACTIVITY_TYPES.BATCH_PAYMENT]:         { in: "Batch payment",        out: "Batch payment sent" },
  [ACTIVITY_TYPES.AGENT_PAYMENT]:         { in: "Agent payment",        out: "Agent payment sent" },
  [ACTIVITY_TYPES.TIP]:                   { in: "Tip received",         out: "Tip sent" },

  [ACTIVITY_TYPES.REQUEST_CREATED]:       { in: "Payment request",      out: "Payment requested" },
  [ACTIVITY_TYPES.REQUEST_FULFILLED]:     { in: "Request paid",         out: "You paid a request" },
  [ACTIVITY_TYPES.REQUEST_CANCELLED]:     { in: "Request cancelled",    out: "Request cancelled" },

  [ACTIVITY_TYPES.GIFT_CREATED]:          { in: "Gift received",        out: "Gift sent" },
  [ACTIVITY_TYPES.GIFT_CLAIMED]:          { in: "Gift opened",          out: "Recipient opened gift" },
  [ACTIVITY_TYPES.GIFT_DEACTIVATED]:      { in: "Gift cancelled",       out: "You cancelled a gift" },
  [ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED]:   { in: "Gift expiry updated",  out: "Gift expiry updated" },

  [ACTIVITY_TYPES.PAYROLL]:               { in: "Payroll received",     out: "Payroll sent" },
  [ACTIVITY_TYPES.INVOICE_CREATED]:       { in: "Invoice received",     out: "Invoice sent" },
  [ACTIVITY_TYPES.INVOICE_PAYMENT]:       { in: "Invoice payment",      out: "You paid an invoice" },
  [ACTIVITY_TYPES.INVOICE_PAID]:          { in: "Invoice paid",         out: "Invoice marked paid" },
  [ACTIVITY_TYPES.INVOICE_FINALIZED]:     { in: "Invoice finalized",    out: "Invoice finalized" },
  [ACTIVITY_TYPES.INVOICE_DISPUTED]:      { in: "Invoice disputed",     out: "You disputed an invoice" },
  [ACTIVITY_TYPES.INVOICE_CANCELLED]:     { in: "Invoice cancelled",    out: "You cancelled an invoice" },
  [ACTIVITY_TYPES.ESCROW_CREATED]:        { in: "Escrow created",       out: "You created an escrow" },
  [ACTIVITY_TYPES.ESCROW_ARBITER_NAMED]:  { in: "Named as arbiter",     out: "Named arbiter" },
  [ACTIVITY_TYPES.ESCROW_DELIVERED]:      { in: "Delivery confirmed",   out: "Marked delivered" },
  [ACTIVITY_TYPES.ESCROW_RELEASED]:       { in: "Escrow released",      out: "Released escrow" },
  [ACTIVITY_TYPES.ESCROW_DISPUTED]:       { in: "Escrow disputed",      out: "You disputed escrow" },
  [ACTIVITY_TYPES.ESCROW_EXPIRED]:        { in: "Escrow expired",       out: "Escrow expired" },
  [ACTIVITY_TYPES.ESCROW_EXPIRED_CLAIMED]:{ in: "Expired escrow claimed", out: "Claimed expired escrow" },
  [ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED]:{ in: "Arbiter decided",      out: "Arbiter decided" },
  [ACTIVITY_TYPES.ESCROW_RESOLVED]:       { in: "Escrow resolved",      out: "Escrow resolved" },

  [ACTIVITY_TYPES.GROUP_EXPENSE]:         { in: "Group expense",        out: "Group expense added" },
  [ACTIVITY_TYPES.GROUP_SETTLEMENT]:      { in: "Debt settled",         out: "You settled a debt" },
  [ACTIVITY_TYPES.GROUP_VOTE]:            { in: "Group vote",           out: "You voted in a group" },
  [ACTIVITY_TYPES.GROUP_LEFT]:            { in: "Member left group",    out: "You left a group" },
  [ACTIVITY_TYPES.GROUP_ARCHIVED]:        { in: "Group archived",       out: "You archived a group" },
  [ACTIVITY_TYPES.DEBT_SETTLED]:          { in: "Debt settled",         out: "You settled a debt" },

  [ACTIVITY_TYPES.CREATOR_SUPPORT]:       { in: "Creator support",      out: "Supported a creator" },
  [ACTIVITY_TYPES.CREATOR_PROFILE_UPDATED]:{ in: "Profile updated",     out: "You updated profile" },

  [ACTIVITY_TYPES.OFFER_CREATED]:         { in: "P2P offer created",    out: "You posted a P2P offer" },
  [ACTIVITY_TYPES.OFFER_FILLED]:          { in: "P2P offer filled",     out: "You filled a P2P offer" },
  [ACTIVITY_TYPES.OFFER_CANCELLED]:       { in: "P2P offer cancelled",  out: "You cancelled a P2P offer" },
  [ACTIVITY_TYPES.EXCHANGE_VERIFIED]:     { in: "Exchange verified",    out: "Exchange verified" },
  [ACTIVITY_TYPES.EXCHANGE_INVALID]:      { in: "Exchange flagged",     out: "Exchange flagged" },

  [ACTIVITY_TYPES.STEALTH_SENT]:          { in: "Stealth payment",      out: "Stealth payment sent" },
  [ACTIVITY_TYPES.STEALTH_CLAIM_STARTED]: { in: "Claim started",        out: "Claim started" },
  [ACTIVITY_TYPES.STEALTH_CLAIMED]:       { in: "Stealth claimed",      out: "Stealth claimed" },

  [ACTIVITY_TYPES.SHIELD]:                { in: "Deposited to vault",   out: "Deposited to vault" },
  [ACTIVITY_TYPES.UNSHIELD]:              { in: "Withdraw requested",   out: "Withdraw requested" },
  [ACTIVITY_TYPES.UNSHIELD_CLAIM]:        { in: "Withdraw claimed",     out: "Withdraw claimed" },
  [ACTIVITY_TYPES.MINT]:                  { in: "Faucet tokens",        out: "Faucet tokens" },

  [ACTIVITY_TYPES.SWAP_INITIATED]:        { in: "Swap initiated",       out: "Swap initiated" },
  [ACTIVITY_TYPES.SWAP_SETTLED]:          { in: "Swap completed",       out: "Swap completed" },
  [ACTIVITY_TYPES.SWAP_CANCELLED]:        { in: "Swap cancelled",       out: "Swap cancelled" },

  [ACTIVITY_TYPES.INHERITANCE_SET]:           { in: "Inheritance set",       out: "Inheritance set" },
  [ACTIVITY_TYPES.INHERITANCE_HEIR_SET]:      { in: "You were named heir",   out: "Heir named" },
  [ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED]:  { in: "Inheritance removed",   out: "Inheritance removed" },
  [ACTIVITY_TYPES.INHERITANCE_VAULTS_SET]:    { in: "Inheritance updated",   out: "Inheritance updated" },
  [ACTIVITY_TYPES.INHERITANCE_PULSE]:         { in: "Heartbeat",             out: "Heartbeat sent" },
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED]: { in: "Inheritance claim",     out: "Inheritance claim started" },
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_CANCELLED]:{ in: "Inheritance cancelled", out: "Inheritance cancelled" },
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED]:{ in: "Inheritance finalized", out: "Inheritance finalized" },

  [ACTIVITY_TYPES.PROOF_CREATED]:         { in: "Proof created",        out: "You created a proof" },
  [ACTIVITY_TYPES.PROOF_PUBLISHED]:       { in: "Proof published",      out: "You published a proof" },

  // Wave 4 — magic claim links.
  [ACTIVITY_TYPES.CLAIM_LINK_CREATED]:    { in: "Claim link received",  out: "Claim link sent" },
  [ACTIVITY_TYPES.CLAIM_LINK_CLAIMED]:    { in: "Link claimed",         out: "Recipient claimed" },
  [ACTIVITY_TYPES.CLAIM_LINK_REFUNDED]:   { in: "Link refunded",        out: "You refunded a link" },
};

/** Headline label for a History row. Direction-aware. Falls back to the
 *  activity type itself if a future type slips in without a label entry. */
export function getHistoryLabel(type: string, isIncoming: boolean): string {
  const entry = (LABELS as Record<string, LabelEntry | undefined>)[type];
  if (!entry) return type;
  return isIncoming ? entry.in : entry.out;
}

/** Whether the activity has a meaningful counterparty to display alongside
 *  the label. Some types are self-events (shield, mint) and shouldn't show
 *  a "from / to" line. */
export function hasCounterparty(type: string): boolean {
  switch (type) {
    case ACTIVITY_TYPES.SHIELD:
    case ACTIVITY_TYPES.UNSHIELD:
    case ACTIVITY_TYPES.UNSHIELD_CLAIM:
    case ACTIVITY_TYPES.MINT:
    case ACTIVITY_TYPES.GIFT_DEACTIVATED:
    case ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED:
    case ACTIVITY_TYPES.GROUP_LEFT:
    case ACTIVITY_TYPES.GROUP_ARCHIVED:
    case ACTIVITY_TYPES.INHERITANCE_PULSE:
    case ACTIVITY_TYPES.CLAIM_LINK_REFUNDED:
      return false;
    default:
      return true;
  }
}

// ─── Icon + color per type ────────────────────────────────────────────

interface IconEntry {
  icon: LucideIcon;
  bg: string;
}

const PAYMENT:    IconEntry = { icon: Send,            bg: "bg-blue-50 text-blue-600" };
const RECEIVE:    IconEntry = { icon: ArrowDownLeft,   bg: "bg-emerald-50 text-emerald-600" };
const VAULT:      IconEntry = { icon: KeyRound,        bg: "bg-amber-50 text-amber-600" };
const SWAP:       IconEntry = { icon: ArrowLeftRight,  bg: "bg-purple-50 text-purple-600" };
const STEALTH:    IconEntry = { icon: Ghost,           bg: "bg-gray-100 text-gray-600" };
const GIFT_ICON:  IconEntry = { icon: Gift,            bg: "bg-pink-50 text-pink-600" };
const INVOICE:    IconEntry = { icon: FileText,        bg: "bg-slate-100 text-slate-700" };
const ESCROW:     IconEntry = { icon: Briefcase,       bg: "bg-orange-50 text-orange-600" };
const REQUEST:    IconEntry = { icon: HandCoins,       bg: "bg-cyan-50 text-cyan-700" };
const GROUP:      IconEntry = { icon: Users,           bg: "bg-indigo-50 text-indigo-600" };
const CREATOR:    IconEntry = { icon: Heart,           bg: "bg-rose-50 text-rose-600" };
const PROOF:      IconEntry = { icon: ShieldQuestion,  bg: "bg-teal-50 text-teal-600" };
const INHERIT:    IconEntry = { icon: Shield,          bg: "bg-stone-100 text-stone-700" };
const MISC:       IconEntry = { icon: Sparkles,        bg: "bg-gray-50 text-gray-500" };
const COIN_ICON:  IconEntry = { icon: Coins,           bg: "bg-yellow-50 text-yellow-700" };
const SHOP_ICON:  IconEntry = { icon: ShoppingBag,     bg: "bg-fuchsia-50 text-fuchsia-700" };
const RECEIPT_I:  IconEntry = { icon: Receipt,         bg: "bg-lime-50 text-lime-700" };
const WALLET_I:   IconEntry = { icon: Wallet,          bg: "bg-sky-50 text-sky-700" };
const AGENT_I:    IconEntry = { icon: Megaphone,       bg: "bg-violet-50 text-violet-700" };
const CLAIM_LINK: IconEntry = { icon: Link2,           bg: "bg-blue-50 text-blue-600" };

const ICONS: Record<ActivityType, IconEntry> = {
  [ACTIVITY_TYPES.PAYMENT]:               PAYMENT,
  [ACTIVITY_TYPES.BATCH_PAYMENT]:         PAYMENT,
  [ACTIVITY_TYPES.AGENT_PAYMENT]:         AGENT_I,
  [ACTIVITY_TYPES.TIP]:                   COIN_ICON,
  [ACTIVITY_TYPES.REQUEST_CREATED]:       REQUEST,
  [ACTIVITY_TYPES.REQUEST_FULFILLED]:     RECEIVE,
  [ACTIVITY_TYPES.REQUEST_CANCELLED]:     REQUEST,
  [ACTIVITY_TYPES.GIFT_CREATED]:          GIFT_ICON,
  [ACTIVITY_TYPES.GIFT_CLAIMED]:          GIFT_ICON,
  [ACTIVITY_TYPES.GIFT_DEACTIVATED]:      GIFT_ICON,
  [ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED]:   GIFT_ICON,
  [ACTIVITY_TYPES.PAYROLL]:               WALLET_I,
  [ACTIVITY_TYPES.INVOICE_CREATED]:       INVOICE,
  [ACTIVITY_TYPES.INVOICE_PAYMENT]:       INVOICE,
  [ACTIVITY_TYPES.INVOICE_PAID]:          RECEIPT_I,
  [ACTIVITY_TYPES.INVOICE_FINALIZED]:     RECEIPT_I,
  [ACTIVITY_TYPES.INVOICE_DISPUTED]:      INVOICE,
  [ACTIVITY_TYPES.INVOICE_CANCELLED]:     INVOICE,
  [ACTIVITY_TYPES.ESCROW_CREATED]:        ESCROW,
  [ACTIVITY_TYPES.ESCROW_ARBITER_NAMED]:  ESCROW,
  [ACTIVITY_TYPES.ESCROW_DELIVERED]:      SHOP_ICON,
  [ACTIVITY_TYPES.ESCROW_RELEASED]:       ESCROW,
  [ACTIVITY_TYPES.ESCROW_DISPUTED]:       ESCROW,
  [ACTIVITY_TYPES.ESCROW_EXPIRED]:        ESCROW,
  [ACTIVITY_TYPES.ESCROW_EXPIRED_CLAIMED]:ESCROW,
  [ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED]:ESCROW,
  [ACTIVITY_TYPES.ESCROW_RESOLVED]:       ESCROW,
  [ACTIVITY_TYPES.GROUP_EXPENSE]:         GROUP,
  [ACTIVITY_TYPES.GROUP_SETTLEMENT]:      GROUP,
  [ACTIVITY_TYPES.GROUP_VOTE]:            GROUP,
  [ACTIVITY_TYPES.GROUP_LEFT]:            GROUP,
  [ACTIVITY_TYPES.GROUP_ARCHIVED]:        GROUP,
  [ACTIVITY_TYPES.DEBT_SETTLED]:          GROUP,
  [ACTIVITY_TYPES.CREATOR_SUPPORT]:       CREATOR,
  [ACTIVITY_TYPES.CREATOR_PROFILE_UPDATED]:CREATOR,
  [ACTIVITY_TYPES.OFFER_CREATED]:         SWAP,
  [ACTIVITY_TYPES.OFFER_FILLED]:          SWAP,
  [ACTIVITY_TYPES.OFFER_CANCELLED]:       SWAP,
  [ACTIVITY_TYPES.EXCHANGE_VERIFIED]:     SWAP,
  [ACTIVITY_TYPES.EXCHANGE_INVALID]:      SWAP,
  [ACTIVITY_TYPES.STEALTH_SENT]:          STEALTH,
  [ACTIVITY_TYPES.STEALTH_CLAIM_STARTED]: STEALTH,
  [ACTIVITY_TYPES.STEALTH_CLAIMED]:       STEALTH,
  [ACTIVITY_TYPES.SHIELD]:                VAULT,
  [ACTIVITY_TYPES.UNSHIELD]:              VAULT,
  [ACTIVITY_TYPES.UNSHIELD_CLAIM]:        VAULT,
  [ACTIVITY_TYPES.MINT]:                  COIN_ICON,
  [ACTIVITY_TYPES.SWAP_INITIATED]:        SWAP,
  [ACTIVITY_TYPES.SWAP_SETTLED]:          SWAP,
  [ACTIVITY_TYPES.SWAP_CANCELLED]:        SWAP,
  [ACTIVITY_TYPES.INHERITANCE_SET]:           INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_HEIR_SET]:      INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED]:  INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_VAULTS_SET]:    INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_PULSE]:         INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED]: INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_CANCELLED]:INHERIT,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED]:INHERIT,
  [ACTIVITY_TYPES.PROOF_CREATED]:         PROOF,
  [ACTIVITY_TYPES.PROOF_PUBLISHED]:       PROOF,
  [ACTIVITY_TYPES.CLAIM_LINK_CREATED]:    CLAIM_LINK,
  [ACTIVITY_TYPES.CLAIM_LINK_CLAIMED]:    CLAIM_LINK,
  [ACTIVITY_TYPES.CLAIM_LINK_REFUNDED]:   CLAIM_LINK,
};

export function getHistoryIcon(type: string): IconEntry {
  return (ICONS as Record<string, IconEntry | undefined>)[type] ?? MISC;
}
