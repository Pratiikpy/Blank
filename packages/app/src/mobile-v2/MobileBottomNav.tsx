import { Link, useLocation } from "react-router-dom";
import { Home, Send, Clock, Grid3X3, User } from "lucide-react";

const navItems = [
  { path: "/m", icon: Home, label: "Home" },
  { path: "/m/send", icon: Send, label: "Pay" },
  { path: "/m/history", icon: Clock, label: "Activity" },
  { path: "/m/explore", icon: Grid3X3, label: "Explore" },
  { path: "/m/profile", icon: User, label: "Profile" },
] as const;

export function MobileBottomNav() {
  const { pathname } = useLocation();

  return (
    <nav className="mobile-nav" aria-label="Main navigation">
      {navItems.map((item) => {
        const isExactHome = item.path === "/m" && pathname === "/m";
        const isSubRoute =
          item.path !== "/m" && pathname.startsWith(item.path);
        const active = isExactHome || isSubRoute;

        return (
          <Link
            key={item.path}
            to={item.path}
            className={`mobile-nav-item ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <item.icon size={22} strokeWidth={active ? 2.5 : 2} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
