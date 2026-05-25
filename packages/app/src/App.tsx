import { Suspense, lazy } from "react";
import { Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getSubdomainRouteTarget } from "@/lib/subdomainRouting";
import { PublicMetadata } from "@/components/PublicMetadata";

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
const Pricing      = lazy(() => import("@/blank-ui/landing/Pricing"));
const Roadmap      = lazy(() => import("@/blank-ui/landing/Roadmap"));
const Blog         = lazy(() => import("@/blank-ui/landing/Blog"));
const BlogPost     = lazy(() => import("@/blank-ui/landing/BlogPost"));
const Whitepaper   = lazy(() => import("@/blank-ui/landing/Whitepaper"));
const BrandKit     = lazy(() => import("@/blank-ui/landing/BrandKit"));
// Wave 5 Block 0.3 - public status page reading /api/health?kind=status.
const Status = lazy(() => import("@/blank-ui/screens/Status"));
// Wave 5 Block 2 — public @handle profile page. /u/:handle resolves
// the per-chain handle registry and shows owner + send CTA.
const PublicProfile = lazy(() => import("@/blank-ui/screens/PublicProfile"));
// Wave 5 Block 3 — guardian-based social recovery. Public route so a
// recovering user on a fresh device can drive the flow without a
// working passkey (a guardian signs the on-chain calls).
const Recovery = lazy(() => import("@/blank-ui/screens/Recovery"));
// Wave 5 Block 7 — PWA install prompt. Lives globally so it can fire
// on landing pages too (helpful for visitors who want to install
// before they sign in).
import { PwaInstallPrompt } from "@/blank-ui/components/PwaInstallPrompt";
// Wave 4 — magic claim links: public recipient flow.
const ClaimLinkPage = lazy(() => import("@/blank-ui/screens/ClaimLinkPage"));
// Wave 4 — storefront: public buyer flow.
const StorefrontPage = lazy(() => import("@/blank-ui/screens/StorefrontPage"));
// Wave 4 — encrypted crowdfund: public contributor flow.
const CrowdfundPage = lazy(() => import("@/blank-ui/screens/CrowdfundPage"));

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

function SubdomainRouteRedirect() {
  const location = useLocation();
  const target =
    typeof window === "undefined"
      ? null
      : getSubdomainRouteTarget(window.location.hostname, location.pathname);

  if (!target) return null;

  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
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
  // useRealtimeNotifications mount intentionally moved into BlankApp so
  // landing visitors don't open Supabase Realtime channels. The hook
  // opens up to 4 channels × 2 addresses = 8 sockets per page load; for
  // an unauth visitor on `/` those are wasted Supabase quota and main-
  // thread setup. BlankApp is the auth-gated shell, so mounting it
  // there scopes realtime to authenticated sessions only.

  return (
    // Audit Top-28 #19: top-level ErrorBoundary so a render error in any
    // lazy-loaded route doesn't white-screen the entire app. The boundary
    // shows a "Something broke" card with a Reload button. BlankApp also
    // contains a per-feature boundary internally, but this catches errors
    // raised before that one renders (Suspense fallbacks, route imports,
    // etc.).
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <SubdomainRouteRedirect />
        <PublicMetadata />
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
          <Route path="/pricing"             element={<Pricing />} />
          <Route path="/roadmap"             element={<Roadmap />} />
          <Route path="/whitepaper"          element={<Whitepaper />} />
          <Route path="/brand-kit"           element={<BrandKit />} />
          <Route path="/blog"                element={<Blog />} />
          <Route path="/blog/:slug"          element={<BlogPost />} />
          {/* Wave 5 — public status page. Read-only health probe across both
              chains + paymaster + relayer + FHE network + last-deployed sha.
              Polls /api/health?kind=status every 30s. */}
          <Route path="/status"              element={<Status />} />
          {/* Wave 5 Block 2 — public @handle profile. /u/:handle resolves
              the per-chain handle to a smart-account address. */}
          <Route path="/u/:handle"           element={<PublicProfile />} />
          {/* Wave 5 Block 3 — public guardian recovery. /recover/:handle
              lets a recovering user (no working passkey) drive the
              state machine through their guardians. */}
          <Route path="/recover/:handle"     element={<Recovery />} />
          {/* Wave 4 — encrypted claim links. Public so a recipient with no
              prior Blank wallet can open the URL, create a passkey, and claim. */}
          <Route path="/claim/:chainId/:linkId" element={<ClaimLinkPage />} />
          {/* Wave 4 — storefront. Public so a buyer with no Blank wallet can
              open the URL, create a passkey, and pay/bid. */}
          <Route path="/shop/:chainId/:listingId" element={<StorefrontPage />} />
          {/* Wave 4 — public crowdfund contributor page. */}
          <Route path="/fund/:chainId/:campaignId" element={<CrowdfundPage />} />
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
      {/* Wave 5 Block 7 — install prompt lives outside Suspense so it
          renders even while a route chunk is still loading. Auto-hides
          if the user is already in standalone PWA mode. */}
      <PwaInstallPrompt />
    </ErrorBoundary>
  );
}
