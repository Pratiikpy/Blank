import { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";
import { useRealtimeNotifications } from "@/hooks/useRealtimeNotifications";

// Landing-level pages — each is its own bundle chunk (lazy-loaded)
const Landing    = lazy(() => import("@/blank-ui/landing/Landing"));
const Features   = lazy(() => import("@/blank-ui/landing/Features"));
const Live       = lazy(() => import("@/blank-ui/landing/Live"));
const Manifesto  = lazy(() => import("@/blank-ui/landing/Manifesto"));
const HowItWorks = lazy(() => import("@/blank-ui/landing/HowItWorks"));

// The app itself — separate bundle, wallet-gated internally
const BlankApp  = lazy(() =>
  import("@/blank-ui/BlankApp").then((m) => ({ default: m.BlankApp }))
);

function LoadingScreen() {
  return (
    <div
      className="min-h-dvh flex items-center justify-center"
      style={{ background: "#F9FAFB" }}
    >
      <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function App() {
  // Global real-time notifications. The hook guards internally on connected
  // wallet, so it's safe to mount here even for landing visitors.
  useRealtimeNotifications();

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        {/* Public landing-level pages */}
        <Route path="/"              element={<Landing />} />
        <Route path="/features"      element={<Features />} />
        <Route path="/how-it-works"  element={<HowItWorks />} />
        <Route path="/live"          element={<Live />} />
        <Route path="/manifesto"     element={<Manifesto />} />
        {/*
          The product lives under /app/*. BlankApp has its own internal <Routes>
          with absolute paths prefixed /app (e.g., /app/send, /app/groups, etc.).
        */}
        <Route path="/app/*"     element={<BlankApp />} />
      </Routes>
    </Suspense>
  );
}
