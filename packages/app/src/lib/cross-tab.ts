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

// Audit Top-28 #12: every broadcast carries an envelope so listeners can
// reject messages that don't match this app's schema. The motivation:
//   - browser extensions or DevTools snippets sharing the same origin
//     could post objects to the BroadcastChannel; without a discriminator
//     we'd treat them as authentic events.
//   - future schema changes (e.g., adding new fields to a payload) need a
//     way to ignore older-version messages from a stale tab.
//   - a tab may want to ignore its own broadcasts (currently we don't, but
//     senderId is here for that future need).
//
// Bumping PROTOCOL_VERSION when payload shape changes opts old listeners
// out automatically — they'll drop the message at the version check below.
const PROTOCOL_VERSION = 1 as const;
const PROTOCOL_TAG = "blank-cross-tab" as const;

// Stable per-tab id so listeners can distinguish self vs. other-tab
// without relying on the BroadcastChannel's "no self-delivery" quirk
// (which doesn't apply to our same-tab CustomEvent fan-out).
const SENDER_ID = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
})();

interface CrossTabEnvelope {
  tag: typeof PROTOCOL_TAG;
  version: number;
  senderId: string;
  action: CrossTabAction;
  data?: Record<string, unknown>;
  timestamp: number;
}

const KNOWN_ACTIONS = new Set<CrossTabAction>([
  "balance_changed",
  "activity_added",
  "stealth_inbox_changed",
  "pending_claim_removed",
  "aa_nonce_used",
  "aa_passkey_changed",
  "passphrase_resolved",
]);

function isValidEnvelope(raw: unknown): raw is CrossTabEnvelope {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Partial<CrossTabEnvelope>;
  if (e.tag !== PROTOCOL_TAG) return false;
  if (e.version !== PROTOCOL_VERSION) return false;
  if (typeof e.senderId !== "string" || e.senderId.length === 0) return false;
  if (typeof e.action !== "string" || !KNOWN_ACTIONS.has(e.action as CrossTabAction)) return false;
  if (typeof e.timestamp !== "number") return false;
  return true;
}

const WINDOW_EVENT = "blank-cross-action";

export function broadcastAction(
  action: CrossTabAction,
  data?: Record<string, unknown>,
) {
  const payload: CrossTabEnvelope = {
    tag: PROTOCOL_TAG,
    version: PROTOCOL_VERSION,
    senderId: SENDER_ID,
    action,
    data,
    timestamp: Date.now(),
  };
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
    const chHandler = (e: MessageEvent) => {
      // Reject anything that isn't our envelope — stops extensions /
      // devtools / other origins-on-same-channel from injecting events.
      if (!isValidEnvelope(e.data)) return;
      callback(e.data.action, e.data.data);
    };
    ch.addEventListener("message", chHandler);
    unsubs.push(() => ch.removeEventListener("message", chHandler));
  }
  if (typeof window !== "undefined") {
    const winHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!isValidEnvelope(detail)) return;
      callback(detail.action, detail.data);
    };
    window.addEventListener(WINDOW_EVENT, winHandler);
    unsubs.push(() => window.removeEventListener(WINDOW_EVENT, winHandler));
  }
  return () => { for (const u of unsubs) u(); };
}
