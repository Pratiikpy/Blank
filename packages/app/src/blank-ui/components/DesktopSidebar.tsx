import { useState, useCallback, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Wallet,
  Send,
  Users,
  Heart,
  Briefcase,
  ArrowLeftRight,
  EyeOff,
  Gift,
  Timer,
  ShieldCheck,
  Sparkles,
  Fingerprint,
  Settings,
  HelpCircle,
  Sun,
  Moon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { BlankLogo } from "@/blank-ui/landing/BlankLogo";
import { ChainSelector } from "./ChainSelector";
import "@/blank-ui/landing/landing.css"; // pulls in .bl-wordmark + .bl-lockup styles

// ═══════════════════════════════════════════════════════════════════
//  NAV ITEMS — 10 items matching the reference design
// ═══════════════════════════════════════════════════════════════════

interface NavItem {
  icon: LucideIcon;
  label: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { icon: Wallet, label: "Dashboard", path: "/app" },
  { icon: Send, label: "Send & Receive", path: "/app/send" },
  { icon: Users, label: "Group Expenses", path: "/app/groups" },
  { icon: Heart, label: "Creator Support", path: "/app/creators" },
  { icon: Briefcase, label: "Business Tools", path: "/app/business" },
  { icon: ArrowLeftRight, label: "P2P Exchange", path: "/app/swap" },
  { icon: EyeOff, label: "Stealth Payments", path: "/app/stealth" },
  { icon: Gift, label: "Gift Envelopes", path: "/app/gifts" },
  { icon: Timer, label: "Inheritance", path: "/app/inheritance" },
  { icon: ShieldCheck, label: "Encrypted Proofs", path: "/app/proofs" },
  { icon: Sparkles, label: "AI Agents", path: "/app/agents" },
  { icon: Fingerprint, label: "Smart Wallet", path: "/app/wallet" },
  { icon: Settings, label: "Settings", path: "/app/settings" },
  { icon: HelpCircle, label: "Help & FAQ", path: "/app/help" },
];

// ═══════════════════════════════════════════════════════════════════
//  SIDEBAR
// ═══════════════════════════════════════════════════════════════════

export function DesktopSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [privacyMode, setPrivacyMode] = useState(true);
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("blank_dark_mode") === "true";
  });

  const isActive = (path: string): boolean => {
    if (path === "/app") return location.pathname === "/app";
    return location.pathname.startsWith(path);
  };

  const togglePrivacy = useCallback(() => {
    setPrivacyMode((prev) => !prev);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem("blank_dark_mode", String(next));
      if (next) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      return next;
    });
  }, []);

  // On mount, apply saved dark mode preference
  useEffect(() => {
    if (darkMode) document.documentElement.classList.add("dark");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside
      className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 z-40 w-72 glass-sidebar"
    >
      {/* ── Logo ─────────────────────────────────────────── */}
      <div
        className="flex items-center px-6 py-6 text-[var(--text-primary)]"
      >
        <BlankLogo variant="lockup" size={26} wordmarkSize="1.35rem" />
      </div>

      {/* ── Privacy Toggle ───────────────────────────────── */}
      <div className="px-4 mb-2">
        <button
          onClick={togglePrivacy}
          className="privacy-toggle w-full flex items-center justify-between cursor-pointer"
          aria-label={privacyMode ? "Disable privacy mode" : "Enable privacy mode"}
        >
          <span className="text-body font-medium text-[var(--text-primary)]">
            {privacyMode ? "Privacy Mode" : "Public Mode"}
          </span>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors duration-200",
              privacyMode ? "bg-emerald-500" : "bg-[var(--bg-tertiary)]"
            )}
          >
            <div
              className={cn(
                "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200",
                privacyMode ? "translate-x-[22px]" : "translate-x-0.5"
              )}
            />
          </div>
        </button>
      </div>

      {/* ── Navigation ───────────────────────────────────── */}
      <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.path);

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                "relative flex items-center gap-3 w-full transition-all duration-200",
                active ? "nav-item-active" : "nav-item-inactive"
              )}
              style={{
                background: active ? "var(--nav-active-bg)" : undefined,
                border: "none",
                cursor: "pointer",
              }}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
            >
              <item.icon
                size={20}
                strokeWidth={active ? 2.2 : 1.8}
                className="flex-shrink-0"
              />
              <span
                className={cn(
                  "text-sm whitespace-nowrap",
                  active ? "font-semibold" : "font-medium"
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* ── Footer ───────────────────────────────────────── */}
      <div className="px-4 pb-6 space-y-3">
        {/* Chain selector */}
        <ChainSelector />

        {/* Theme toggle */}
        <button
          onClick={toggleDarkMode}
          className="flex items-center gap-3 w-full px-4 py-2.5 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          style={{ background: "transparent", border: "none", cursor: "pointer" }}
          aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
        >
          {darkMode ? (
            <Sun size={18} className="text-[var(--text-secondary)]" />
          ) : (
            <Moon size={18} className="text-[var(--text-secondary)]" />
          )}
          <span className="text-sm text-[var(--text-secondary)]">
            {darkMode ? "Light Mode" : "Dark Mode"}
          </span>
        </button>

        {/* FHE Active status pill */}
        <div className="fhe-status-pill">
          <span className="fhe-status-dot" />
          FHE Active
        </div>
      </div>
    </aside>
  );
}

export default DesktopSidebar;
