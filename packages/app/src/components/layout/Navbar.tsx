import { motion } from "framer-motion";
import { useLocation, Link } from "react-router-dom";
import { Lock, ArrowRight } from "lucide-react";
import { useAccount } from "wagmi";
import { cn } from "@/lib/cn";
import { ConnectButton } from "@/components/wallet/ConnectButton";

const navItems = [
  { path: "/", label: "Home" },
  { path: "/send", label: "Send" },
  { path: "/groups", label: "Groups" },
  { path: "/business", label: "Business" },
];

export function Navbar() {
  const location = useLocation();
  const { isConnected } = useAccount();

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 h-16",
        "bg-black/50 backdrop-blur-2xl",
        "border-b border-white/[0.05]",
        "flex items-center justify-between px-6"
      )}
    >
      {/* Left: Logo */}
      <Link
        to="/"
        className="flex items-center gap-3 focus-visible:outline-none"
      >
        <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.2)]">
          <Lock className="w-4 h-4 text-black" strokeWidth={2.5} />
        </div>
        <span className="text-[15px] font-semibold text-white tracking-tight">
          Blank
        </span>
      </Link>

      {/* Center: Navigation */}
      <nav className="hidden md:flex items-center gap-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;

          return (
            <Link
              key={item.path}
              to={item.path}
              aria-current={isActive ? "page" : undefined}
              className="relative px-4 py-1.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-black hover:bg-apple-gray5/50 transition-colors duration-200"
            >
              {isActive && (
                <motion.span
                  layoutId="desktop-nav-pill"
                  className="absolute inset-0 bg-apple-gray5 rounded-lg"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span
                className={cn(
                  "relative z-10 text-sm font-medium transition-colors",
                  isActive ? "text-white" : "text-apple-secondary hover:text-white"
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* Right: Wallet + CTA */}
      <div className="flex items-center gap-3">
        {!isConnected && location.pathname === "/" && (
          <Link
            to="/send"
            className={cn(
              "group flex items-center gap-1.5",
              "text-sm font-semibold text-black",
              "bg-white hover:bg-white/90",
              "rounded-full px-5 py-2",
              "shadow-[0_0_20px_rgba(255,255,255,0.15)]",
              "transition-all duration-200"
            )}
          >
            Get Started
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        )}
        <ConnectButton />
      </div>
    </header>
  );
}
