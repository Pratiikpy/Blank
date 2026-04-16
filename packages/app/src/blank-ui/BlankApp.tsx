import { lazy, Suspense, useState, useEffect } from "react";
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
  Bell,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { SupportedChainId } from "@/lib/constants";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useChain } from "@/providers/ChainProvider";
import { useMyRoles } from "@/hooks/useMyRoles";
import { MyRolesPanel } from "@/components/MyRolesPanel";
import { ChainSelector } from "./components/ChainSelector";
import { useSmartAccount } from "@/hooks/useSmartAccount";
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

// ─── Roles bell — opens the "Roles assigned to you" modal ─────────
//
// Phase 2 root-pattern fix: proactively surfaces every role the user holds
// (arbiter, heir, group member, incoming invoice/request, escrow
// beneficiary) from a single mount-time sweep in useMyRoles.
function RolesBell() {
  const [open, setOpen] = useState(false);
  const { unreadCount, markAllSeen } = useMyRoles();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all flex-shrink-0"
        aria-label={
          unreadCount > 0
            ? `Roles assigned to you · ${unreadCount} new`
            : "Roles assigned to you"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell size={18} className="text-[var(--text-primary)]" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 border-2 border-white dark:border-[#0F0F10] flex items-center justify-center text-[10px] font-bold text-white leading-none tabular-nums"
            aria-hidden="true"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Roles assigned to you"
          className="fixed inset-0 z-[95] flex items-start justify-center p-4 sm:p-8 animate-in fade-in duration-150"
          onClick={() => setOpen(false)}
          style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg mt-4 sm:mt-16 animate-in slide-in-from-top-4 duration-200"
          >
            <div className="flex items-center justify-between mb-4 px-1">
              <h2 className="text-lg font-heading font-semibold text-white drop-shadow-sm">
                Roles assigned to you
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 border border-white/30 flex items-center justify-center text-white transition-colors backdrop-blur-sm"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <MyRolesPanel onNavigate={() => setOpen(false)} className="backdrop-blur-xl bg-white/90 dark:bg-[#1a1a1a]/90 border border-white/20 dark:border-white/10 shadow-2xl" />
            {unreadCount > 0 && (
              <div className="mt-3 text-center">
                <button
                  onClick={() => {
                    markAllSeen();
                    setOpen(false);
                  }}
                  className="text-xs font-medium text-white/80 hover:text-white underline underline-offset-4"
                >
                  Dismiss all
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Routes that should hide the bottom nav ────────────────────────
const hideNavRoutes = ["/app/send/amount", "/app/send/confirm", "/app/send/success", "/app/tx/"];

// Chains the app can actually talk to. Must match the set in
// src/lib/constants.ts CHAINS — duplicated here to keep BlankApp from
// importing the whole map just for a membership check.
const SUPPORTED_WALLET_CHAINS = new Set<number>([11155111, 84532]);

// ─── Main app shell ────────────────────────────────────────────────
export function BlankApp() {
  const { isConnected, isConnecting, isReconnecting, chain } = useAccount();
  const { switchChain } = useSwitchChain();
  const { activeChainId, activeChain, setActiveChain } = useChain();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 768px)");
  // R5-C: passkey-first auth. When a smart-account passkey exists for the
  // active chain, we treat the user as "authenticated" even if no EOA is
  // connected via wagmi. Onboarding still renders if neither path is
  // satisfied; once they pick one, the app shell takes over.
  const { status: smartAccountStatus, account: smartAccount } = useSmartAccount();
  const hasPasskeyAccount = smartAccountStatus === "ready" && smartAccount !== null;

  // Auto-switch app chain to match wallet — MUST be before all early returns
  // to satisfy React's hooks ordering rule. When MetaMask is on Base Sepolia
  // but app defaults to ETH Sepolia (or vice versa), silently switch the app.
  useEffect(() => {
    if (!isConnected || !chain?.id) return;
    if (chain.id === activeChainId) return;
    if (SUPPORTED_WALLET_CHAINS.has(chain.id)) {
      setActiveChain(chain.id as SupportedChainId);
    }
  }, [isConnected, chain?.id, activeChainId, setActiveChain]);

  // #322: wagmi auto-reconnect from storage is async. During that window
  // `isConnected=false` but `isReconnecting=true` — show a brief spinner
  // instead of flashing Onboarding, which is jarring on every reload.
  if (!isConnected && !hasPasskeyAccount && (isConnecting || isReconnecting)) {
    return (
      <div className="blank-app min-h-dvh flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  // Show onboarding when neither auth path is satisfied
  if (!isConnected && !hasPasskeyAccount) {
    return (
      <div className="blank-app">
        <Suspense fallback={<LoadingSpinner />}>
          <Onboarding />
        </Suspense>
      </div>
    );
  }

  // #316: if the wallet is on a chain we simply don't support (mainnet,
  // polygon, arbitrum, etc.), `switchChain?.({chainId: activeChainId})`
  // will throw a cryptic "Chain not configured" wallet error. Detect this
  // case first and guide the user to add the supported testnets.
  //
  // R5-C: this check only fires when we have a wagmi EOA — passkey-only
  // users have no `chain` from useAccount(), so we trust the ChainProvider's
  // activeChainId (already restricted to supported chains).
  const walletOnUnsupportedChain =
    isConnected && chain && !SUPPORTED_WALLET_CHAINS.has(chain.id);
  if (walletOnUnsupportedChain) {
    return (
      <div className="blank-app min-h-dvh flex items-center justify-center px-6">
        <div className="glass-card-static rounded-[2rem] p-10 max-w-md text-center">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-6">
            <AlertTriangle size={32} className="text-amber-500" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Unsupported Network</h2>
          <p className="text-[var(--text-secondary)] mb-6">
            Blank Pay runs on Ethereum Sepolia or Base Sepolia. Add one of
            these networks to your wallet and switch to it to continue.
          </p>
          <button
            onClick={() => switchChain?.({ chainId: activeChainId })}
            className="h-14 w-full rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
            aria-label={`Try switching to ${activeChain.name}`}
          >
            Try switching to {activeChain.name}
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
            {/* Top bar — Global Search + Roles bell.
                Desktop: full search bar left, bell right.
                Mobile: compact icons justified right. */}
            {isMobile ? (
              <div className="flex justify-end items-center gap-2 mb-4">
                <GlobalSearch compact />
                <RolesBell />
              </div>
            ) : (
              <div className="flex items-center gap-3 mb-6">
                <div className="max-w-xl flex-1">
                  <GlobalSearch />
                </div>
                <RolesBell />
              </div>
            )}
            {/* BlankApp is mounted at `/app/*` in App.tsx. React-router v6
                strips the parent match, so paths here are RELATIVE to /app.
                The index route matches the bare /app URL; all others use
                their suffix without a leading slash. */}
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="send" element={<SendContacts />} />
              <Route path="send/amount" element={<SendAmount />} />
              <Route path="send/confirm" element={<SendConfirm />} />
              <Route path="send/success" element={<SendSuccess />} />
              <Route path="receive" element={<Receive />} />
              <Route path="history" element={<History />} />
              <Route path="explore" element={<Explore />} />
              <Route path="profile" element={<Profile />} />
              <Route path="groups" element={<Groups />} />
              <Route path="stealth" element={<Stealth />} />
              <Route path="gifts" element={<Gifts />} />
              <Route path="swap" element={<Swap />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="business" element={<BusinessTools />} />
              <Route path="creators" element={<CreatorSupport />} />
              <Route path="inheritance" element={<InheritancePlanning />} />
              <Route path="requests" element={<Requests />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="privacy" element={<Privacy />} />
              <Route path="proofs" element={<Proofs />} />
              <Route path="agents" element={<AgentPayments />} />
              <Route path="wallet" element={<SmartWallet />} />
              <Route path="settings" element={<Settings />} />
              <Route path="help" element={<Help />} />
              <Route path="tx/:id" element={<TransactionDetail />} />
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
