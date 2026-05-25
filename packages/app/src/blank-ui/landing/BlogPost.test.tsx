import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import BlogPost from "./BlogPost";
import { POSTS } from "./blog/posts";

// §15.x test for BlogPost. The dual-branch (found / not-found) is
// what keeps deep-link sharing safe: a typo'd slug shows a graceful
// "Post not found" fallback instead of crashing the React tree.
// Pinning both branches catches a future refactor that drops the
// `if (!post) return ...` guard.

function withRoute(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/blog/${slug}`]}>
      <Routes>
        <Route path="/blog/:slug" element={<BlogPost />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BlogPost — page chrome (§15.x)", () => {
  it("renders LandingNav + LandingFooter on the found branch", () => {
    const { container } = withRoute(POSTS[0].slug);
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });

  it("renders LandingNav + LandingFooter on the not-found branch", () => {
    const { container } = withRoute("definitely-not-a-real-slug");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("BlogPost — not-found branch (§15.x)", () => {
  it("renders 'Post not found' heading for unknown slug", () => {
    const { container } = withRoute("does-not-exist");
    expect(container.textContent).toContain("Post not found");
  });

  it("includes a recovery link back to /blog index", () => {
    const { container } = withRoute("does-not-exist");
    const blogLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("blog index"),
    );
    expect(blogLink?.getAttribute("href")).toBe("https://blog.myblank.app");
  });

  it("does NOT render the back-arrow 'All posts' link on the not-found branch (no article)", () => {
    const { container } = withRoute("does-not-exist");
    const allPosts = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("All posts"),
    );
    expect(allPosts).toBeUndefined();
  });
});

describe("BlogPost — found branch (§15.x)", () => {
  it("renders the post title in an h1", () => {
    const post = POSTS[0];
    const { container } = withRoute(post.slug);
    const h1 = container.querySelector("h1");
    expect(h1?.textContent).toBe(post.title);
  });

  it("renders the author + formatted date in 'Author · Long Date' shape", () => {
    const post = POSTS[0];
    const { container } = withRoute(post.slug);
    expect(container.textContent).toContain(post.author);
    // Long-form date format (e.g. "May 1, 2026" — month spelled out).
    expect(container.textContent).toMatch(
      /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/,
    );
  });

  it("renders category + reading time as 'CATEGORY · X min read' eyebrow", () => {
    const post = POSTS[0];
    const { container } = withRoute(post.slug);
    expect(container.textContent).toContain(post.category);
    expect(container.textContent).toContain(`${post.readingTimeMin} min read`);
  });

  it("renders the back-to-index 'All posts' link with arrow-left icon, pointing to /blog", () => {
    const post = POSTS[0];
    const { container } = withRoute(post.slug);
    const back = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("All posts"),
    );
    expect(back?.getAttribute("href")).toBe("https://blog.myblank.app");
  });

  it("renders the post body inside an <article> with .ll-blog-prose container", () => {
    const post = POSTS[0];
    const { container } = withRoute(post.slug);
    expect(container.querySelector("article")).not.toBeNull();
    expect(container.querySelector(".ll-blog-prose")).not.toBeNull();
  });

  it("renders ALL posts in POSTS_BY_SLUG via their slugs (no slug silently 404s)", () => {
    for (const post of POSTS) {
      const { container, unmount } = withRoute(post.slug);
      expect(container.textContent).toContain(post.title);
      expect(container.textContent).not.toContain("Post not found");
      unmount();
    }
  });
});
