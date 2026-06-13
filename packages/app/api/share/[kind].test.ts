import { describe, it, expect, beforeEach, afterEach } from "vitest";

// §15.x test for /api/share/[kind] — the single function that fans out
// to the per-kind OG handlers in _lib (one function, two surfaces, to
// stay under the 12-function deploy cap; see #380). The handlers
// themselves are covered by share-proof/share-link suites; this pins the
// dispatch: kind=link -> link card, default -> proof card, resolved from
// either req.query.kind (Vercel) or the request path (fallback).

import handler from "./[kind].js";

interface MockRes {
  headers: Record<string, string>;
  body: string | null;
  setHeader(k: string, v: string): void;
  status(s: number): MockRes;
  end(b: string): void;
}

function makeRes(): MockRes {
  const headers: Record<string, string> = {};
  let body: string | null = null;
  return {
    headers,
    get body() { return body; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status() { return this; },
    end(b) { body = b; },
  } as MockRes;
}

beforeEach(() => {
  process.env.VERCEL_URL = "blank.test";
});
afterEach(() => {
  delete process.env.VERCEL_URL;
});

describe("share kind dispatch", () => {
  it("kind=link via req.query routes to the link handler", async () => {
    const res = makeRes();
    await handler(
      { url: "/api/share/link?type=conditional-invoice&chainId=421614&id=2", query: { kind: "link" }, headers: {} },
      res,
    );
    expect(res.body).toContain("Conditional invoice on Blank");
  });

  it("kind=link inferred from the path when query.kind is absent", async () => {
    const res = makeRes();
    await handler(
      { url: "/api/share/link?type=pay&id=alice", headers: {} },
      res,
    );
    expect(res.body).toContain("Get paid privately on Blank");
  });

  it("default (proof) handler when kind is not link", async () => {
    const res = makeRes();
    // No proof id -> generic proof copy, no chain read needed.
    await handler({ url: "/api/share/proof", query: { kind: "proof" }, headers: {} }, res);
    expect(res.body).toContain("Encrypted proof on Blank");
  });
});
