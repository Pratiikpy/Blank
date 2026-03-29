import { lazy, Suspense } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  Home,
  Send,
  Clock,
  Compass,
  User,
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

// Desktop sidebar
import { DesktopSidebar } from "./components/DesktopSidebar";

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

// ─── Routes that should hide the bottom nav ────────────────────────
const hideNavRoutes = ["/send/amount", "/send/confirm", "/send/success"];

// ─── Main app shell ────────────────────────────────────────────────
export function BlankApp() {
  const { isConnected } = useAccount();
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
            </Routes>
          </div>
        </Suspense>
      </main>

      {/* Mobile: bottom nav */}
      {isMobile && showNav && <BottomNav />}
    </div>
  );
}
