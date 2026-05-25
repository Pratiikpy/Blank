import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Blog from "./Blog";
import { POSTS, POSTS_BY_SLUG } from "./blog/posts";

// §15.x test for the Blog index. Pins the post-card list against
// the static POSTS metadata so a future schema change (renaming
// `slug` or adding a category) catches obvious breakage. Plus the
// "no marketing fluff" promise in the hero copy.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Blog index — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<Blog />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("Blog index — hero (§15.x)", () => {
  it("eyebrow reads 'Blank Blog'", () => {
    const { container } = withRouter(<Blog />);
    expect(container.textContent).toContain("Blank Blog");
  });

  it("headline frames the content categories: technical writeups + changelogs + beliefs", () => {
    const { container } = withRouter(<Blog />);
    expect(container.textContent).toContain("Technical writeups");
    expect(container.textContent).toContain("changelogs");
    expect(container.textContent).toContain("what we believe");
  });

  it("CRITICAL no-marketing-fluff promise is preserved", () => {
    const { container } = withRouter(<Blog />);
    expect(container.textContent).toContain("No marketing fluff");
    expect(container.textContent).toContain("no token announcements");
    expect(container.textContent).toContain("no \"we're excited to share\" openings");
  });
});

describe("Blog index — post list (§15.x)", () => {
  it("renders one card per post in POSTS array", () => {
    const { container } = withRouter(<Blog />);
    const cards = container.querySelectorAll(".ll-step");
    expect(cards.length).toBe(POSTS.length);
  });

  it("each card links to /blog/<slug>", () => {
    const { container } = withRouter(<Blog />);
    const links = Array.from(container.querySelectorAll("a.ll-step")).map((a) =>
      a.getAttribute("href"),
    );
    for (const post of POSTS) {
      expect(links).toContain(`https://blog.myblank.app/${post.slug}`);
    }
  });

  it("each card surfaces title + summary", () => {
    const { container } = withRouter(<Blog />);
    for (const post of POSTS) {
      expect(container.textContent).toContain(post.title);
      expect(container.textContent).toContain(post.summary);
    }
  });

  it("each card surfaces a reading time and a formatted date", () => {
    const { container } = withRouter(<Blog />);
    for (const post of POSTS) {
      // Reading time: "X min read"
      expect(container.textContent).toContain(`${post.readingTimeMin} min read`);
    }
    // Formatted-date pattern: "Mon DD, YYYY"
    expect(container.textContent).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  });

  it("category labels normalize correctly: writeup → 'Writeup', deep-dive → 'Deep dive', etc.", () => {
    const { container } = withRouter(<Blog />);
    const text = container.textContent ?? "";
    // Collect the SET of category labels expected from POSTS.
    const labels = new Set<string>();
    for (const post of POSTS) {
      const map: Record<string, string> = {
        writeup: "Writeup",
        changelog: "Changelog",
        "deep-dive": "Deep dive",
        "post-mortem": "Post-mortem",
      };
      labels.add(map[post.category] ?? post.category);
    }
    for (const label of labels) {
      expect(text).toContain(label);
    }
  });

  it("posts render in newest-first order (POSTS array order preserved)", () => {
    const { container } = withRouter(<Blog />);
    const titles = Array.from(container.querySelectorAll(".ll-step-title")).map(
      (el) => el.textContent?.trim(),
    );
    const expected = POSTS.map((p) => p.title);
    expect(titles).toEqual(expected);
  });
});

describe("Blog metadata invariants (§15.x)", () => {
  it("POSTS array is non-empty (at least one post lives in the blog)", () => {
    expect(POSTS.length).toBeGreaterThan(0);
  });

  it("every post has all required BlogPostMeta fields populated", () => {
    for (const post of POSTS) {
      expect(typeof post.slug).toBe("string");
      expect(post.slug.length).toBeGreaterThan(0);
      expect(typeof post.title).toBe("string");
      expect(post.title.length).toBeGreaterThan(0);
      expect(typeof post.date).toBe("string");
      expect(typeof post.summary).toBe("string");
      expect(typeof post.author).toBe("string");
      expect(typeof post.readingTimeMin).toBe("number");
      expect(post.readingTimeMin).toBeGreaterThan(0);
      expect(typeof post.content).toBe("function");
    }
  });

  it("POSTS_BY_SLUG maps every post back to the same object (slug uniqueness)", () => {
    expect(Object.keys(POSTS_BY_SLUG).length).toBe(POSTS.length);
    for (const post of POSTS) {
      expect(POSTS_BY_SLUG[post.slug]).toBe(post);
    }
  });

  it("post slugs are URL-safe (lowercase letters, digits, hyphens only)", () => {
    for (const post of POSTS) {
      expect(post.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("post dates are valid ISO-ish strings parseable by Date", () => {
    for (const post of POSTS) {
      const d = new Date(post.date);
      expect(Number.isNaN(d.getTime())).toBe(false);
    }
  });

  it("every category is one of the 4 declared union members", () => {
    const allowed = new Set(["writeup", "changelog", "deep-dive", "post-mortem"]);
    for (const post of POSTS) {
      expect(allowed.has(post.category)).toBe(true);
    }
  });
});
