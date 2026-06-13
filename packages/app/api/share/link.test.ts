import { describe, it, expect, beforeEach, afterEach } from "vitest";

// §15.x test for /api/share/link — crawler-friendly HTML wrapper that
// injects per-resource-type og:/twitter: meta tags for the shareable
// resource links (conditional invoice, pay, claim, shop, fund). The SPA
// routes are JS-rendered so crawlers see an empty shell; this endpoint
// pre-renders meta tags + a bounce to the same route with ?app=1 (which
// skips the rewrite and falls through to the SPA). Pin the copy per type,
// the og:image origin, the canonical/redirect targets, the cache header
// and the HTML escaping so a regression can't silently break unfurls.

import handler from "./link.js";

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body: string | null;
  setHeader(k: string, v: string): void;
  status(s: number): MockRes;
  end(b: string): void;
}

function makeRes(): MockRes {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: string | null = null;
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(s) { statusCode = s; return this; },
    end(b) { body = b; },
  } as MockRes;
}

function makeReq(query: string, headers?: Record<string, string>) {
  return { url: `/api/share/link${query}`, headers: headers ?? {} };
}

beforeEach(() => {
  process.env.VERCEL_URL = "blank.test";
});

afterEach(() => {
  delete process.env.VERCEL_URL;
  delete process.env.PUBLIC_APP_URL;
});

// ─── HTTP response shape ──────────────────────────────────────────

describe("HTTP response shape", () => {
  it("sets Content-Type: text/html; charset=utf-8", async () => {
    const res = makeRes();
    await handler(makeReq("?type=conditional-invoice&chainId=421614&id=2"), res);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("sets Cache-Control to 5min public + 24h SWR (same as proof share)", async () => {
    const res = makeRes();
    await handler(makeReq("?type=pay&id=alice"), res);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
  });

  it("always returns 200 (link previewers should always get a card)", async () => {
    const res = makeRes();
    await handler(makeReq("?type=garbage"), res);
    expect(res.statusCode).toBe(200);
  });

  it("writes a complete HTML document", async () => {
    const res = makeRes();
    await handler(makeReq("?type=shop&chainId=84532&id=5"), res);
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("</html>");
  });
});

// ─── Per-type copy ────────────────────────────────────────────────

describe("per-resource-type copy", () => {
  it("conditional-invoice → escrow/approve/deadline card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=conditional-invoice&chainId=421614&id=2"), res);
    expect(res.body).toContain("Conditional invoice on Blank");
    expect(res.body).toContain("releases on payer approval or after a deadline");
  });

  it("pay → 'Get paid privately' card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=pay&id=0xAbc123"), res);
    expect(res.body).toContain("Get paid privately on Blank");
  });

  it("claim → 'encrypted payment to claim' card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=claim&chainId=11155111&id=7"), res);
    expect(res.body).toContain("encrypted payment to claim");
  });

  it("shop → 'private storefront' card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=shop&chainId=84532&id=3"), res);
    expect(res.body).toContain("A private storefront on Blank");
  });

  it("fund → 'encrypted crowdfund' card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=fund&chainId=421614&id=9"), res);
    expect(res.body).toContain("Back an encrypted crowdfund on Blank");
  });

  it("unknown type → generic Blank card", async () => {
    const res = makeRes();
    await handler(makeReq("?type=unknown&chainId=1&id=1"), res);
    expect(res.body).toContain("Blank | Private Amount Payments");
  });
});

// ─── Meta tags + image ────────────────────────────────────────────

describe("meta tags", () => {
  it("emits og:image absolute URL pointing at the static social card", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    const res = makeRes();
    await handler(makeReq("?type=conditional-invoice&chainId=421614&id=2"), res);
    expect(res.body).toContain(
      'property="og:image" content="https://blank.example.dev/og/blank-og.png"',
    );
    expect(res.body).toContain(
      'name="twitter:image" content="https://blank.example.dev/og/blank-og.png"',
    );
  });

  it("emits twitter:card=summary_large_image + 1200x630 sizing", async () => {
    const res = makeRes();
    await handler(makeReq("?type=shop&chainId=84532&id=5"), res);
    expect(res.body).toContain('name="twitter:card" content="summary_large_image"');
    expect(res.body).toContain('property="og:image:width" content="1200"');
    expect(res.body).toContain('property="og:image:height" content="630"');
  });

  it("og:url + canonical point at the clean resource route (no ?app)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    const res = makeRes();
    await handler(makeReq("?type=conditional-invoice&chainId=421614&id=2"), res);
    expect(res.body).toContain(
      'property="og:url" content="https://blank.example.dev/conditional-invoice/421614/2"',
    );
    expect(res.body).toContain(
      'rel="canonical" href="https://blank.example.dev/conditional-invoice/421614/2"',
    );
    // og:url/canonical end in `">` immediately after the clean path, which
    // proves no ?app leaks into them (the redirect line uses ?app=1).
  });

  it("emits og:site_name=Blank", async () => {
    const res = makeRes();
    await handler(makeReq("?type=pay&id=alice"), res);
    expect(res.body).toContain('property="og:site_name" content="Blank"');
  });
});

// ─── Browser bounce to the SPA (no redirect loop) ─────────────────

describe("browser bounce to SPA", () => {
  it("meta-refreshes to the same route with ?app=1 (skips the rewrite)", async () => {
    const res = makeRes();
    await handler(makeReq("?type=conditional-invoice&chainId=421614&id=2"), res);
    expect(res.body).toContain(
      'http-equiv="refresh" content="0; url=/conditional-invoice/421614/2?app=1"',
    );
  });

  it("emits an inline window.location.replace to ?app=1", async () => {
    const res = makeRes();
    await handler(makeReq("?type=fund&chainId=421614&id=9"), res);
    expect(res.body).toContain('window.location.replace("/fund/421614/9?app=1")');
  });

  it("pay route preserves the single-segment identifier path", async () => {
    const res = makeRes();
    await handler(makeReq("?type=pay&id=vendor.eth"), res);
    expect(res.body).toContain("/pay/vendor.eth?app=1");
  });
});

// ─── Validation + graceful fallback ───────────────────────────────

describe("input validation", () => {
  it("known type with missing id → generic copy, bounce to '/'", async () => {
    const res = makeRes();
    await handler(makeReq("?type=shop&chainId=84532"), res);
    expect(res.body).toContain("Blank | Private Amount Payments");
    expect(res.body).toContain('window.location.replace("/")');
  });

  it("non-numeric chainId → generic copy, bounce to '/'", async () => {
    const res = makeRes();
    await handler(makeReq("?type=claim&chainId=abc&id=7"), res);
    expect(res.body).toContain('window.location.replace("/")');
  });

  it("rejects a path-traversal id (slashes) → bounce to '/'", async () => {
    const res = makeRes();
    await handler(makeReq("?type=shop&chainId=84532&id=" + encodeURIComponent("../../etc")), res);
    expect(res.body).toContain('window.location.replace("/")');
  });
});

// ─── siteOrigin resolution (mirrors proof share) ──────────────────

describe("site origin resolution", () => {
  it("uses VERCEL_URL when set", async () => {
    process.env.VERCEL_URL = "blank-preview.vercel.app";
    const res = makeRes();
    await handler(makeReq("?type=pay&id=alice"), res);
    expect(res.body).toContain("https://blank-preview.vercel.app/og/blank-og.png");
  });

  it("falls back to PUBLIC_APP_URL when VERCEL_URL unset", async () => {
    delete process.env.VERCEL_URL;
    process.env.PUBLIC_APP_URL = "https://www.myblank.app";
    const res = makeRes();
    await handler(makeReq("?type=pay&id=alice"), res);
    expect(res.body).toContain("https://www.myblank.app/og/blank-og.png");
  });

  it("falls back to x-forwarded-host header when no env URL is set", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.PUBLIC_APP_URL;
    const res = makeRes();
    await handler(
      makeReq("?type=pay&id=alice", { "x-forwarded-host": "blank.from-header", "x-forwarded-proto": "https" }),
      res,
    );
    expect(res.body).toContain("https://blank.from-header/og/blank-og.png");
  });

  it("throws when no env URL and no host header (fail loud, no broken og:image)", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.PUBLIC_APP_URL;
    await expect(
      handler(makeReq("?type=pay&id=alice", {}), makeRes()),
    ).rejects.toThrow(/siteOrigin/);
  });
});

// ─── HTML escaping (defensive — type/id come from the URL) ─────────

describe("HTML escaping", () => {
  it("an injection attempt in id can't break out of the attribute", async () => {
    const res = makeRes();
    await handler(makeReq("?type=pay&id=" + encodeURIComponent('"><script>alert(1)</script>')), res);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    // The id fails the SEGMENT check, so it degrades to the generic bounce.
    expect(res.body).toContain('window.location.replace("/")');
  });
});
