import { canonicalPublicHref, PUBLIC_LINKS } from "./publicLinks";

// Shared footer across all landing-level pages.
export function LandingFooter() {
  return (
    <footer className="ll-footer">
      <div>© {new Date().getFullYear()} Blank. Private by design.</div>
      <div className="ll-footer-links">
        <a href={canonicalPublicHref("/features")}>Features</a>
        <a href={canonicalPublicHref("/how-it-works")}>How it works</a>
        <a href={canonicalPublicHref("/pricing")}>Pricing</a>
        <a href={canonicalPublicHref("/roadmap")}>Roadmap</a>
        <a href={canonicalPublicHref("/live")}>Live</a>
        <a href={PUBLIC_LINKS.docs}>Docs</a>
        <a href={PUBLIC_LINKS.brand}>Brand Kit</a>
        <a href={PUBLIC_LINKS.blog}>Blog</a>
        <a href={canonicalPublicHref("/manifesto")}>Manifesto</a>
        <a href={canonicalPublicHref("/proof-deck")}>Proof deck</a>
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
