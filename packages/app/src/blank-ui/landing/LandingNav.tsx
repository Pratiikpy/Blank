import { useEffect, useState, useRef } from "react";
import { useLocation } from "react-router-dom";
import { ArrowRight, Github, ChevronDown, Menu, X } from "lucide-react";
import { BlankLogo } from "./BlankLogo";
import { canonicalPublicHref, PUBLIC_LINKS } from "./publicLinks";

// Shared nav used on every landing-level page (/, /features, /live, /manifesto).
//
// "For" dropdown surfaces the audience pages without bloating the top nav.
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [forOpen, setForOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const forRef = useRef<HTMLDivElement>(null);
  const mobileRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close dropdown on outside click / Escape / route change
  useEffect(() => {
    setForOpen(false);
    setMobileOpen(false);
  }, [location.pathname]);
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
  useEffect(() => {
    if (!mobileOpen) return;
    const onClick = (e: MouseEvent) => {
      if (mobileRef.current && !mobileRef.current.contains(e.target as Node)) setMobileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  const onForRoute = location.pathname.startsWith("/for/");

  return (
    <nav className={`ll-nav${scrolled ? " scrolled" : ""}`} aria-label="Primary">
      <a href={PUBLIC_LINKS.site} className="ll-logo" aria-label="Blank home">
        <BlankLogo variant="lockup" size={22} />
      </a>

      <div className="ll-nav-links">
        <a href={canonicalPublicHref("/features")} className={location.pathname === "/features" ? "active" : ""}>
          Features
        </a>
        <a href={canonicalPublicHref("/how-it-works")} className={location.pathname === "/how-it-works" ? "active" : ""}>
          How it works
        </a>

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
              <a href={canonicalPublicHref("/for/individuals")} role="menuitem">Individuals</a>
              <a href={canonicalPublicHref("/for/creators")} role="menuitem">Creators</a>
              <a href={canonicalPublicHref("/for/businesses")} role="menuitem">Businesses</a>
              <a href={canonicalPublicHref("/for/daos")} role="menuitem">DAOs</a>
            </div>
          )}
        </div>

        <a href={canonicalPublicHref("/pricing")} className={location.pathname === "/pricing" ? "active" : ""}>
          Pricing
        </a>
        <a href={canonicalPublicHref("/roadmap")} className={location.pathname === "/roadmap" ? "active" : ""}>
          Roadmap
        </a>
        <a
          href={PUBLIC_LINKS.blog}
          className={location.pathname === "/blog" || location.pathname.startsWith("/blog/") ? "active" : ""}
        >
          Blog
        </a>
        <a href={canonicalPublicHref("/live")} className={location.pathname === "/live" ? "active" : ""}>
          Live
        </a>
        <a href={canonicalPublicHref("/manifesto")} className={location.pathname === "/manifesto" ? "active" : ""}>
          Manifesto
        </a>
        <a href="https://github.com/Pratiikpy/Blank" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </div>

      <div className="ll-nav-right">
        <div className="ll-mobile-nav" ref={mobileRef}>
          <button
            type="button"
            className="ll-nav-menu-toggle"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          {mobileOpen && (
            <div className="ll-mobile-menu" aria-label="Site navigation">
              <a href={canonicalPublicHref("/features")}>Features</a>
              <a href={canonicalPublicHref("/how-it-works")}>How it works</a>
              <a href={canonicalPublicHref("/pricing")}>Pricing</a>
              <a href={canonicalPublicHref("/roadmap")}>Roadmap</a>
              <a href={PUBLIC_LINKS.blog}>Blog</a>
              <a href={canonicalPublicHref("/live")}>Live</a>
              <a href={canonicalPublicHref("/manifesto")}>Manifesto</a>
              <a href={canonicalPublicHref("/for/individuals")}>For individuals</a>
              <a href={canonicalPublicHref("/for/creators")}>For creators</a>
              <a href={canonicalPublicHref("/for/businesses")}>For businesses</a>
              <a href={canonicalPublicHref("/for/daos")}>For DAOs</a>
            </div>
          )}
        </div>
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
        <a href={PUBLIC_LINKS.app} className="ll-btn ll-btn--ink">
          Launch app <ArrowRight size={15} strokeWidth={2.3} />
        </a>
      </div>
    </nav>
  );
}
