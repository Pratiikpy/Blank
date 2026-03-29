import { lazy, Suspense, useEffect } from "react";
import { Routes, Route, useLocation, Link } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { useAccount, useSwitchChain } from "wagmi";
import { Navbar } from "@/components/layout/Navbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { FlashlightEffect } from "@/components/common/FlashlightEffect";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";

// Lazy-loaded page components for code splitting
const DashboardPage = lazy(() => import("./pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const SendPage = lazy(() => import("./pages/SendPage").then(m => ({ default: m.SendPage })));
const RequestPage = lazy(() => import("./pages/RequestPage").then(m => ({ default: m.RequestPage })));
const ReceivePage = lazy(() => import("./pages/ReceivePage").then(m => ({ default: m.ReceivePage })));
const GroupsPage = lazy(() => import("./pages/GroupsPage").then(m => ({ default: m.GroupsPage })));
const CreatorsPage = lazy(() => import("./pages/CreatorsPage").then(m => ({ default: m.CreatorsPage })));
const BusinessPage = lazy(() => import("./pages/BusinessPage").then(m => ({ default: m.BusinessPage })));
const ExchangePage = lazy(() => import("./pages/ExchangePage").then(m => ({ default: m.ExchangePage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then(m => ({ default: m.PrivacyPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const StealthPage = lazy(() => import("./pages/StealthPage").then(m => ({ default: m.StealthPage })));
const CompliancePage = lazy(() => import("./pages/CompliancePage").then(m => ({ default: m.CompliancePage })));
const PayPage = lazy(() => import("./pages/PayPage").then(m => ({ default: m.PayPage })));
const CheckoutPage = lazy(() => import("./pages/CheckoutPage").then(m => ({ default: m.CheckoutPage })));
const GiftMoneyPage = lazy(() => import("./pages/GiftMoneyPage").then(m => ({ default: m.GiftMoneyPage })));
const SwapPage = lazy(() => import("./pages/SwapPage").then(m => ({ default: m.SwapPage })));

export default function DesktopApp() {
  const location = useLocation();
  const { isConnected, chain } = useAccount();
  const { switchChain } = useSwitchChain();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // ─── Standalone routes (no sidebar/navbar, no wallet required) ───────
  if (location.pathname === "/checkout") {
    return (
      <div className="min-h-dvh">
        <FlashlightEffect />
        <CheckoutPage />
      </div>
    );
  }

  // ─── Wrong network gate ──────────────────────────────────────────────
  if (isConnected && chain?.id !== 84532) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="text-center max-w-md p-8">
          <h1 className="text-2xl font-semibold text-white mb-4">Wrong Network</h1>
          <p className="text-neutral-400 mb-6">Please switch to Base Sepolia (Chain ID: 84532) to use Blank.</p>
          <button
            onClick={() => switchChain?.({ chainId: 84532 })}
            className="px-8 py-4 rounded-full bg-white text-black font-semibold text-sm inline-flex items-center gap-2 hover:bg-white/90 transition-colors duration-200"
          >
            Switch to Base Sepolia
          </button>
        </div>
      </div>
    );
  }

  // ─── Pre-connect: Full-screen landing page (no sidebar, no navbar) ───
  if (!isConnected) {
    return (
      <div className="min-h-dvh">
        <FlashlightEffect />
        <ConnectPrompt />
      </div>
    );
  }

  // ─── Post-connect: App shell with sidebar + navbar ───────────────────
  return (
    <div className="min-h-dvh flex flex-col bg-black">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:rounded-lg focus:font-semibold"
      >
        Skip to main content
      </a>
      <Navbar />
      <div className="flex flex-1 pt-16">
        <Sidebar />
        <main id="main-content" className="flex-1 ml-60 p-8">
          <div className="max-w-5xl mx-auto">
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
                    <Route path="/send" element={<SendPage />} />
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
          </div>
        </main>
      </div>
    </div>
  );
}
