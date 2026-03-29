import { lazy, Suspense } from "react";
import { Routes, Route, useLocation, Link } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useAccount } from "wagmi";
import { BottomNav } from "@/components/layout/BottomNav";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";

// Lazy-loaded page components for code splitting
const DashboardPage = lazy(() => import("@/desktop/pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const MobileSendPage = lazy(() => import("@/mobile/MobileSendPage").then(m => ({ default: m.MobileSendPage })));
const RequestPage = lazy(() => import("@/desktop/pages/RequestPage").then(m => ({ default: m.RequestPage })));
const ReceivePage = lazy(() => import("@/desktop/pages/ReceivePage").then(m => ({ default: m.ReceivePage })));
const GroupsPage = lazy(() => import("@/desktop/pages/GroupsPage").then(m => ({ default: m.GroupsPage })));
const CreatorsPage = lazy(() => import("@/desktop/pages/CreatorsPage").then(m => ({ default: m.CreatorsPage })));
const BusinessPage = lazy(() => import("@/desktop/pages/BusinessPage").then(m => ({ default: m.BusinessPage })));
const ExchangePage = lazy(() => import("@/desktop/pages/ExchangePage").then(m => ({ default: m.ExchangePage })));
const PrivacyPage = lazy(() => import("@/desktop/pages/PrivacyPage").then(m => ({ default: m.PrivacyPage })));
const SettingsPage = lazy(() => import("@/desktop/pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const StealthPage = lazy(() => import("@/desktop/pages/StealthPage").then(m => ({ default: m.StealthPage })));
const CompliancePage = lazy(() => import("@/desktop/pages/CompliancePage").then(m => ({ default: m.CompliancePage })));
const PayPage = lazy(() => import("@/desktop/pages/PayPage").then(m => ({ default: m.PayPage })));
const CheckoutPage = lazy(() => import("@/desktop/pages/CheckoutPage").then(m => ({ default: m.CheckoutPage })));
const GiftMoneyPage = lazy(() => import("@/desktop/pages/GiftMoneyPage").then(m => ({ default: m.GiftMoneyPage })));
const SwapPage = lazy(() => import("@/desktop/pages/SwapPage").then(m => ({ default: m.SwapPage })));

export default function MobileApp() {
  const location = useLocation();
  const { isConnected } = useAccount();

  // ─── Standalone routes (no bottom nav, no wallet required) ──────────
  if (location.pathname === "/checkout") {
    return (
      <div className="min-h-dvh">
        <CheckoutPage />
      </div>
    );
  }

  // Pre-connect: full-screen landing
  if (!isConnected) {
    return (
      <div className="min-h-dvh">
        <ConnectPrompt />
      </div>
    );
  }

  // Post-connect: app with bottom nav
  return (
    <div className="min-h-dvh flex flex-col pb-24">
      <main className="flex-1 px-4 pt-4">
        <ErrorBoundary>
          <Suspense fallback={
            <div>
              <div className="page-loading-bar" />
              <div className="flex items-center justify-center min-h-[60vh]">
                <div className="shimmer w-full max-w-2xl h-64 rounded-2xl" />
              </div>
            </div>
          }>
            <AnimatePresence mode="wait">
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/send" element={<MobileSendPage />} />
                <Route path="/receive" element={<ReceivePage />} />
                <Route path="/requests" element={<RequestPage />} />
                <Route path="/groups" element={<GroupsPage />} />
                <Route path="/creators" element={<CreatorsPage />} />
                <Route path="/business" element={<BusinessPage />} />
                <Route path="/exchange" element={<ExchangePage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/pay" element={<PayPage />} />
                <Route path="/stealth" element={<StealthPage />} />
                <Route path="/compliance" element={<CompliancePage />} />
                <Route path="/gifts" element={<GiftMoneyPage />} />
                <Route path="/swap" element={<SwapPage />} />
                <Route path="*" element={
                  <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                    <h1 className="text-6xl font-semibold text-white mb-4">404</h1>
                    <p className="text-apple-secondary mb-8">Page not found</p>
                    <Link to="/" className="apple-btn-primary px-6 py-3">Go Home</Link>
                  </div>
                } />
              </Routes>
            </AnimatePresence>
          </Suspense>
        </ErrorBoundary>
      </main>
      <BottomNav />
    </div>
  );
}
