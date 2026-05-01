// Browser-side Web Push subscription management.
//
// Flow on first run:
//   1. Caller invokes `subscribeToPush(address)` (e.g. from a "Enable
//      notifications" button in Settings).
//   2. We register `/sw.js` if not already installed.
//   3. We ask the user for Notification permission.
//   4. We call `pushManager.subscribe()` with our VAPID public key, which
//      gives us a `PushSubscription` keyed to the user's browser.
//   5. We POST the subscription + the user's wallet address to
//      `/api/push/subscribe`. The server stores it in Supabase.
//   6. Later, /api/push/notify (called by a Supabase webhook) looks up
//      the subscription by address and pushes a notification.
//
// iOS note: iOS 16.4+ supports Web Push, but ONLY after the user has added
// the PWA to their home screen. The browser prompt won't appear in Safari
// for a regular tab. We surface that in the UI when permission is denied
// on iOS.

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY || "").trim();

export interface SubscribeArgs {
  /** User's wallet (or smart-account) address. */
  address: string;
  /** Optional chain ID — useful for routing notifications later. */
  chainId?: number;
  /** Optional wallet-signed challenge proving ownership of `address`.
   *  When the server runs in fail-closed mode (default in production)
   *  the request is rejected without these. The frontend caller should
   *  build them via useEmailAuthSigner or similar wallet-signing path. */
  signature?: `0x${string}`;
  signedAt?: number;
  signerChainId?: number;
}

export interface SubscribeResult {
  ok: true;
  endpoint: string;
}

export interface SubscribeError {
  ok: false;
  /** Stable code for caller to branch on (e.g. show iOS-specific copy). */
  reason:
    | "unsupported"
    | "permission-denied"
    | "vapid-missing"
    | "network-error"
    | "unknown";
  message: string;
}

export type SubscribeOutcome = SubscribeResult | SubscribeError;

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True if the device is iOS — callers can show iOS-specific install hints. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

/** True if the app is running standalone (PWA installed) on iOS. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  // iOS uses navigator.standalone; other browsers expose display-mode media.
  const navAny = navigator as unknown as { standalone?: boolean };
  if (navAny.standalone) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

/** Convert URL-safe base64 (VAPID format) to a Uint8Array backed by a real
 * ArrayBuffer. The ArrayBuffer typing matters here — `pushManager.subscribe`
 * types `applicationServerKey` as `BufferSource`, which under TS 5.x rejects
 * Uint8Arrays whose backing is `ArrayBufferLike` (could be SharedArrayBuffer). */
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/**
 * Idempotent subscribe. Safe to call multiple times — if the user already
 * has an active subscription, we re-POST it to the server (keeps Supabase
 * in sync if the row was deleted) and return.
 */
export async function subscribeToPush(args: SubscribeArgs): Promise<SubscribeOutcome> {
  if (!pushSupported()) {
    return {
      ok: false,
      reason: "unsupported",
      message: "Push notifications aren't supported in this browser.",
    };
  }
  if (!VAPID_PUBLIC_KEY) {
    return {
      ok: false,
      reason: "vapid-missing",
      message: "Push notifications aren't configured (VITE_VAPID_PUBLIC_KEY missing).",
    };
  }

  try {
    const registration = await ensureRegistration();

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return {
        ok: false,
        reason: "permission-denied",
        message: "Notification permission was not granted.",
      };
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: args.address.toLowerCase(),
        chainId: args.chainId,
        subscription: subscription.toJSON(),
        // Audit P2.11 — wallet-signed challenge so an attacker can't
        // register their browser as the recipient of someone else's
        // notifications. Server may reject without these in production.
        signature: args.signature,
        signedAt: args.signedAt,
        signerChainId: args.signerChainId,
      }),
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: "network-error",
        message: `Subscription server returned ${res.status}.`,
      };
    }

    return { ok: true, endpoint: subscription.endpoint };
  } catch (err) {
    return {
      ok: false,
      reason: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Tear down the subscription locally and notify the server. */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  // Best-effort server cleanup.
  try {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Non-fatal; the next subscribe call will overwrite the stale row.
  }
  return true;
}

export async function pushPermissionState(): Promise<NotificationPermission | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}
