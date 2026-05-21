import { Link } from "react-router-dom";
import { PUBLIC_LINKS } from "./publicLinks";

// Shared footer across all landing-level pages.
export function LandingFooter() {
  return (
    <footer className="ll-footer">
      <div>© {new Date().getFullYear()} Blank. Private by design.</div>
      <div className="ll-footer-links">
        <Link to="/features">Features</Link>
        <Link to="/how-it-works">How it works</Link>
        <Link to="/pricing">Pricing</Link>
        <Link to="/roadmap">Roadmap</Link>
        <Link to="/live">Live</Link>
        <a href={PUBLIC_LINKS.docs}>Docs</a>
        <a href={PUBLIC_LINKS.brand}>Brand Kit</a>
        <a href={PUBLIC_LINKS.blog}>Blog</a>
        <Link to="/manifesto">Manifesto</Link>
        <a href={PUBLIC_LINKS.app}>Launch app</a>
        <a
          href="https://github.com/Pratiikpy/Blank"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        <a
          href="https://fhenix.io"
          target="_blank"
          rel="noopener noreferrer"
        >
          Built on Fhenix ↗
        </a>
      </div>
    </footer>
  );
}
