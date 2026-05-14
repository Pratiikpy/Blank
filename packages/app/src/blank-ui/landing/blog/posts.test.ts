import { describe, it, expect } from "vitest";
import { POSTS, POSTS_BY_SLUG, type BlogPost } from "./posts";

// §15.x test for the blog post registry. POSTS is the ordered list the
// blog index renders; POSTS_BY_SLUG is the lookup the route handler
// uses. A regression here is silent: a slug typo would 404 the post
// without any compile-time warning, a duplicate slug would shadow a
// real post in the map, a missing required field would render an
// empty card on the blog index.

const VALID_CATEGORIES: BlogPost["category"][] = [
  "writeup",
  "changelog",
  "deep-dive",
  "post-mortem",
];

describe("POSTS registry shape", () => {
  it("contains exactly 4 posts (sentinel for accidental drops)", () => {
    expect(POSTS).toHaveLength(4);
  });

  it("every post has all 7 required BlogPostMeta fields", () => {
    for (const post of POSTS) {
      expect(typeof post.slug).toBe("string");
      expect(post.slug.length).toBeGreaterThan(0);
      expect(typeof post.title).toBe("string");
      expect(post.title.length).toBeGreaterThan(0);
      expect(typeof post.date).toBe("string");
      expect(typeof post.summary).toBe("string");
      expect(typeof post.author).toBe("string");
      expect(VALID_CATEGORIES).toContain(post.category);
      expect(typeof post.readingTimeMin).toBe("number");
      expect(typeof post.content).toBe("function");
    }
  });

  it("slugs are URL-safe (lowercase, dash-separated, no whitespace)", () => {
    for (const post of POSTS) {
      expect(post.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("dates are ISO-parseable YYYY-MM-DD strings", () => {
    for (const post of POSTS) {
      expect(post.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(post.date).getTime())).toBe(false);
    }
  });

  it("readingTimeMin is a positive integer (no zeros, no fractions)", () => {
    for (const post of POSTS) {
      expect(Number.isInteger(post.readingTimeMin)).toBe(true);
      expect(post.readingTimeMin).toBeGreaterThan(0);
    }
  });

  it("summary is non-empty and at least 20 chars (don't ship empty cards)", () => {
    for (const post of POSTS) {
      expect(post.summary.length).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("slug uniqueness + route lookup", () => {
  it("every slug is unique (no shadowing in POSTS_BY_SLUG)", () => {
    const seen = new Set<string>();
    for (const post of POSTS) {
      expect(seen.has(post.slug)).toBe(false);
      seen.add(post.slug);
    }
  });

  it("POSTS_BY_SLUG is keyed by post.slug for every post", () => {
    for (const post of POSTS) {
      expect(POSTS_BY_SLUG[post.slug]).toBe(post);
    }
  });

  it("POSTS_BY_SLUG has exactly as many entries as POSTS", () => {
    expect(Object.keys(POSTS_BY_SLUG)).toHaveLength(POSTS.length);
  });

  it("POSTS_BY_SLUG returns undefined for a non-existent slug", () => {
    expect(POSTS_BY_SLUG["does-not-exist"]).toBeUndefined();
  });
});

describe("editorial ordering", () => {
  it("first slot is 'why-fhenix-cofhe' (partner-facing deep-dive sits on top per source comment)", () => {
    expect(POSTS[0].slug).toBe("why-fhenix-cofhe");
  });

  it("second slot is 'fhe-vs-zk' (shares the 2026-05-01 date with slot 0)", () => {
    expect(POSTS[1].slug).toBe("fhe-vs-zk");
    expect(POSTS[0].date).toBe(POSTS[1].date);
  });

  it("the two deep-dive posts are at the top of the index", () => {
    expect(POSTS[0].category).toBe("deep-dive");
    expect(POSTS[1].category).toBe("deep-dive");
  });
});

describe("content() is a renderable function", () => {
  it("every post's content() returns a non-null value when invoked", () => {
    for (const post of POSTS) {
      // ReactNode is structurally hard to type-check at runtime, but
      // a function that returns null would render an empty card. Pin
      // non-null so we catch the "I forgot to write the body" case.
      const out = post.content();
      expect(out).not.toBeNull();
      expect(out).not.toBeUndefined();
    }
  });
});
