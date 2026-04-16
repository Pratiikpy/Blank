const CHANNEL_NAME = "blank-cross-tab";

let channel: BroadcastChannel | null = null;

export function getCrossTabChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

// ─── Typed action union ───────────────────────────────────────────────
//
// Extend this list whenever a new cross-tab state-sync scenario is added.
// Keeping the set closed + typed means TS catches typos at both the
// broadcaster and listener side rather than silently dropping messages.
//
// Legacy strings ("balance_changed", "activity_added") stay in the union
// so existing callers compile without modification.
export type CrossTabAction =
  | "balance_changed"
  | "activity_added"
  | "stealth_inbox_changed"
  | "pending_claim_removed"
  | "aa_nonce_used"
  | "passphrase_resolved";

export function broadcastAction(
  action: CrossTabAction,
  data?: Record<string, unknown>,
) {
  getCrossTabChannel()?.postMessage({ action, data, timestamp: Date.now() });
}

export function onCrossTabAction(
  callback: (action: CrossTabAction, data?: Record<string, unknown>) => void,
) {
  const ch = getCrossTabChannel();
  if (!ch) return () => {};
  const handler = (e: MessageEvent) => callback(e.data.action, e.data.data);
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}
