import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AppProviders } from "@/providers/AppProviders";
import { App } from "@/App";
import { initSentry } from "@/lib/sentry-adapter";
import "@/index.css";

// Dev warning for missing env vars
if (import.meta.env.DEV) {
  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    console.warn("[Blank] Supabase env vars missing — real-time features disabled. See .env.example");
  }
}

// Wire Sentry BEFORE React mounts so early errors are captured. Bails early
// if VITE_SENTRY_DSN is unset — zero runtime cost in that case.
initSentry();

// White-screen-on-refresh fix. When we deploy, the new index.html points at
// new chunk hashes but browsers may have an old index.html cached. That old
// index.html references chunks that no longer exist → Vite's dynamic import()
// rejects with "Failed to fetch dynamically imported module" → React's
// Suspense renders nothing → pure white screen.
//
// Vite emits a `vite:preloadError` event on the window when a preload fails.
// Reload the page once to pick up the fresh index.html. Guard against a
// reload loop with sessionStorage so a genuinely broken chunk doesn't trap
// the user in an infinite refresh cycle.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (evt) => {
    const RELOAD_KEY = "blank_chunk_reload_ts";
    const now = Date.now();
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || "0");
    if (now - last < 10_000) {
      // Already reloaded recently — don't loop. Let the ErrorBoundary take over.
      console.error("[preloadError] reload loop suppressed:", evt);
      return;
    }
    console.warn("[preloadError] chunk load failed, reloading for fresh index.html");
    sessionStorage.setItem(RELOAD_KEY, String(now));
    evt.preventDefault();
    window.location.reload();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AppProviders>
          <App />
        </AppProviders>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
