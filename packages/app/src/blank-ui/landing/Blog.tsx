import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { POSTS } from "./blog/posts";
import { PUBLIC_LINKS } from "./publicLinks";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Blog index — the home for technical writeups, changelogs,
//  post-mortems, and "here's what we believe" posts. Every entry
//  is a TSX file under blog/<slug>.tsx exporting a default
//  BlogPost. Adding a post = create a file + import it in posts.ts.
//
//  Why TSX-not-MDX: zero new build deps, full TypeScript, hot
//  reload works, links and components Just Work. Trade-off is
//  authoring is slightly more verbose than markdown — fine for
//  the cadence this blog ships at (~1 post/week).
//  ══════════════════════════════════════════════════════════════════

function categoryLabel(c: string): string {
  switch (c) {
    case "writeup":
      return "Writeup";
    case "changelog":
      return "Changelog";
    case "deep-dive":
      return "Deep dive";
    case "post-mortem":
      return "Post-mortem";
    default:
      return c;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function Blog() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-hero" style={{ paddingBottom: "2rem" }}>
          <p className="ll-eyebrow">Blank Blog</p>
          <h1 className="ll-hero-h1">
            Technical writeups, changelogs,
            <br />
            and what we believe.
          </h1>
          <p className="ll-subline">
            We write about FHE, what we shipped, and the strategic
            calls behind it. No marketing fluff, no token announcements,
            no "we're excited to share" openings.
          </p>
        </section>

        <section className="ll-section">
          <div
            style={{
              maxWidth: "780px",
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: "1.5rem",
            }}
          >
            {POSTS.map((p) => (
              <a
                key={p.slug}
                href={`${PUBLIC_LINKS.blog}/${p.slug}`}
                className="ll-step"
                style={{
                  textDecoration: "none",
                  display: "block",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "0.6rem",
                    alignItems: "center",
                    marginBottom: "0.6rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      background: "var(--ll-surface)",
                      color: "var(--ll-accent-dark)",
                      fontSize: "0.7rem",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      padding: "0.3rem 0.6rem",
                      borderRadius: "5px",
                      fontWeight: 700,
                    }}
                  >
                    {categoryLabel(p.category)}
                  </span>
                  <span
                    style={{
                      color: "var(--ll-ink-2)",
                      fontSize: "0.85rem",
                    }}
                  >
                    {formatDate(p.date)} · {p.readingTimeMin} min read
                  </span>
                </div>
                <div
                  className="ll-step-title"
                  style={{ marginBottom: "0.5rem" }}
                >
                  {p.title}
                </div>
                <div className="ll-step-body">{p.summary}</div>
              </a>
            ))}
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
