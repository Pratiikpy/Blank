/**
 * Server-side Web Push helper.
 *
 * Wraps the `web-push` npm package to:
 *   - configure VAPID once per cold start
 *   - send a typed payload to a single subscription
 *   - return a stable `{ ok, gone }` result so callers can prune dead subs
 *
 * The browser PushSubscription JSON shape we accept matches what
 * `pushManager.subscribe(...).toJSON()` returns:
 *
 *   {
 *     endpoint: "https://fcm.googleapis.com/...",
 *     keys: { p256dh: "...", auth: "..." }
 *   }
 *
 * `gone === true` means the subscription is permanently dead (HTTP 404 / 410)
 * and the row should be deleted from Supabase. Other failures are transient.
 */

import webpush from "web-push";

let configured = false;

function configureIfNeeded() {
  if (configured) return;
  const subject = process.env.VAPID_SUBJECT || "mailto:hello@blank.app";
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("Web Push not configured: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  /** Notification title — keep short, < 50 chars. */
  title: string;
  /** Body text. */
  body: string;
  /** Path to open / focus when the user taps the notification. */
  url?: string;
  /** Tag groups related notifications (e.g. all updates for invoice #42). */
  tag?: string;
  /** Optional icon override (defaults to /ghost.svg in the SW). */
  icon?: string;
}

export interface SendPushResult {
  ok: boolean;
  /** True when the subscription is permanently dead (delete the row). */
  gone: boolean;
  status?: number;
  error?: string;
}

export async function sendPush(
  subscription: BrowserSubscription,
  payload: PushPayload,
): Promise<SendPushResult> {
  configureIfNeeded();
  try {
    const res = await webpush.sendNotification(
      subscription,
      JSON.stringify(payload),
      { TTL: 60 * 60 }, // 1h — discard if undelivered
    );
    return { ok: true, gone: false, status: res.statusCode };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    const gone = status === 404 || status === 410;
    return {
      ok: false,
      gone,
      status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True if VAPID is configured — used by /api/health. */
export function webPushConfigured(): boolean {
  return !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
}
