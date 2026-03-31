import { lazy, Suspense } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/hooks/useMediaQuery";
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
const navItems = [
  { path: "/", label: "Home", icon: Home },
  { path: "/send", label: "Send", icon: Send },
  { path: "/history", label: "History", icon: Clock },
  { path: "/explore", label: "Explore", icon: Compass },
  { path: "/profile", label: "Profile", icon: User },
];

function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  const activePath = navItems.find((item) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname.startsWith(item.path);
  })?.path;

  return (
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
    </nav>
  );
}

// ─── 404 page ─────────────────────────────────────────────────────
function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <h1 className="text-6xl font-heading font-bold text-[var(--text-primary)] mb-4">404</h1>
      <p className="text-[var(--text-secondary)] mb-6">Page not found</p>
      <button onClick={() => navigate("/")} className="h-12 px-6 rounded-full bg-[#1D1D1F] text-white font-medium">
        Go Home
      </button>
    </div>
  );
}

// ─── Routes that should hide the bottom nav ────────────────────────
const hideNavRoutes = ["/send/amount", "/send/confirm", "/send/success", "/tx/"];

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

  // Network mismatch warning
  if (isConnected && chain?.id !== 11155111) {
    return (
      <div className="blank-app min-h-dvh flex items-center justify-center px-6">
        <div className="glass-card-static rounded-[2rem] p-10 max-w-md text-center">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-6">
            <AlertTriangle size={32} className="text-amber-500" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Wrong Network</h2>
          <p className="text-[var(--text-secondary)] mb-6">Please switch to Ethereum Sepolia to use Blank Pay.</p>
          <button
            onClick={() => switchChain?.({ chainId: 11155111 })}
            className="h-14 w-full rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
            aria-label="Switch to Ethereum Sepolia network"
          >
            Switch to Ethereum Sepolia
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
              <Route path="/" element={<Dashboard />} />
              <Route path="/send" element={<SendContacts />} />
              <Route path="/send/amount" element={<SendAmount />} />
              <Route path="/send/confirm" element={<SendConfirm />} />
              <Route path="/send/success" element={<SendSuccess />} />
              <Route path="/receive" element={<Receive />} />
              <Route path="/history" element={<History />} />
              <Route path="/explore" element={<Explore />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/stealth" element={<Stealth />} />
              <Route path="/gifts" element={<Gifts />} />
              <Route path="/swap" element={<Swap />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/business" element={<BusinessTools />} />
              <Route path="/creators" element={<CreatorSupport />} />
              <Route path="/inheritance" element={<InheritancePlanning />} />
              <Route path="/requests" element={<Requests />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help" element={<Help />} />
              <Route path="/tx/:id" element={<TransactionDetail />} />
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
