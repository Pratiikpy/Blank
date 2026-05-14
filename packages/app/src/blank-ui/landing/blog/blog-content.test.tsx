import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { POSTS } from "./posts";

// §15.x test for the four blog post bodies. Each post's content() is a
// React fragment that the blog router mounts at /blog/:slug. The
// bodies are static prose (no wagmi, no Router, no FHE), so the test
// surface is render correctness, not behavior:
//
//   - content() returns a valid ReactElement that mounts cleanly
//   - rendered text body is non-trivial in length (catches the
//     "I forgot to write the body" regression where someone leaves
//     content as `() => null` or `() => <></>`)
//   - structural elements are present: at least one paragraph + at
//     least one heading per post (catches markup loss after refactor)
//
// We parameterize across all 4 posts so a fifth post added later
// picks up the same invariants automatically (no per-post test file
// drift).

describe("blog post content() renders", () => {
  for (const post of POSTS) {
    describe(`${post.slug} (${post.title.slice(0, 40)}…)`, () => {
      it("content() returns a valid React element that mounts without throwing", () => {
        // content() is `() => <>...</>`, so the returned value is a
        // fragment node that render() can mount inside a container.
        const node = post.content() as ReactElement;
        expect(() => render(node)).not.toThrow();
      });

      it("rendered text body is at least 500 chars (non-empty body sanity)", () => {
        const { container } = render(post.content() as ReactElement);
        const text = container.textContent ?? "";
        expect(text.length).toBeGreaterThanOrEqual(500);
      });

      it("contains at least one paragraph element", () => {
        const { container } = render(post.content() as ReactElement);
        expect(container.querySelectorAll("p").length).toBeGreaterThan(0);
      });

      it("contains at least one section heading (h2 or h3)", () => {
        const { container } = render(post.content() as ReactElement);
        const headings = container.querySelectorAll("h2, h3");
        expect(headings.length).toBeGreaterThan(0);
      });

      it("does NOT contain stray template placeholders ({TODO}, [PLACEHOLDER], TKTK)", () => {
        const { container } = render(post.content() as ReactElement);
        const text = container.textContent ?? "";
        expect(text).not.toMatch(/\bTODO\b/i);
        expect(text).not.toMatch(/\bTKTK\b/i);
        expect(text).not.toMatch(/\[PLACEHOLDER\]/i);
        expect(text).not.toMatch(/\bLorem ipsum\b/i);
      });
    });
  }
});

describe("blog content cross-post invariants", () => {
  it("rendering all 4 posts in sequence does not throw or leak state", () => {
    for (const post of POSTS) {
      const { unmount } = render(post.content() as ReactElement);
      unmount();
    }
  });

  it("each post mentions its core subject (rough relevance smoke check)", () => {
    // The slug-to-keyword map below pins that each post's body actually
    // talks about its title topic. A regression where someone swapped
    // post bodies (slug stays correct but content drifts to a different
    // topic) would fail loud here.
    const keywordsBySlug: Record<string, string[]> = {
      "why-no-token-ever": ["token"],
      "wave-3-shipped": ["Wave 3"],
      "fhe-vs-zk": ["FHE", "zero-knowledge"],
      "why-fhenix-cofhe": ["Fhenix", "CoFHE"],
    };
    for (const post of POSTS) {
      const { container } = render(post.content() as ReactElement);
      const text = container.textContent ?? "";
      const keywords = keywordsBySlug[post.slug];
      expect(keywords).toBeDefined();
      for (const kw of keywords) {
        expect(text.toLowerCase()).toContain(kw.toLowerCase());
      }
    }
  });
});
