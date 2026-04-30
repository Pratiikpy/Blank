import type { LucideIcon } from "lucide-react";
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
  Settings as SettingsIcon,
  HelpCircle,
  Clock,
  Compass,
  User,
  Flame,
  CalendarClock,
  BarChart3,
  Inbox,
  BookUser,
  Lock,
} from "lucide-react";
import type { WorkspaceMode } from "./workspace-mode";

// Single source of truth for every navigable route in the app. The
// desktop sidebar, mobile bottom-nav, mobile "More" sheet, and any
// future search must read from here — no hardcoded copies anywhere.
//
// `modes` controls VISIBILITY only. A route hidden from the current
// mode is still mounted in BlankApp's <Routes>, so direct URL hits keep
// working (someone clicks a payment link / shares a deep-link / has the
// route bookmarked). The registry is presentation, not authorization.
//
// Mode picks (intentional, not exhaustive):
//   freelancer — just enough to invoice a client and get paid privately
//   business   — adds payroll/escrow/groups/analytics for teams
//   privacy    — leads with stealth/burners/inheritance/proofs
//   full       — every screen
//
// `category` groups items in the sidebar. Within a category, items
// render in the order they appear here.
export type NavCategory = "core" | "payments" | "privacy" | "tools" | "account";

export interface NavItem {
  /** Path under /app — full path is `/app${path}` (or `/app` if `path === ""`). */
  path: string;
  label: string;
  icon: LucideIcon;
  category: NavCategory;
  /** Modes in which this item appears in nav. Direct URLs work regardless. */
  modes: WorkspaceMode[];
  /** Show in the desktop sidebar's primary list. */
  desktopPrimary?: boolean;
  /** Show in the mobile bottom-nav (max 4 items + a "More" tab). */
  mobilePrimary?: boolean;
}

const ALL_MODES: WorkspaceMode[] = ["freelancer", "business", "privacy", "full"];

export const NAV_REGISTRY: NavItem[] = [
  // ── Core (everyone, every mode) ─────────────────────────────────
  {
    path: "/app",
    label: "Dashboard",
    icon: Wallet,
    category: "core",
    modes: ALL_MODES,
    desktopPrimary: true,
    mobilePrimary: true,
  },
  {
    path: "/app/send",
    label: "Send & Receive",
    icon: Send,
    category: "core",
    modes: ALL_MODES,
    desktopPrimary: true,
    mobilePrimary: true,
  },
  {
    path: "/app/history",
    label: "History",
    icon: Clock,
    category: "core",
    modes: ALL_MODES,
    desktopPrimary: true,
    mobilePrimary: true,
  },
  {
    path: "/app/explore",
    label: "Explore",
    icon: Compass,
    category: "core",
    modes: ["full"],
    desktopPrimary: false,
    mobilePrimary: true,
  },

  // ── Payments / business (Freelancer + Business + Full) ──────────
  {
    path: "/app/business",
    label: "Business Tools",
    icon: Briefcase,
    category: "payments",
    modes: ["freelancer", "business", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/groups",
    label: "Group Expenses",
    icon: Users,
    category: "payments",
    modes: ["business", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/creators",
    label: "Creator Support",
    icon: Heart,
    category: "payments",
    modes: ["full"],
    desktopPrimary: true,
  },
  {
    path: "/app/swap",
    label: "P2P Exchange",
    icon: ArrowLeftRight,
    category: "payments",
    modes: ["business", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/requests",
    label: "Requests",
    icon: Inbox,
    category: "payments",
    modes: ["freelancer", "business", "full"],
    desktopPrimary: false,
  },
  {
    path: "/app/contacts",
    label: "Contacts",
    icon: BookUser,
    category: "payments",
    modes: ["freelancer", "business", "full"],
    desktopPrimary: false,
  },

  // ── Privacy-first features ──────────────────────────────────────
  {
    path: "/app/stealth",
    label: "Stealth Payments",
    icon: EyeOff,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/burners",
    label: "Burner Wallets",
    icon: Flame,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: false,
  },
  {
    path: "/app/inheritance",
    label: "Inheritance",
    icon: Timer,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/proofs",
    label: "Encrypted Proofs",
    icon: ShieldCheck,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: true,
  },
  {
    path: "/app/privacy",
    label: "Privacy Settings",
    icon: Lock,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: false,
  },
  {
    path: "/app/gifts",
    label: "Gift Envelopes",
    icon: Gift,
    category: "privacy",
    modes: ["privacy", "full"],
    desktopPrimary: true,
  },

  // ── Tools (mostly Business + Full) ──────────────────────────────
  {
    path: "/app/scheduled",
    label: "Scheduled Sends",
    icon: CalendarClock,
    category: "tools",
    modes: ["business", "full"],
    desktopPrimary: false,
  },
  {
    path: "/app/agents",
    label: "AI Agents",
    icon: Sparkles,
    category: "tools",
    modes: ["full"],
    desktopPrimary: true,
  },
  {
    path: "/app/analytics",
    label: "Analytics",
    icon: BarChart3,
    category: "tools",
    modes: ["business", "full"],
    desktopPrimary: false,
  },

  // ── Account (everyone) ──────────────────────────────────────────
  {
    path: "/app/profile",
    label: "Profile",
    icon: User,
    category: "account",
    modes: ALL_MODES,
    desktopPrimary: false,
  },
  {
    path: "/app/wallet",
    label: "Smart Wallet",
    icon: Fingerprint,
    category: "account",
    modes: ALL_MODES,
    desktopPrimary: true,
  },
  {
    path: "/app/settings",
    label: "Settings",
    icon: SettingsIcon,
    category: "account",
    modes: ALL_MODES,
    desktopPrimary: true,
  },
  {
    path: "/app/help",
    label: "Help & FAQ",
    icon: HelpCircle,
    category: "account",
    modes: ALL_MODES,
    desktopPrimary: true,
  },
];

/** All routes this mode shows in nav. Order matches the registry. */
export function filterByMode(mode: WorkspaceMode): NavItem[] {
  return NAV_REGISTRY.filter((item) => item.modes.includes(mode));
}

/** The desktop sidebar's primary list for `mode` (in registry order). */
export function desktopSidebarItems(mode: WorkspaceMode): NavItem[] {
  return NAV_REGISTRY.filter(
    (item) => item.modes.includes(mode) && item.desktopPrimary,
  );
}

/** The mobile "More" sheet — anything visible in this mode that isn't already in the bottom-nav primary slots. */
export function mobileMoreItems(mode: WorkspaceMode): NavItem[] {
  return NAV_REGISTRY.filter(
    (item) => item.modes.includes(mode) && !item.mobilePrimary,
  );
}

/** The mobile bottom-nav primary slots for `mode` (typically 3-4 items). */
export function mobileBottomItems(mode: WorkspaceMode): NavItem[] {
  return NAV_REGISTRY.filter(
    (item) => item.modes.includes(mode) && item.mobilePrimary,
  );
}
