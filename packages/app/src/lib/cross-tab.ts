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
  | "aa_passkey_changed"
  | "passphrase_resolved";

const WINDOW_EVENT = "blank-cross-action";

export function broadcastAction(
  action: CrossTabAction,
  data?: Record<string, unknown>,
) {
  const payload = { action, data, timestamp: Date.now() };
  // Cross-tab: BroadcastChannel only delivers to OTHER browsing contexts on
  // the same origin. It does NOT fire in the sending tab — that's correct
  // for its stated purpose, but breaks our use case where two hook
  // instances in the SAME tab need to sync (PasskeyCreationModal's
  // useSmartAccount and BlankApp's useSmartAccount).
  getCrossTabChannel()?.postMessage(payload);
  // Same-tab: a plain CustomEvent on window reaches every listener in this
  // tab synchronously. Combined with the BroadcastChannel, broadcastAction
  // now reaches every listener on this origin regardless of tab.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENT, { detail: payload }));
  }
}

export function onCrossTabAction(
  callback: (action: CrossTabAction, data?: Record<string, unknown>) => void,
) {
  const unsubs: Array<() => void> = [];
  const ch = getCrossTabChannel();
  if (ch) {
    const chHandler = (e: MessageEvent) => callback(e.data.action, e.data.data);
    ch.addEventListener("message", chHandler);
    unsubs.push(() => ch.removeEventListener("message", chHandler));
  }
  if (typeof window !== "undefined") {
    const winHandler = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      callback(d.action, d.data);
    };
    window.addEventListener(WINDOW_EVENT, winHandler);
    unsubs.push(() => window.removeEventListener(WINDOW_EVENT, winHandler));
  }
  return () => { for (const u of unsubs) u(); };
}
