import { ACTIVITY_TYPES, type ActivityType } from "./activity-types";

/**
 * Registry mapping each activity type to a toast-message formatter.
 *
 * Every activity type MUST have an entry here. The `MESSAGE_FORMATTERS`
 * record is typed as `Record<ActivityType, Formatter>` so TypeScript fails
 * the build if a new type is added to `activity-types.ts` without a
 * corresponding formatter.
 *
 * Also exposes a toast-icon lookup so `useRealtimeNotifications` no longer
 * hardcodes activity-type strings.
 */

export interface ActivityMessageArgs {
  from: string; // short-hex "0xabc...def"
  note: string;
}

export type Formatter = (args: ActivityMessageArgs) => string;

const defaults: Formatter = ({ from }) => `Activity from ${from}`;

// Parse envelope id from gift notes: "[envelope:123] message" → "#123 message"
function parseGiftEnvelope(note: string): { id: string | null; display: string } {
  const m = note.match(/^\[envelope:(\d+)\]\s*(.*)$/);
  if (m) return { id: m[1], display: m[2] };
  return { id: null, display: note };
}

export const MESSAGE_FORMATTERS: Record<ActivityType, Formatter> = {
  [ACTIVITY_TYPES.PAYMENT]: ({ from, note }) =>
    `${from} sent you a payment${note ? ` "${note}"` : ""}`,
  [ACTIVITY_TYPES.BATCH_PAYMENT]: ({ from }) => `${from} sent a batch payment`,
  [ACTIVITY_TYPES.AGENT_PAYMENT]: ({ from, note }) =>
    `${from} sent an AI-agent payment${note ? ` "${note}"` : ""}`,
  [ACTIVITY_TYPES.TIP]: ({ from, note }) =>
    `${from} tipped you${note ? ` "${note}"` : ""}`,

  [ACTIVITY_TYPES.REQUEST_CREATED]: ({ from, note }) =>
    `${from} requested money${note ? ` "${note}"` : ""}`,
  [ACTIVITY_TYPES.REQUEST_FULFILLED]: ({ from }) => `${from} paid your request`,
  [ACTIVITY_TYPES.REQUEST_CANCELLED]: ({ from }) =>
    `${from} cancelled a payment request`,

  [ACTIVITY_TYPES.GIFT_CREATED]: ({ from, note }) => {
    const { id, display } = parseGiftEnvelope(note);
    if (id) return `${from} sent you a gift! Envelope #${id}${display ? ` "${display}"` : ""}`;
    return display ? `${from} sent you a gift "${display}"` : `${from} sent you a gift`;
  },
  [ACTIVITY_TYPES.GIFT_CLAIMED]: ({ from }) => `${from} opened a gift envelope`,
  [ACTIVITY_TYPES.GIFT_DEACTIVATED]: ({ from }) =>
    `${from} cancelled a gift envelope`,
  [ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED]: ({ from, note }) =>
    `${from} updated a gift envelope expiry${note ? ` (${note})` : ""}`,

  [ACTIVITY_TYPES.PAYROLL]: ({ from }) => `${from} sent payroll`,
  [ACTIVITY_TYPES.INVOICE_CREATED]: ({ from, note }) =>
    `New invoice from ${from}${note ? `: ${note}` : ""}`,
  [ACTIVITY_TYPES.INVOICE_PAYMENT]: ({ from }) =>
    `${from} submitted invoice payment`,
  [ACTIVITY_TYPES.INVOICE_PAID]: ({ from }) => `${from} paid your invoice`,
  [ACTIVITY_TYPES.INVOICE_FINALIZED]: ({ from }) =>
    `${from} finalized an invoice payment`,
  [ACTIVITY_TYPES.INVOICE_DISPUTED]: ({ from }) =>
    `Invoice disputed by ${from}`,
  [ACTIVITY_TYPES.INVOICE_CANCELLED]: ({ from }) =>
    `Invoice cancelled by ${from}`,
  [ACTIVITY_TYPES.ESCROW_CREATED]: ({ from, note }) =>
    `${from} created an escrow${note ? `: ${note}` : ""}`,
  [ACTIVITY_TYPES.ESCROW_ARBITER_NAMED]: ({ from, note }) =>
    `${from} named you as arbiter for an escrow${note ? `: ${note}` : ""}`,
  [ACTIVITY_TYPES.ESCROW_DELIVERED]: ({ from }) =>
    `${from} marked an escrow as delivered`,
  [ACTIVITY_TYPES.ESCROW_RELEASED]: ({ from }) =>
    `Escrow funds released from ${from}`,
  [ACTIVITY_TYPES.ESCROW_DISPUTED]: ({ from }) =>
    `${from} disputed an escrow`,
  [ACTIVITY_TYPES.ESCROW_EXPIRED]: ({ from }) =>
    `Escrow from ${from} expired`,
  [ACTIVITY_TYPES.ESCROW_EXPIRED_CLAIMED]: ({ from }) =>
    `${from} claimed an expired escrow`,
  [ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED]: ({ from }) =>
    `Arbiter decided on ${from}'s escrow`,
  [ACTIVITY_TYPES.ESCROW_RESOLVED]: ({ from }) =>
    `Escrow dispute resolved by ${from}`,

  [ACTIVITY_TYPES.GROUP_EXPENSE]: ({ from }) => `New group expense from ${from}`,
  [ACTIVITY_TYPES.GROUP_SETTLEMENT]: ({ from }) =>
    `${from} settled a group debt`,
  [ACTIVITY_TYPES.GROUP_VOTE]: ({ from }) => `${from} voted on a group action`,
  [ACTIVITY_TYPES.GROUP_LEFT]: ({ from }) => `${from} left a group`,
  [ACTIVITY_TYPES.GROUP_ARCHIVED]: ({ from }) => `${from} archived a group`,
  [ACTIVITY_TYPES.DEBT_SETTLED]: ({ from }) => `${from} settled a group debt`,

  [ACTIVITY_TYPES.CREATOR_SUPPORT]: ({ from }) => `${from} supported a creator`,
  [ACTIVITY_TYPES.CREATOR_PROFILE_UPDATED]: ({ from }) =>
    `${from} updated their creator profile`,

  [ACTIVITY_TYPES.OFFER_CREATED]: ({ from }) => `${from} created a P2P offer`,
  [ACTIVITY_TYPES.OFFER_FILLED]: ({ from }) => `${from} filled your P2P offer`,
  [ACTIVITY_TYPES.OFFER_CANCELLED]: ({ from }) =>
    `${from} cancelled a P2P offer`,
  [ACTIVITY_TYPES.EXCHANGE_VERIFIED]: ({ from }) =>
    `${from} verified an exchange trade`,
  [ACTIVITY_TYPES.EXCHANGE_INVALID]: ({ from }) =>
    `${from} flagged an exchange trade as invalid`,

  [ACTIVITY_TYPES.STEALTH_SENT]: () =>
    `You received a stealth payment — open Stealth to claim`,
  [ACTIVITY_TYPES.STEALTH_CLAIM_STARTED]: ({ from }) =>
    `${from} started a stealth claim`,
  [ACTIVITY_TYPES.STEALTH_CLAIMED]: ({ from }) =>
    `${from} claimed a stealth payment`,

  [ACTIVITY_TYPES.SHIELD]: ({ from }) => `${from} shielded tokens`,
  [ACTIVITY_TYPES.UNSHIELD]: ({ from }) => `${from} unshielded tokens`,
  [ACTIVITY_TYPES.UNSHIELD_CLAIM]: ({ from }) =>
    `${from} claimed an unshield`,

  [ACTIVITY_TYPES.SWAP_INITIATED]: ({ from }) =>
    `${from} initiated a private swap`,
  [ACTIVITY_TYPES.SWAP_SETTLED]: ({ from }) => `${from} settled a private swap`,
  [ACTIVITY_TYPES.SWAP_CANCELLED]: ({ from }) =>
    `${from} cancelled a private swap`,

  [ACTIVITY_TYPES.INHERITANCE_SET]: ({ from }) =>
    `${from} configured an inheritance plan`,
  [ACTIVITY_TYPES.INHERITANCE_HEIR_SET]: ({ from }) =>
    `${from} named you as heir`,
  [ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED]: ({ from }) =>
    `${from} removed their inheritance plan`,
  [ACTIVITY_TYPES.INHERITANCE_VAULTS_SET]: ({ from }) =>
    `${from} updated vaults on their inheritance plan`,
  [ACTIVITY_TYPES.INHERITANCE_PULSE]: ({ from }) =>
    `${from} sent a pulse (inheritance reset)`,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED]: ({ from }) =>
    `${from} started an inheritance claim`,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_CANCELLED]: ({ from }) =>
    `${from} cancelled an inheritance claim`,
  [ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED]: ({ from }) =>
    `${from} finalized an inheritance claim`,

  [ACTIVITY_TYPES.PROOF_CREATED]: ({ from }) =>
    `${from} created a qualification proof`,
  [ACTIVITY_TYPES.PROOF_PUBLISHED]: ({ from }) =>
    `${from} published a proof verdict`,
};

export function formatActivityMessage(
  type: string,
  from: string,
  note: string,
): string {
  const formatter = (MESSAGE_FORMATTERS as Record<string, Formatter | undefined>)[type];
  if (!formatter) {
    if (import.meta.env.DEV) {
      // Fail loud in dev so missing formatters surface before shipping.
      console.warn(
        `[activity-messages] no formatter for type "${type}" — add one to MESSAGE_FORMATTERS`,
      );
    }
    return defaults({ from, note });
  }
  return formatter({ from, note });
}

/** Toast emoji for each activity category. */
export function iconForActivityType(type: string): string {
  if (type === ACTIVITY_TYPES.PAYMENT || type === ACTIVITY_TYPES.TIP || type === ACTIVITY_TYPES.AGENT_PAYMENT)
    return "\uD83D\uDCB0"; // 💰
  if (type === ACTIVITY_TYPES.REQUEST_CREATED) return "\uD83D\uDCE5"; // 📥
  if (type === ACTIVITY_TYPES.GIFT_CREATED || type === ACTIVITY_TYPES.GIFT_CLAIMED)
    return "\uD83C\uDF81"; // 🎁
  if (type === ACTIVITY_TYPES.INVOICE_CREATED || type === ACTIVITY_TYPES.INVOICE_PAID)
    return "\uD83D\uDCC4"; // 📄
  if (type === ACTIVITY_TYPES.STEALTH_SENT || type === ACTIVITY_TYPES.STEALTH_CLAIMED)
    return "\uD83D\uDD75\uFE0F"; // 🕵️
  if (type === ACTIVITY_TYPES.INHERITANCE_HEIR_SET) return "\uD83D\uDD12"; // 🔒
  return "\uD83D\uDCEC"; // 📬 (generic notification)
}
