// Register the service worker on app boot.
//
// We only call `navigator.serviceWorker.register` — no caching, no offline
// shell. The SW exists so the browser can hand us push events when the app
// is closed; everything else still goes through the network.
//
// Skipping the registration in environments where push isn't useful (older
// browsers, no SW support) avoids noisy console errors and lets the app
// still mount.
//
// Note: registering a fresh SW on every reload is fine — `navigator.
// serviceWorker.register("/sw.js")` is idempotent. The browser only fetches
// the SW file again, then applies a new version if the bytes differ.

import { log } from "./log";

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (typeof location !== "undefined" && location.protocol === "http:" && location.hostname !== "localhost") {
    // Browsers refuse to register SWs on plain http (except localhost).
    return;
  }

  // Wait for the page to fully load so SW registration doesn't compete with
  // the critical render path. The SW won't intercept any of the initial
  // assets — it's a one-time fetch.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      // Registration failures are non-fatal — push notifications won't work
      // but the app still loads. Surface to console for debugging.
      log.warn("sw.registration.failed", err instanceof Error ? err : new Error(String(err)));
    });
  });
}
