import { useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Send,
  ArrowDownToLine,
  Users,
  Heart,
  Gift,
  EyeOff,
  Briefcase,
  Shield,
  ArrowLeftRight,
  RefreshCw,
  ShieldCheck,
  Scale,
  Settings,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

type NavItem = {
  path: string;
  label: string;
  icon: typeof LayoutDashboard;
};

// ─── Navigation Structure ───────────────────────────────────────────

const primaryItems: NavItem[] = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/send", label: "Send", icon: Send },
  { path: "/receive", label: "Receive", icon: ArrowDownToLine },
];

const featureItems: NavItem[] = [
  { path: "/groups", label: "Groups", icon: Users },
  { path: "/gifts", label: "Gifts", icon: Gift },
  { path: "/creators", label: "Creators", icon: Heart },
  { path: "/stealth", label: "Stealth", icon: EyeOff },
];

const businessItems: NavItem[] = [
  { path: "/business", label: "Invoices & Payroll", icon: Briefcase },
  { path: "/escrow", label: "Escrow", icon: Shield },
  { path: "/exchange", label: "Exchange", icon: ArrowLeftRight },
  { path: "/swap", label: "Swap", icon: RefreshCw },
];

const settingsItems: NavItem[] = [
  { path: "/privacy", label: "Privacy", icon: ShieldCheck },
  { path: "/compliance", label: "Compliance", icon: Scale },
  { path: "/settings", label: "Settings", icon: Settings },
];

// ─── NavLink Component ──────────────────────────────────────────────

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      to={item.path}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 px-4 py-3 rounded-xl text-[14px] tracking-tight",
        "transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20",
        isActive
          ? "text-white font-semibold"
          : "text-apple-secondary hover:text-white hover:bg-apple-gray5/50 font-medium"
      )}
    >
      {isActive && (
        <motion.div
          layoutId="sidebar-pill"
          className="absolute inset-0 bg-apple-gray5 rounded-xl shadow-sm"
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        />
      )}
      <Icon
        className="relative z-10 shrink-0"
        size={18}
        strokeWidth={isActive ? 2.5 : 2}
      />
      <span className="relative z-10">{item.label}</span>
    </Link>
  );
}

// ─── Collapsible Section ────────────────────────────────────────────

function CollapsibleSection({
  id,
  label,
  items,
  isOpen,
  onToggle,
  pathname,
}: {
  id: string;
  label: string;
  items: NavItem[];
  isOpen: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`section-${id}`}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded-lg"
        )}
      >
        <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider">
          {label}
        </span>
        <ChevronDown
          className={cn(
            "w-3 h-3 text-neutral-600 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={`section-${id}`}
            role="group"
            aria-label={label}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-0.5">
              {items.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  isActive={pathname === item.path}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────

export function Sidebar() {
  const location = useLocation();
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (featureItems.some((item) => item.path === location.pathname)) initial.add("features");
    if (businessItems.some((item) => item.path === location.pathname)) initial.add("business");
    return initial;
  });

  const toggleSection = (section: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  return (
    <aside className="fixed left-0 top-16 bottom-0 w-60 border-r border-white/[0.05] bg-apple-gray6/30 backdrop-blur-3xl flex flex-col">
      <nav
        className="flex-1 px-3 py-6 overflow-y-auto space-y-1"
        aria-label="Sidebar navigation"
      >
        {/* ── Primary (always visible) ── */}
        <div className="pb-2">
          <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider px-3">
            Overview
          </span>
        </div>
        <div className="space-y-0.5">
          {primaryItems.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              isActive={location.pathname === item.path}
            />
          ))}
        </div>

        {/* ── Divider ── */}
        <div className="pt-4" />

        {/* ── Features (collapsible, default closed) ── */}
        <CollapsibleSection
          id="features"
          label="Features"
          items={featureItems}
          isOpen={openSections.has("features")}
          onToggle={() => toggleSection("features")}
          pathname={location.pathname}
        />

        {/* ── Divider ── */}
        <div className="pt-2" />

        {/* ── Business (collapsible, default closed) ── */}
        <CollapsibleSection
          id="business"
          label="Business"
          items={businessItems}
          isOpen={openSections.has("business")}
          onToggle={() => toggleSection("business")}
          pathname={location.pathname}
        />
      </nav>

      {/* ── Settings (pinned to bottom, always visible) ── */}
      <div className="mt-auto border-t border-white/[0.05] px-3 py-4">
        <div className="pb-2">
          <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider px-3">
            Settings
          </span>
        </div>
        <div className="space-y-0.5">
          {settingsItems.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              isActive={location.pathname === item.path}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
