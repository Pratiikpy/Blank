import { Suspense, lazy } from "react";
import { Routes, Route, Link } from "react-router-dom";
import { useRealtimeNotifications } from "@/hooks/useRealtimeNotifications";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Landing-level pages — each is its own bundle chunk (lazy-loaded)
const Landing       = lazy(() => import("@/blank-ui/landing/Landing"));
const Features      = lazy(() => import("@/blank-ui/landing/Features"));
const Live          = lazy(() => import("@/blank-ui/landing/Live"));
const Manifesto     = lazy(() => import("@/blank-ui/landing/Manifesto"));
const HowItWorks    = lazy(() => import("@/blank-ui/landing/HowItWorks"));
const Verify        = lazy(() => import("@/blank-ui/landing/Verify"));
const PayPage       = lazy(() => import("@/blank-ui/landing/PayPage"));
const ForIndividuals = lazy(() => import("@/blank-ui/landing/AudiencePage").then((m) => ({ default: m.ForIndividuals })));
const ForCreators   = lazy(() => import("@/blank-ui/landing/AudiencePage").then((m) => ({ default: m.ForCreators })));
const ForBusinesses = lazy(() => import("@/blank-ui/landing/AudiencePage").then((m) => ({ default: m.ForBusinesses })));
const ForDaos       = lazy(() => import("@/blank-ui/landing/AudiencePage").then((m) => ({ default: m.ForDaos })));

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

// Audit Top-28 #20: catch-all 404 for any route outside /app/* and the
// landing-level paths above. Without this, a typo'd URL fell through to
// the browser's blank "no route matched" state and was indistinguishable
// from a broken app.
function NotFoundLanding() {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[#F9FAFB]">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-6xl font-semibold text-[var(--text-primary)]" style={{ fontFamily: "'Outfit', sans-serif" }}>404</h1>
        <p className="text-lg text-[var(--text-primary)]/70">Page not found</p>
        <p className="text-sm text-[var(--text-primary)]/50">
          The page you're looking for doesn't exist.
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <Link
            to="/"
            className="h-11 px-5 rounded-2xl bg-[var(--text-primary)] text-white font-medium inline-flex items-center justify-center hover:bg-[#000000] transition-colors"
          >
            Go home
          </Link>
          <Link
            to="/app"
            className="h-11 px-5 rounded-2xl bg-white border border-black/5 text-[var(--text-primary)] font-medium inline-flex items-center justify-center hover:bg-black/5 transition-colors"
          >
            Open app
          </Link>
        </div>
      </div>
    </div>
  );
}

export function App() {
  // Global real-time notifications. The hook guards internally on connected
  // wallet, so it's safe to mount here even for landing visitors.
  useRealtimeNotifications();

  return (
    // Audit Top-28 #19: top-level ErrorBoundary so a render error in any
    // lazy-loaded route doesn't white-screen the entire app. The boundary
    // shows a "Something broke" card with a Reload button. BlankApp also
    // contains a per-feature boundary internally, but this catches errors
    // raised before that one renders (Suspense fallbacks, route imports,
    // etc.).
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          {/* Public landing-level pages */}
          <Route path="/"                    element={<Landing />} />
          <Route path="/features"            element={<Features />} />
          <Route path="/how-it-works"        element={<HowItWorks />} />
          <Route path="/live"                element={<Live />} />
          <Route path="/manifesto"           element={<Manifesto />} />
          <Route path="/verify/:proofId"     element={<Verify />} />
          <Route path="/pay/:identifier"     element={<PayPage />} />
          <Route path="/for/individuals"     element={<ForIndividuals />} />
          <Route path="/for/creators"        element={<ForCreators />} />
          <Route path="/for/businesses"      element={<ForBusinesses />} />
          <Route path="/for/daos"            element={<ForDaos />} />
          {/*
            The product lives under /app/*. BlankApp has its own internal <Routes>
            with absolute paths prefixed /app (e.g., /app/send, /app/groups, etc.).
          */}
          <Route path="/app/*"     element={<BlankApp />} />
          {/* Audit Top-28 #20: root-level catch-all so non-/app routes get
              a friendly 404 instead of falling through to a blank page. */}
          <Route path="*"          element={<NotFoundLanding />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
