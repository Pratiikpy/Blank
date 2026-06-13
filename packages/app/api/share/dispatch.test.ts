import { describe, it, expect, beforeEach, afterEach } from "vitest";

// §15.x test for the api/share/proof dispatcher — one static function
// that fans out to the per-kind OG handlers in _lib (one function, two
// surfaces, to stay under the 12-function deploy cap; see #380). The
// handlers themselves are covered by the share-proof/share-link suites;
// this pins the dispatch: ?kind=link -> link card, default -> proof card.

import handler from "./proof.js";

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

describe("share dispatch", () => {
  it("?kind=link via the query string routes to the link handler", async () => {
    const res = makeRes();
    await handler(
      { url: "/api/share/proof?kind=link&type=conditional-invoice&chainId=421614&id=2", headers: {} },
      res,
    );
    expect(res.body).toContain("Conditional invoice on Blank");
  });

  it("?kind=link via req.query (Vercel-injected) routes to the link handler", async () => {
    const res = makeRes();
    await handler(
      { url: "/api/share/proof?type=pay&id=alice", query: { kind: "link", type: "pay", id: "alice" }, headers: {} },
      res,
    );
    expect(res.body).toContain("Get paid privately on Blank");
  });

  it("no kind -> proof handler (the /v/:proofId default)", async () => {
    const res = makeRes();
    // No proof id -> generic proof copy, no chain read needed.
    await handler({ url: "/api/share/proof", headers: {} }, res);
    expect(res.body).toContain("Encrypted proof on Blank");
  });
});
