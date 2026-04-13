import { lazy, Suspense, useState } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useSwitchChain } from "wagmi";
import {
  Home,
  Send,
  Clock,
  Compass,
  User,
  AlertTriangle,
  MoreHorizontal,
  X,
  Briefcase,
  Heart,
  ArrowLeftRight,
  EyeOff,
  Gift,
  Timer,
  ShieldCheck,
  Sparkles,
  Fingerprint,
  Settings as SettingsIcon,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { SUPPORTED_CHAIN_ID, ACTIVE_CHAIN } from "@/lib/constants";
import { ChainSelector } from "./components/ChainSelector";
import "./theme.css";

// Lazy load all screens
const Onboarding = lazy(() => import("./screens/Onboarding"));
const Dashboard = lazy(() => import("./screens/Dashboard"));
const SendContacts = lazy(() => import("./screens/SendContacts"));
const SendAmount = lazy(() => import("./screens/SendAmount"));
const SendConfirm = lazy(() => import("./screens/SendConfirm"));
const SendSuccess = lazy(() => import("./screens/SendSuccess"));
const Receive = lazy(() => import("./screens/Receive"));
const History = lazy(() => import("./screens/History"));
const Explore = lazy(() => import("./screens/Explore"));
const Profile = lazy(() => import("./screens/Profile"));
const Groups = lazy(() => import("./screens/Groups"));
const Stealth = lazy(() => import("./screens/Stealth"));
const Gifts = lazy(() => import("./screens/Gifts"));
const Swap = lazy(() => import("./screens/Swap"));
const Analytics = lazy(() => import("./screens/Analytics"));
const BusinessTools = lazy(() => import("./screens/BusinessTools"));
const CreatorSupport = lazy(() => import("./screens/CreatorSupport"));
const InheritancePlanning = lazy(() => import("./screens/InheritancePlanning"));
const Requests = lazy(() => import("./screens/Requests"));
const Contacts = lazy(() => import("./screens/Contacts"));
const Privacy = lazy(() => import("./screens/Privacy"));
const Proofs = lazy(() => import("./screens/Proofs"));
const AgentPayments = lazy(() => import("./screens/AgentPayments"));
const SmartWallet = lazy(() => import("./screens/SmartWallet"));
const Settings = lazy(() => import("./screens/Settings"));
const Help = lazy(() => import("./screens/Help"));
const TransactionDetail = lazy(() => import("./screens/TransactionDetail"));

// Desktop sidebar
import { DesktopSidebar } from "./components/DesktopSidebar";

// Global search
import { GlobalSearch } from "./components/GlobalSearch";

// ─── Loading spinner ───────────────────────────────────────────────
function LoadingSpinner() {
  return (
    <div className="min-h-dvh flex items-center justify-center">
      <div className="w-8 h-8 border-3 border-emerald-100 border-t-emerald-500 rounded-full animate-spin" />
    </div>
  );
}

// ─── Bottom navigation (mobile only) ──────────────────────────────
//
// Five tabs visible on mobile. The fifth ("More") opens a sheet with
// every desktop sidebar item that isn't in the bottom 5 — so mobile
// users have access to everything (Proofs, AI Agents, Smart Wallet,
// Business, Creators, Stealth, Gifts, Inheritance, Swap, Settings, Help).
const navItems = [
  { path: "/app", label: "Home", icon: Home },
  { path: "/app/send", label: "Send", icon: Send },
  { path: "/app/history", label: "History", icon: Clock },
  { path: "/app/explore", label: "Explore", icon: Compass },
];

const moreItems = [
  { path: "/app/profile",     label: "Profile",          icon: User },
  { path: "/app/wallet",      label: "Smart Wallet",     icon: Fingerprint },
  { path: "/app/proofs",      label: "Encrypted Proofs", icon: ShieldCheck },
  { path: "/app/agents",      label: "AI Agents",        icon: Sparkles },
  { path: "/app/business",    label: "Business Tools",   icon: Briefcase },
  { path: "/app/creators",    label: "Creator Support",  icon: Heart },
  { path: "/app/swap",        label: "P2P Exchange",     icon: ArrowLeftRight },
  { path: "/app/stealth",     label: "Stealth Payments", icon: EyeOff },
  { path: "/app/gifts",       label: "Gift Envelopes",   icon: Gift },
  { path: "/app/inheritance", label: "Inheritance",      icon: Timer },
  { path: "/app/settings",    label: "Settings",         icon: SettingsIcon },
  { path: "/app/help",        label: "Help & FAQ",       icon: HelpCircle },
];

function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);

  const activePath = navItems.find((item) => {
    if (item.path === "/app") return location.pathname === "/app";
    return location.pathname.startsWith(item.path);
  })?.path;

  const onMoreRoute = moreItems.some((m) => location.pathname.startsWith(m.path));

  return (
    <>
      <nav className="bottom-nav" aria-label="Main navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activePath === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn("bottom-nav-item", isActive && "active")}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={22} strokeWidth={isActive ? 2.2 : 1.8} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => setMoreOpen(true)}
          className={cn("bottom-nav-item", onMoreRoute && "active")}
          aria-label="More"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
        >
          <MoreHorizontal size={22} strokeWidth={onMoreRoute ? 2.2 : 1.8} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[90] flex items-end animate-in fade-in duration-150"
          onClick={() => setMoreOpen(false)}
          style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-white dark:bg-[#0F0F10] rounded-t-[2.5rem] border-t border-black/10 dark:border-white/10 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] max-h-[85dvh] overflow-y-auto animate-in slide-in-from-bottom duration-200"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-heading font-semibold text-[var(--text-primary)]">More</h2>
              <button
                onClick={() => setMoreOpen(false)}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            {/* Chain selector — also fixes the desktop-only chain switcher gap */}
            <div className="mb-5 -mx-2">
              <ChainSelector />
            </div>

            <div className="grid grid-cols-3 gap-2">
              {moreItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => {
                      setMoreOpen(false);
                      navigate(item.path);
                    }}
                    className={cn(
                      "flex flex-col items-center gap-2 p-3 rounded-2xl transition-colors",
                      isActive
                        ? "bg-black/[0.07] dark:bg-white/[0.08] text-[var(--text-primary)]"
                        : "hover:bg-black/[0.04] dark:hover:bg-white/[0.04] text-[var(--text-secondary)]",
                    )}
                  >
                    <Icon size={22} strokeWidth={isActive ? 2.2 : 1.8} />
                    <span className="text-[11px] font-medium leading-tight text-center">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── 404 page ─────────────────────────────────────────────────────
function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <h1 className="text-6xl font-heading font-bold text-[var(--text-primary)] mb-4">404</h1>
      <p className="text-[var(--text-secondary)] mb-6">Page not found</p>
      <button onClick={() => navigate("/app")} className="h-12 px-6 rounded-full bg-[#1D1D1F] text-white font-medium">
        Go Home
      </button>
    </div>
  );
}

// ─── Routes that should hide the bottom nav ────────────────────────
const hideNavRoutes = ["/app/send/amount", "/app/send/confirm", "/app/send/success", "/app/tx/"];

// ─── Main app shell ────────────────────────────────────────────────
export function BlankApp() {
  const { isConnected, chain } = useAccount();
  const { switchChain } = useSwitchChain();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 768px)");

  // Show onboarding when not connected
  if (!isConnected) {
    return (
      <div className="blank-app">
        <Suspense fallback={<LoadingSpinner />}>
          <Onboarding />
        </Suspense>
      </div>
    );
  }

  // Network mismatch warning — active chain is chosen via the chain selector
  // and persisted to localStorage. This guard enforces the wallet is on the
  // same chain so reads/writes route to the correct addresses.
  if (isConnected && chain?.id !== SUPPORTED_CHAIN_ID) {
    return (
      <div className="blank-app min-h-dvh flex items-center justify-center px-6">
        <div className="glass-card-static rounded-[2rem] p-10 max-w-md text-center">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-6">
            <AlertTriangle size={32} className="text-amber-500" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Wrong Network</h2>
          <p className="text-[var(--text-secondary)] mb-6">Please switch to {ACTIVE_CHAIN.name} to use Blank Pay.</p>
          <button
            onClick={() => switchChain?.({ chainId: SUPPORTED_CHAIN_ID })}
            className="h-14 w-full rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
            aria-label={`Switch to ${ACTIVE_CHAIN.name} network`}
          >
            Switch to {ACTIVE_CHAIN.name}
          </button>
        </div>
      </div>
    );
  }

  const showNav = !hideNavRoutes.some((r) =>
    location.pathname.startsWith(r),
  );

  return (
    <div className="blank-app">
      {/* Desktop: fixed sidebar */}
      {!isMobile && <DesktopSidebar />}

      <main className={cn("min-h-dvh", !isMobile && "ml-72")}>
        <Suspense fallback={<LoadingSpinner />}>
          <div className={cn("p-8", isMobile && "pb-20 p-4")}>
            {/* Global Search — desktop: full bar, mobile: compact icon that expands */}
            {isMobile ? (
              <div className="flex justify-end mb-4">
                <GlobalSearch compact />
              </div>
            ) : (
              <div className="max-w-xl mb-6">
                <GlobalSearch />
              </div>
            )}
            <Routes>
              <Route path="/app" element={<Dashboard />} />
              <Route path="/app/send" element={<SendContacts />} />
              <Route path="/app/send/amount" element={<SendAmount />} />
              <Route path="/app/send/confirm" element={<SendConfirm />} />
              <Route path="/app/send/success" element={<SendSuccess />} />
              <Route path="/app/receive" element={<Receive />} />
              <Route path="/app/history" element={<History />} />
              <Route path="/app/explore" element={<Explore />} />
              <Route path="/app/profile" element={<Profile />} />
              <Route path="/app/groups" element={<Groups />} />
              <Route path="/app/stealth" element={<Stealth />} />
              <Route path="/app/gifts" element={<Gifts />} />
              <Route path="/app/swap" element={<Swap />} />
              <Route path="/app/analytics" element={<Analytics />} />
              <Route path="/app/business" element={<BusinessTools />} />
              <Route path="/app/creators" element={<CreatorSupport />} />
              <Route path="/app/inheritance" element={<InheritancePlanning />} />
              <Route path="/app/requests" element={<Requests />} />
              <Route path="/app/contacts" element={<Contacts />} />
              <Route path="/app/privacy" element={<Privacy />} />
              <Route path="/app/proofs" element={<Proofs />} />
              <Route path="/app/agents" element={<AgentPayments />} />
              <Route path="/app/wallet" element={<SmartWallet />} />
              <Route path="/app/settings" element={<Settings />} />
              <Route path="/app/help" element={<Help />} />
              <Route path="/app/tx/:id" element={<TransactionDetail />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </div>
        </Suspense>
      </main>

      {/* Mobile: bottom nav */}
      {isMobile && showNav && <BottomNav />}
    </div>
  );
}
