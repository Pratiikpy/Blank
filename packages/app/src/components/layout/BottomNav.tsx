import { useLocation, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { LayoutDashboard, Send, QrCode, Users, Settings } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Nav Items ───────────────────────────────────────────────────────

const navItems = [
  { path: "/", label: "Home", icon: LayoutDashboard },
  { path: "/send", label: "Send", icon: Send },
  { path: "/receive", label: "Receive", icon: QrCode },
  { path: "/groups", label: "Groups", icon: Users },
  { path: "/settings", label: "More", icon: Settings },
];

// ─── Component ───────────────────────────────────────────────────────

export function BottomNav() {
  const location = useLocation();

  return (
    <nav
      className={cn(
        "fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 z-50",
        "w-[90%] max-w-sm",
        "bg-apple-gray6/80 backdrop-blur-2xl",
        "border border-white/[0.08] rounded-[2rem]",
        "shadow-[0_20px_40px_rgba(0,0,0,0.5)]",
        "flex items-center justify-around px-2 py-2"
      )}
      aria-label="Main navigation"
    >
      {navItems.map((item) => {
        const isActive = location.pathname === item.path;
        const Icon = item.icon;

        return (
          <Link
            key={item.path}
            to={item.path}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex flex-col items-center justify-center",
              "min-w-[44px] min-h-[44px] p-3 rounded-full",
              "transition-[colors,transform,opacity] active:scale-90 active:opacity-70",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:rounded-full"
            )}
          >
            <Icon
              className={cn(
                "transition-colors",
                isActive ? "text-white" : "text-apple-secondary"
              )}
              size={22}
              strokeWidth={isActive ? 2.5 : 2}
            />
            {isActive && (
              <motion.span
                layoutId="mobile-nav-dot"
                className="w-1 h-1 bg-white rounded-full mt-1.5"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            {!isActive && <span className="h-1 mt-1.5" />}
          </Link>
        );
      })}
    </nav>
  );
}
