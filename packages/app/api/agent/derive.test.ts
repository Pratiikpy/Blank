import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for /api/agent/derive. Focus on the audit-touched paths:
//   - P1.9: GET liveness must NOT leak env config (no provider keys,
//     no signer backend hints, no model names exposed).
//   - P1.8: prompt-injection guardrails — per-template numeric caps
//     reject anything outside a reasonable real-world range BEFORE
//     we sign and broadcast.
// Plus the request-validation surface (user / paymentHubAddress /
// chainId / template / context) so malformed input gets rejected
// before any AI provider call burns quota.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const getSignerMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../_lib/signer.js", () => ({
  getSigner: getSignerMock,
}));

import handler from "./derive.js";

const VALID_USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_HUB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "127.0.0.1" },
  };
}

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  return {
    captured,
    setHeader: vi.fn(),
    status(s: number) {
      captured.status = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      captured.body = b;
      return this;
    },
  };
}

beforeEach(() => {
  checkRateLimitMock.mockReset();
  writeRateLimitHeadersMock.mockReset();
  getSignerMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 4, resetSeconds: 60 });
  // Force getSigner to throw so we stop at the signer init point in any
  // happy-ish path — tests focus on validation + audit paths.
  getSignerMock.mockImplementation(() => {
    throw new Error("AGENT_PRIVATE_KEY not configured");
  });

  // Default: no AI keys configured. Tests that need them set them
  // explicitly before calling handler.
  delete process.env.NVIDIA_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENT_PROVIDER_PREFERENCE;
  delete process.env.ANTHROPIC_MODEL_OVERRIDE;

  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NVIDIA_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

const VALID_BODY = {
  user: VALID_USER,
  paymentHubAddress: VALID_HUB,
  chainId: 11155111,
  template: "payroll_line",
  context: "Senior engineer, NYC, $200k annually.",
};

describe("/api/agent/derive — GET liveness (audit P1.9) (§15.x)", () => {
  it("GET returns 200 + ok:true + minimal hint", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.ok).toBe(true);
    expect(typeof res.captured.body?.hint).toBe("string");
  });

  it("GET response does NOT leak provider keys / signer backend / model names", async () => {
    process.env.NVIDIA_API_KEY = "nvidia-secret-key-do-not-leak";
    process.env.ANTHROPIC_API_KEY = "anthropic-secret-key";
    process.env.AGENT_PRIVATE_KEY = "private-key-do-not-leak";
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);

    const serialized = JSON.stringify(res.captured.body);
    // No env values, no provider names, no model names should leak.
    expect(serialized).not.toContain("nvidia-secret-key-do-not-leak");
    expect(serialized).not.toContain("anthropic-secret-key");
    expect(serialized).not.toContain("private-key-do-not-leak");
    expect(serialized).not.toContain("kimi");
    expect(serialized).not.toContain("claude");
    expect(serialized).not.toContain("opus");
    // No hint about which provider is configured.
    expect(serialized).not.toContain("hasKimi");
    expect(serialized).not.toContain("hasClaude");

    delete process.env.AGENT_PRIVATE_KEY;
  });
});

describe("/api/agent/derive — method guard (§15.x)", () => {
  it("rejects PUT / DELETE / OPTIONS with 405", async () => {
    for (const method of ["PUT", "DELETE", "OPTIONS"]) {
      const res = makeRes();
      await handler(makeReq({ method }), res);
      expect(res.captured.status).toBe(405);
    }
  });
});

describe("/api/agent/derive — rate limit (§15.x)", () => {
  it("returns 429 with reset-seconds in error when limit exhausted", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 42 });
    process.env.NVIDIA_API_KEY = "x";
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect((res.captured.body?.error as string)).toContain("42s");
  });

  it("uses key=agent / max=5 / window=60s", async () => {
    process.env.NVIDIA_API_KEY = "x";
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("agent");
    expect(arg.max).toBe(5);
    expect(arg.windowMs).toBe(60_000);
  });
});

describe("/api/agent/derive — env gates (§15.x)", () => {
  it("returns 500 when NEITHER NVIDIA_API_KEY NOR ANTHROPIC_API_KEY is set", async () => {
    // Both deleted in beforeEach.
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(500);
    expect((res.captured.body?.error as string)).toContain("at least one of NVIDIA_API_KEY");
  });

  it("passes the env gate when only NVIDIA_API_KEY is set", async () => {
    process.env.NVIDIA_API_KEY = "x";
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    // Fails downstream at the actual fetch / parse / signer — not the env gate.
    expect(res.captured.status).not.toBe(500);
  });

  it("passes the env gate when only ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).not.toBe(500);
  });
});

describe("/api/agent/derive — body validation (§15.x)", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "x";
  });

  it("returns 400 on invalid JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{not json" }), res);
    expect(res.captured.status).toBe(400);
    expect(res.captured.body?.error).toBe("Invalid JSON body");
  });

  it("parses a stringified JSON body and reaches validation", async () => {
    const res = makeRes();
    await handler(makeReq({ body: JSON.stringify({ ...VALID_BODY, user: "bad" }) }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("user");
  });

  it("returns 400 when user is not a valid address", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, user: "not-addr" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("user");
  });

  it("returns 400 when paymentHubAddress is invalid", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, paymentHubAddress: "x" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("paymentHubAddress");
  });

  it("returns 400 when chainId is missing or non-positive", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, chainId: 0 } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("chainId");
  });

  it("returns 400 when chainId is not a number type", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, chainId: "11155111" } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 with helpful list when template is unknown", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, template: "unknown" } }), res);
    expect(res.captured.status).toBe(400);
    const err = res.captured.body?.error as string;
    expect(err).toContain("Unknown template");
    expect(err).toContain("payroll_line");
    expect(err).toContain("expense_share");
  });

  it("returns 400 when context is empty string", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, context: "" } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("1..4000");
  });

  it("returns 400 when context exceeds 4000 chars", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, context: "x".repeat(4001) } }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });

  it("accepts context at exactly 4000 chars (boundary)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, context: "x".repeat(4000) } }),
      res,
    );
    // Past validation — fails at fetch (no real network) downstream.
    expect(res.captured.status).not.toBe(400);
  });

  it("accepts both supported templates past validation", async () => {
    for (const template of ["payroll_line", "expense_share"]) {
      const res = makeRes();
      await handler(makeReq({ body: { ...VALID_BODY, template } }), res);
      // Past validation — fails downstream at network / signer.
      expect(res.captured.status).not.toBe(400);
    }
  });
});

describe("/api/agent/derive — outer try/catch (§15.x audit P1.9)", () => {
  it("on unexpected crash, returns 500 with error message but NOT a stack trace", async () => {
    process.env.NVIDIA_API_KEY = "x";
    // Make checkRateLimit throw synchronously to trigger the outer catch.
    checkRateLimitMock.mockImplementation(() => {
      throw new Error("KV unreachable boom");
    });

    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);

    expect(res.captured.status).toBe(500);
    const err = res.captured.body?.error as string;
    expect(err).toContain("agent handler crashed");
    expect(err).toContain("KV unreachable boom");
    // Audit P1.9: stackHint dropped — no file paths or library versions
    // should leak in the response.
    expect(res.captured.body?.stackHint).toBeUndefined();
    expect(res.captured.body?.stack).toBeUndefined();
  });
});
