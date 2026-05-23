import { describe, it, expect } from "vitest";
import { HELP_ARTICLES, searchHelp } from "./help-articles";

describe("HELP_ARTICLES", () => {
  it("ships exactly the 10 starter articles per Wave 5 §8.1", () => {
    expect(HELP_ARTICLES).toHaveLength(10);
  });

  it("every article has slug + title + category + body + keywords", () => {
    for (const a of HELP_ARTICLES) {
      expect(a.slug).toMatch(/^[a-z0-9-]+$/);
      expect(a.title.length).toBeGreaterThan(3);
      expect(a.category.length).toBeGreaterThan(0);
      expect(a.body.length).toBeGreaterThan(40);
      expect(a.keywords.length).toBeGreaterThan(0);
    }
  });

  it("slugs are unique", () => {
    const slugs = new Set(HELP_ARTICLES.map((a) => a.slug));
    expect(slugs.size).toBe(HELP_ARTICLES.length);
  });

  it("searchHelp empty query returns all articles", () => {
    expect(searchHelp("")).toHaveLength(HELP_ARTICLES.length);
  });

  it("searchHelp matches title", () => {
    const out = searchHelp("offramp");
    expect(out.length).toBeGreaterThan(0);
    // use-offramp is the dedicated article; other articles may also
    // mention offramp in passing.
    expect(out.some((a) => a.slug === "use-offramp")).toBe(true);
  });

  it("searchHelp matches keywords", () => {
    const out = searchHelp("upi");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((a) => a.slug === "use-offramp")).toBe(true);
  });

  it("searchHelp matches category", () => {
    const out = searchHelp("recovery");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((a) => a.category === "Recovery")).toBe(true);
  });

  it("searchHelp returns empty for nonsense", () => {
    expect(searchHelp("zzzzzz-no-match")).toHaveLength(0);
  });
});
