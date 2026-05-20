import { Link } from "react-router-dom";

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
        <Link to="/whitepaper">Whitepaper</Link>
        <Link to="/brand-kit">Brand Kit</Link>
        <Link to="/blog">Blog</Link>
        <Link to="/manifesto">Manifesto</Link>
        <Link to="/app">Launch app</Link>
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
