import { describe, expect, it } from "vitest";
import { getSubdomainRouteTarget } from "./subdomainRouting";

describe("subdomain routing", () => {
  it("routes app subdomain into the product app", () => {
    expect(getSubdomainRouteTarget("app.myblank.app", "/")).toBe("/app");
    expect(getSubdomainRouteTarget("app.myblank.app", "/send")).toBe("/app/send");
    expect(getSubdomainRouteTarget("app.myblank.app", "/app/send")).toBeNull();
  });

  it("routes public content subdomains to their canonical pages", () => {
    expect(getSubdomainRouteTarget("brand.myblank.app", "/")).toBe("/brand-kit");
    expect(getSubdomainRouteTarget("blog.myblank.app", "/")).toBe("/blog");
    expect(getSubdomainRouteTarget("docs.myblank.app", "/")).toBe("/whitepaper");
  });

  it("routes short blog slug paths to blog posts", () => {
    expect(getSubdomainRouteTarget("blog.myblank.app", "/why-fhenix-cofhe")).toBe(
      "/blog/why-fhenix-cofhe",
    );
    expect(getSubdomainRouteTarget("blog.myblank.app", "/blog/why-fhenix-cofhe")).toBeNull();
  });

  it("does not interfere with the main domain or static assets", () => {
    expect(getSubdomainRouteTarget("www.myblank.app", "/")).toBeNull();
    expect(getSubdomainRouteTarget("app.myblank.app", "/favicon.ico")).toBeNull();
  });
});
