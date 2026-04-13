import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { ArrowRight, Github } from "lucide-react";
import { BlankLogo } from "./BlankLogo";

// Shared nav used on every landing-level page (/, /features, /live, /manifesto).
// NavLink marks the current route — `end` on root-ish items prevents prefix bleed.
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
