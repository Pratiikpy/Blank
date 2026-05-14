import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as React from "react";

// §15.x test for the /api/badge?for=<identifier> "Pay me on Blank" PNG
// renderer. The pure piece worth pinning is sanitize() — it gates what
// user-supplied text gets baked into a PNG that ships in email
// signatures and social bios. A regression that let HTML / quote chars
// through would either crash @vercel/og OR (worse) render attacker
// text inside the badge. The 64-char length cap is the DOS guard so a
// 200KB identifier can't blow up the renderer.
//
// Also pin the ?for/?to query-fallback (we accept either for
// convenience), the Cache-Control headers (1h public, 24h SWR — safe
// because the badge is deterministic for an identifier), and the
// Content-Type=image/png response shape.

const captured = vi.hoisted<{
  element: React.ReactElement | null;
  options: { width?: number; height?: number; headers?: Record<string, string> } | null;
}>(() => ({ element: null, options: null }));

vi.mock("@vercel/og", () => ({
  ImageResponse: vi.fn(function (this: unknown, element: React.ReactElement, options: unknown) {
    captured.element = element;
    captured.options = options as typeof captured.options;
    return {
      arrayBuffer: async () => new ArrayBuffer(42),
    };
  }),
}));

import handler from "./badge.js";

// Walk a React element tree and concatenate all text-node children.
// Lets tests assert on the identifier text without needing react-dom
// or the @vercel/og runtime.
function extractText(el: unknown): string {
  if (el == null) return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  if (Array.isArray(el)) return el.map(extractText).join("|");
  const node = el as { props?: { children?: unknown } };
  if (node.props && "children" in node.props) return extractText(node.props.children);
  return "";
}

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body: Buffer | null;
  setHeader(k: string, v: string): void;
  status(s: number): MockRes;
  end(b: Buffer): void;
}

function makeRes(): MockRes {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: Buffer | null = null;
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    status(s: number) {
      statusCode = s;
      return this;
    },
    end(b: Buffer) {
      body = b;
    },
  } as MockRes;
}

function makeReq(query: string): { url: string } {
  return { url: `/api/badge${query}` };
}

beforeEach(() => {
  captured.element = null;
  captured.options = null;
});

// ─── sanitize() behaviour via the handler ──────────────────────────

describe("sanitize identifier", () => {
  it("preserves alphanumerics, dot, hyphen, underscore (ENS / Basenames chars)", async () => {
    await handler(makeReq("?for=pratik.eth-1_test"), makeRes());
    expect(extractText(captured.element)).toContain("pratik.eth-1_test");
  });

  it("strips HTML special chars (<, >, &, /, ', \") to prevent renderer-side injection", async () => {
    await handler(makeReq("?for=<script>alert(1)</script>"), makeRes());
    const text = extractText(captured.element);
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).not.toContain("/");
    // The remaining safe chars survive.
    expect(text).toContain("scriptalert1script");
  });

  it("strips whitespace (URL-decoded spaces, tabs, newlines)", async () => {
    await handler(makeReq("?for=alice%20bob%09foo"), makeRes());
    expect(extractText(captured.element)).toContain("alicebobfoo");
  });

  it("caps length at 64 chars (DOS guard against 200KB identifiers)", async () => {
    const long = "a".repeat(200);
    await handler(makeReq(`?for=${long}`), makeRes());
    const text = extractText(captured.element);
    // extractText joins array siblings with '|' so the 64-a identifier
    // appears as a discrete run. Pick the longest 'a' run (the 'a' in
    // "Pay", "Blank" are single chars that we want to ignore).
    const runs = text.match(/a+/g) ?? [];
    const longest = Math.max(...runs.map(r => r.length));
    expect(longest).toBe(64);
  });

  it("renders 'Blank' when input is empty", async () => {
    await handler(makeReq("?for="), makeRes());
    expect(extractText(captured.element)).toContain("Blank");
  });

  it("renders 'Blank' when input is missing entirely", async () => {
    await handler(makeReq(""), makeRes());
    expect(extractText(captured.element)).toContain("Blank");
  });

  it("renders 'Blank' when input contains ONLY disallowed chars (cleaned -> empty)", async () => {
    await handler(makeReq("?for=%3C%3E%2F%26"), makeRes());
    expect(extractText(captured.element)).toContain("Blank");
  });

  it("preserves a 0x address in full (42 chars, well under the 64-char cap)", async () => {
    await handler(
      makeReq("?for=0x1234567890abcdef1234567890abcdef12345678"),
      makeRes(),
    );
    expect(extractText(captured.element)).toContain(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
  });
});

// ─── ?for vs ?to query fallback ────────────────────────────────────

describe("?for vs ?to query fallback", () => {
  it("?for is the primary identifier source", async () => {
    await handler(makeReq("?for=alice.eth"), makeRes());
    expect(extractText(captured.element)).toContain("alice.eth");
  });

  it("?to is the fallback when ?for is missing", async () => {
    await handler(makeReq("?to=bob.eth"), makeRes());
    expect(extractText(captured.element)).toContain("bob.eth");
  });

  it("?for wins when both ?for and ?to are present", async () => {
    await handler(makeReq("?for=primary&to=fallback"), makeRes());
    const text = extractText(captured.element);
    expect(text).toContain("primary");
    expect(text).not.toContain("fallback");
  });

  it("neither query param -> renders 'Blank'", async () => {
    await handler(makeReq("?v=cache-buster"), makeRes());
    expect(extractText(captured.element)).toContain("Blank");
  });
});

// ─── Response headers + status ─────────────────────────────────────

describe("HTTP response shape", () => {
  it("sets Content-Type: image/png", async () => {
    const res = makeRes();
    await handler(makeReq("?for=alice.eth"), res);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("sets Cache-Control to 1h public + 24h stale-while-revalidate", async () => {
    const res = makeRes();
    await handler(makeReq("?for=alice.eth"), res);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
  });

  it("returns status 200", async () => {
    const res = makeRes();
    await handler(makeReq("?for=alice.eth"), res);
    expect(res.statusCode).toBe(200);
  });

  it("writes the PNG bytes via res.end (Node-handler shape, not Edge Response)", async () => {
    const res = makeRes();
    await handler(makeReq("?for=alice.eth"), res);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body!.byteLength).toBe(42);
  });
});

// ─── ImageResponse options ──────────────────────────────────────────

describe("@vercel/og ImageResponse options", () => {
  it("renders at 480x120 (the documented badge size)", async () => {
    await handler(makeReq("?for=alice.eth"), makeRes());
    expect(captured.options?.width).toBe(480);
    expect(captured.options?.height).toBe(120);
  });

  it("passes the same Cache-Control to ImageResponse so the framework respects it", async () => {
    await handler(makeReq("?for=alice.eth"), makeRes());
    expect(captured.options?.headers).toMatchObject({
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    });
  });

  it("renders the 'Pay me on Blank' label + the identifier in distinct text nodes", async () => {
    await handler(makeReq("?for=pratik.eth"), makeRes());
    const text = extractText(captured.element);
    expect(text).toContain("Pay me on Blank");
    expect(text).toContain("pratik.eth");
    // The CTA "Pay" pill is the third text node.
    expect(text).toContain("Pay");
  });
});

// ─── URL parsing edge cases ────────────────────────────────────────

describe("URL parsing edge cases", () => {
  it("handles a relative URL with no host (req.url = '/api/badge?for=…')", async () => {
    // The source constructs `new URL(req.url ?? "/", "http://x")` so a
    // relative URL is fine. Pinned by passing an unconfigured req.
    await handler({ url: "/api/badge?for=alice.eth" } as never, makeRes());
    expect(extractText(captured.element)).toContain("alice.eth");
  });

  it("defaults req.url to '/' when undefined (no crash, renders 'Blank')", async () => {
    await handler({} as never, makeRes());
    expect(extractText(captured.element)).toContain("Blank");
  });

  it("URL-encoded reserved chars in the identifier survive the decode but get stripped by sanitize", async () => {
    // %3F = '?', %23 = '#' — both stripped because they're not in the allow-list.
    await handler(makeReq("?for=alice%3F%23bob"), makeRes());
    expect(extractText(captured.element)).toContain("alicebob");
  });
});
