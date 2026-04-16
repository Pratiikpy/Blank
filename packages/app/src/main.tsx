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
