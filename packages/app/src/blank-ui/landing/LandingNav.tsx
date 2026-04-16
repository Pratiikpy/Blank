import { useEffect, useState, useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ArrowRight, Github, ChevronDown } from "lucide-react";
import { BlankLogo } from "./BlankLogo";

// Shared nav used on every landing-level page (/, /features, /live, /manifesto).
// NavLink marks the current route — `end` on root-ish items prevents prefix bleed.
//
// "For" dropdown surfaces the audience pages without bloating the top nav.
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [forOpen, setForOpen] = useState(false);
  const forRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close dropdown on outside click / Escape / route change
  useEffect(() => { setForOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!forOpen) return;
    const onClick = (e: MouseEvent) => {
      if (forRef.current && !forRef.current.contains(e.target as Node)) setForOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setForOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [forOpen]);

  const onForRoute = location.pathname.startsWith("/for/");

  return (
    <nav className={`ll-nav${scrolled ? " scrolled" : ""}`} aria-label="Primary">
      <Link to="/" className="ll-logo" aria-label="Blank — home">
        <BlankLogo variant="lockup" size={22} />
      </Link>

      <div className="ll-nav-links">
        <NavLink to="/features" className={({ isActive }) => isActive ? "active" : ""}>
          Features
        </NavLink>
        <NavLink to="/how-it-works" className={({ isActive }) => isActive ? "active" : ""}>
          How it works
        </NavLink>

        <div ref={forRef} className="ll-nav-dropdown">
          <button
            type="button"
            onClick={() => setForOpen((v) => !v)}
            className={`ll-nav-dropdown-trigger${onForRoute ? " active" : ""}`}
            aria-haspopup="true"
            aria-expanded={forOpen}
          >
            For <ChevronDown size={12} strokeWidth={2.4} />
          </button>
          {forOpen && (
            <div role="menu" className="ll-nav-dropdown-menu">
              <NavLink to="/for/individuals" role="menuitem">Individuals</NavLink>
              <NavLink to="/for/creators" role="menuitem">Creators</NavLink>
              <NavLink to="/for/businesses" role="menuitem">Businesses</NavLink>
              <NavLink to="/for/daos" role="menuitem">DAOs</NavLink>
            </div>
          )}
        </div>

        <NavLink to="/live" className={({ isActive }) => isActive ? "active" : ""}>
          Live
        </NavLink>
        <NavLink to="/manifesto" className={({ isActive }) => isActive ? "active" : ""}>
          Manifesto
        </NavLink>
        <a href="https://github.com/Pratiikpy/Blank" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </div>

      <div className="ll-nav-right">
        <div className="ll-nav-social">
          <a
            href="https://github.com/Pratiikpy/Blank"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <Github size={18} strokeWidth={2} />
          </a>
        </div>
        <Link to="/app" className="ll-btn ll-btn--ink">
          Launch app <ArrowRight size={15} strokeWidth={2.3} />
        </Link>
      </div>
    </nav>
  );
}
