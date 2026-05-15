import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for /api/share/proof — crawler-friendly HTML wrapper
// that injects per-proof og:/twitter: meta tags for Twitter / Slack /
// Discord unfurls. The SPA route /verify/:proofId is JS-rendered so
// crawlers see an empty shell; this endpoint pre-renders the meta
// tags + a redirect for real browsers. Pin the meta-tag contents,
// the og:image origin, the redirect target, the cache header, and
// the HTML escaping so a regression doesn't silently break previews
// on every shared link.

// Reuse the same ethers + addresses mocks as the og endpoint test.
const getProofMock = vi.hoisted(() => vi.fn());

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: vi.fn(),
      Contract: vi.fn(function () {
        return { getProof: getProofMock };
      }),
    },
  };
});

vi.mock("../_lib/addresses.js", () => ({
  CONTRACTS_BY_CHAIN: {},
  RPC_URLS: { 11155111: "https://sepolia", 84532: "https://base-sepolia" },
}));

import handler from "./proof.js";

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
  return { url: `/api/share/proof${query}`, headers: headers ?? {} };
}

const VERIFIED_TUPLE = [
  "0xprover0000000000000000000000000000000000",
  50_000_000_000n, // $50k in 6-decimal USDC units
  100n, 1700000000n, "income", true, true,
] as const;

beforeEach(() => {
  getProofMock.mockReset();
});

afterEach(() => {
  delete process.env.VERCEL_URL;
  delete process.env.PUBLIC_APP_URL;
});

// ─── HTTP response shape ──────────────────────────────────────────

describe("HTTP response shape", () => {
  it("sets Content-Type: text/html; charset=utf-8", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("sets Cache-Control to 5min public + 24h SWR (same shape as og endpoint)", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
  });

  it("returns status 200 (always — link previewers should always get something)", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 even when the proof id is missing (no 4xx on bad input)", async () => {
    const res = makeRes();
    await handler(makeReq(""), res);
    expect(res.statusCode).toBe(200);
  });

  it("writes a complete HTML document via res.end", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(typeof res.body).toBe("string");
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("</html>");
  });
});

// ─── Meta-tag shape (the actual artifact) ─────────────────────────

describe("meta tags", () => {
  it("emits og:image absolute URL pointing at /api/og/proof with same id/chain", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain(
      'property="og:image" content="https://blank.example.dev/api/og/proof?id=42&amp;chain=11155111"',
    );
  });

  it("emits twitter:image alongside og:image (Twitter Cards parses twitter:* first)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain(
      'name="twitter:image" content="https://blank.example.dev/api/og/proof?id=42&amp;chain=11155111"',
    );
  });

  it("emits twitter:card=summary_large_image (1200x630 layout)", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("emits og:image:width=1200 + og:image:height=630 (Twitter Card sizing hints)", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain('property="og:image:width" content="1200"');
    expect(res.body).toContain('property="og:image:height" content="630"');
  });

  it("emits og:url + canonical pointing at the SPA route, not the share endpoint", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain(
      'property="og:url" content="https://blank.example.dev/verify/42?chain=11155111"',
    );
    expect(res.body).toContain(
      'rel="canonical" href="https://blank.example.dev/verify/42?chain=11155111"',
    );
  });

  it("emits og:site_name=Blank for brand context in unfurls", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain('property="og:site_name" content="Blank"');
  });
});

// ─── Title + description per variant ──────────────────────────────

describe("variant copy", () => {
  it("VERIFIED + income → 'Verified: income ≥ $50,000' title", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain("Verified: income ≥ $50,000");
    expect(res.body).toContain("Confirmed by Fhenix Threshold Network");
  });

  it("VERIFIED + balance → 'Verified: balance ≥ $50,000' title", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "balance", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain("Verified: balance ≥ $50,000");
  });

  it("NOT-VERIFIED (false) → 'Income &lt; $50,000' title (disproven copy)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", false, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    // "<" is escaped → "&lt;" in the HTML.
    expect(res.body).toContain("Income &lt; $50,000");
    expect(res.body).toContain("Disproven by Fhenix Threshold Network");
  });

  it("PENDING (!isReady) → 'Pending verification' suffix in title", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", false, false,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain("Pending verification");
    expect(res.body).toContain("Anyone can verify the verdict on-chain");
  });

  it("MISSING (contract reverts) → generic 'Encrypted proof — Blank' title", async () => {
    getProofMock.mockRejectedValue(new Error("PaymentReceipts: proof not found"));
    const res = makeRes();
    await handler(makeReq("?id=999999&chain=11155111"), res);
    expect(res.body).toContain("Encrypted proof");
    expect(res.body).toContain("Blank");
  });

  it("MISSING (id absent) → falls back to generic copy without calling getProof", async () => {
    const res = makeRes();
    await handler(makeReq(""), res);
    expect(res.body).toContain("Encrypted proof");
    expect(getProofMock).not.toHaveBeenCalled();
  });
});

// ─── Redirect path (real browsers bounce to the SPA) ──────────────

describe("browser redirect to SPA", () => {
  it("emits <meta http-equiv=\"refresh\" content=\"0; url=...\"> to /verify/:id", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain(
      'http-equiv="refresh" content="0; url=https://blank.example.dev/verify/42?chain=11155111"',
    );
  });

  it("emits an inline window.location.replace JS redirect (faster than meta-refresh)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toContain(
      'window.location.replace("https://blank.example.dev/verify/42?chain=11155111")',
    );
  });

  it("forwards the chain query param into the redirect (Base Sepolia preserved)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=84532"), res);
    expect(res.body).toContain("/verify/42?chain=84532");
  });

  it("redirects to '/' when id is missing (graceful no-op for bare /v/ hits)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    const res = makeRes();
    await handler(makeReq(""), res);
    expect(res.body).toContain("https://blank.example.dev/");
    expect(res.body).not.toContain("/verify/");
  });
});

// ─── siteOrigin priority order ────────────────────────────────────

describe("site origin resolution", () => {
  it("uses VERCEL_URL when set (https-prefixed)", async () => {
    process.env.VERCEL_URL = "blank-preview.vercel.app";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.body).toContain("https://blank-preview.vercel.app/api/og/proof");
  });

  it("falls back to PUBLIC_APP_URL when VERCEL_URL is unset", async () => {
    delete process.env.VERCEL_URL;
    process.env.PUBLIC_APP_URL = "https://blank.app";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.body).toContain("https://blank.app/api/og/proof");
  });

  it("falls back to x-forwarded-host header when no env URL is set", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.PUBLIC_APP_URL;
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(
      makeReq("?id=1&chain=11155111", {
        "x-forwarded-host": "blank.from-header",
        "x-forwarded-proto": "https",
      }),
      res,
    );
    expect(res.body).toContain("https://blank.from-header/api/og/proof");
  });

  it("respects http scheme when x-forwarded-proto=http (local dev)", async () => {
    delete process.env.VERCEL_URL;
    delete process.env.PUBLIC_APP_URL;
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(
      makeReq("?id=1&chain=11155111", {
        host: "localhost:3000",
        "x-forwarded-proto": "http",
      }),
      res,
    );
    expect(res.body).toContain("http://localhost:3000/api/og/proof");
  });
});

// ─── HTML escaping (defensive — kind / threshold come from chain) ──

describe("HTML escaping", () => {
  it("a malicious 'kind' string from chain can't inject HTML (defense-in-depth)", async () => {
    // Kind is a chain-controlled string field on PaymentReceipts.
    // Today buildCopy only consults `kind === "balance"` for the
    // label, so arbitrary strings never reach the rendered HTML —
    // an extra layer of safety on top of the escape helper. Lock
    // that invariant so a regression that flows kind through {} into
    // the title can't open an HTML-injection surface.
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n,
      "</title><script>alert(1)</script>", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).not.toContain("alert(1)");
    // Title falls back to "Income" because kind !== "balance".
    expect(res.body).toContain("Verified: income ≥ $50,000");
  });

  it("escapeHtml encodes <, >, &, \" via the og:image attribute round-trip", async () => {
    // The og:image attribute always contains "&" between the two
    // query params — proves the escape helper actually runs.
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    expect(res.body).toMatch(/og:image" content="[^"]*&amp;chain=/);
  });

  it("escapes ampersands in the og:image query string (HTML attribute correctness)", async () => {
    process.env.VERCEL_URL = "blank.example.dev";
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42&chain=11155111"), res);
    // Raw "?id=42&chain=..." in an HTML attribute is invalid; must be
    // "?id=42&amp;chain=..." to round-trip through a parser.
    expect(res.body).toContain("?id=42&amp;chain=11155111");
    expect(res.body).not.toMatch(/og:image" content="[^"]*?\?id=42&chain=/);
  });
});

// ─── Defensive defaults ────────────────────────────────────────────

describe("input validation", () => {
  it("treats non-numeric id as missing (no getProof call, generic copy)", async () => {
    const res = makeRes();
    await handler(makeReq("?id=abc&chain=11155111"), res);
    expect(getProofMock).not.toHaveBeenCalled();
    expect(res.body).toContain("Encrypted proof");
  });

  it("defaults to Eth Sepolia (11155111) when chain param is missing", async () => {
    getProofMock.mockResolvedValue(VERIFIED_TUPLE);
    const res = makeRes();
    await handler(makeReq("?id=42"), res);
    // The verify URL preserves the resolved chain id.
    expect(res.body).toContain("/verify/42?chain=11155111");
  });

  it("treats unsupported chain as missing proof (no crash, generic copy)", async () => {
    const res = makeRes();
    await handler(makeReq("?id=42&chain=999999"), res);
    expect(getProofMock).not.toHaveBeenCalled();
    expect(res.body).toContain("Encrypted proof");
  });
});
