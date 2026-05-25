import { useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { POSTS_BY_SLUG } from "./blog/posts";
import { PUBLIC_LINKS } from "./publicLinks";
import "./landing.css";
import "./blog.css";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? POSTS_BY_SLUG[slug] : undefined;

  if (!post) {
    return (
      <div className="blank-landing">
        <LandingNav />
        <main>
          <section className="ll-hero">
            <h1 className="ll-hero-h1">Post not found</h1>
            <p className="ll-subline">
              We don't have anything at that URL. Try the{" "}
              <a href={PUBLIC_LINKS.blog} style={{ textDecoration: "underline" }}>
                blog index
              </a>
              .
            </p>
          </section>
        </main>
        <LandingFooter />
      </div>
    );
  }

  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <article
          style={{
            maxWidth: "720px",
            margin: "5rem auto 4rem",
            padding: "0 1.5rem",
          }}
        >
          <a
            href={PUBLIC_LINKS.blog}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              color: "var(--ll-ink-2)",
              fontSize: "0.9rem",
              textDecoration: "none",
              marginBottom: "2rem",
            }}
          >
            <ArrowLeft size={14} strokeWidth={2.2} /> All posts
          </a>

          <div
            style={{
              fontSize: "0.8rem",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ll-ink-2)",
              marginBottom: "0.8rem",
              fontWeight: 600,
            }}
          >
            {post.category} · {post.readingTimeMin} min read
          </div>

          <h1
            style={{
              fontSize: "clamp(2rem, 4vw, 3rem)",
              lineHeight: 1.15,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginBottom: "1rem",
              color: "var(--ll-ink-1)",
            }}
          >
            {post.title}
          </h1>

          <div
            style={{
              color: "var(--ll-ink-2)",
              fontSize: "0.95rem",
              marginBottom: "3rem",
            }}
          >
            {post.author} · {formatDate(post.date)}
          </div>

          <div className="ll-blog-prose">{post.content()}</div>
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
