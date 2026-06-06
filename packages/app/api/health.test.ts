import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "./health.js";

// §15.x test for the /api/health endpoint. The status-code logic is
// the load-bearing thing — 503 vs 207 vs 200 drives whether monitoring
// pages oncall, vs flagging a partial-degradation banner. Flipping
// 207 to 200 when optional features are missing would silently
// downgrade the alert path.

const ENV_KEYS = [
  "NVIDIA_API_KEY",
  "ANTHROPIC_API_KEY",
  "AGENT_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "SEPOLIA_RPC_URL",
  "BASE_SEPOLIA_RPC_URL",
  "ARB_SEPOLIA_RPC_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "PINATA_JWT",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "PUSH_NOTIFY_SECRET",
];

function clearAllEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function setAllEnv() {
  for (const k of ENV_KEYS) process.env[k] = "set";
}

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown>; headers: Record<string, string> } = {
    headers: {},
  };
  return {
    captured,
    setHeader(k: string, v: string) {
      captured.headers[k] = v;
      return this;
    },
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

function mockProbeAllOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch,
  );
}

function mockProbeAllFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => { throw new Error("network unreachable"); }) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  clearAllEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAllEnv();
});

describe("/api/health — status code (§15.x)", () => {
  it("allows branded application health probes through the central endpoint", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({ headers: { origin: "https://app.myblank.app" } }, res);
    expect(res.captured.headers["Access-Control-Allow-Origin"]).toBe("https://app.myblank.app");
    expect(res.captured.headers.Vary).toBe("Origin");
  });

  it("returns 503 'degraded' when ZERO env vars are set", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(503);
    expect(res.captured.body?.status).toBe("degraded");
  });

  it("returns 200 'ok' when all optional env vars are set", async () => {
    setAllEnv();
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("ok");
  });

  it("returns 207 'partial' when SOME optional env vars are set", async () => {
    process.env.RELAYER_PRIVATE_KEY = "x";
    process.env.SEPOLIA_RPC_URL = "x";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(207);
    expect(res.captured.body?.status).toBe("partial");
  });
});

describe("/api/health — derived feature flags (§15.x)", () => {
  it("agentsReachable=true when AGENT_PRIVATE_KEY + NVIDIA_API_KEY both set", async () => {
    process.env.AGENT_PRIVATE_KEY = "x";
    process.env.NVIDIA_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentsReachable).toBe(true);
  });

  it("agentsReachable=true when AGENT_PRIVATE_KEY + ANTHROPIC_API_KEY (fallback model) set", async () => {
    process.env.AGENT_PRIVATE_KEY = "x";
    process.env.ANTHROPIC_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentsReachable).toBe(true);
  });

  it("agentsReachable=false when AGENT_PRIVATE_KEY missing", async () => {
    process.env.NVIDIA_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentsReachable).toBe(false);
  });

  it("agentsReachable=false when AGENT_PRIVATE_KEY set but no LLM key", async () => {
    process.env.AGENT_PRIVATE_KEY = "x";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentsReachable).toBe(false);
  });

  it("relayReachable=true only when RELAYER + BOTH RPC URLs set", async () => {
    process.env.RELAYER_PRIVATE_KEY = "x";
    process.env.SEPOLIA_RPC_URL = "https://sep";
    process.env.BASE_SEPOLIA_RPC_URL = "https://base-sep";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.relayReachable).toBe(true);
  });

  it("relayReachable=false when only ONE chain RPC is set", async () => {
    process.env.RELAYER_PRIVATE_KEY = "x";
    process.env.SEPOLIA_RPC_URL = "https://sep";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.relayReachable).toBe(false);
  });
});

describe("/api/health — agent model selection (§15.x)", () => {
  it("agentPrimary=kimi-k2-instruct when NVIDIA_API_KEY set", async () => {
    process.env.NVIDIA_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentPrimary).toBe("kimi-k2-instruct");
  });

  it("agentPrimary=claude-opus-4-6 when NVIDIA missing", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentPrimary).toBe("claude-opus-4-6");
  });

  it("agentFallback=claude-opus-4-6 ONLY when both NVIDIA and ANTHROPIC are set", async () => {
    process.env.NVIDIA_API_KEY = "x";
    process.env.ANTHROPIC_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentFallback).toBe("claude-opus-4-6");
  });

  it("agentFallback='none' when only one of the LLM keys is set", async () => {
    process.env.ANTHROPIC_API_KEY = "y";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.agentFallback).toBe("none");
  });
});

describe("/api/health — fhenix probes (§15.x)", () => {
  it("fhenixReachable=true when all 3 probes resolve", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.fhenixReachable).toBe(true);
  });

  it("fhenixReachable=false when ANY probe fails (AND-gate semantics)", async () => {
    mockProbeAllFail();
    const res = makeRes();
    await handler({}, res);
    const derived = res.captured.body?.derived as Record<string, unknown>;
    expect(derived.fhenixReachable).toBe(false);
  });

  it("response includes fhenix.{cofhe,verifier,thresholdNetwork} liveness fields", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const fhenix = res.captured.body?.fhenix as Record<string, unknown>;
    expect(fhenix).toHaveProperty("cofhe");
    expect(fhenix).toHaveProperty("verifier");
    expect(fhenix).toHaveProperty("thresholdNetwork");
    expect((fhenix.cofhe as { ok: boolean }).ok).toBe(true);
  });

  it("probes the 3 fhenix testnet URLs in parallel via HEAD", async () => {
    const fetchSpy = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const res = makeRes();
    await handler({}, res);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    const urls = calls.map((c) => c[0]);
    expect(urls).toContain("https://testnet-cofhe.fhenix.zone");
    expect(urls).toContain("https://testnet-cofhe-vrf.fhenix.zone");
    expect(urls).toContain("https://testnet-cofhe-tn.fhenix.zone");
    // All probes use HEAD so we don't pull KB of body.
    for (const c of calls) {
      expect(c[1].method).toBe("HEAD");
    }
  });
});

describe("/api/health — response shape (§15.x)", () => {
  it("includes timestamp + missingRequired + missingOptional + features arrays", async () => {
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const body = res.captured.body!;
    expect(typeof body.timestamp).toBe("string");
    expect(Array.isArray(body.missingRequired)).toBe(true);
    expect(Array.isArray(body.missingOptional)).toBe(true);
    expect(Array.isArray(body.features)).toBe(true);
    // missingOptional is non-empty when nothing is configured.
    expect((body.missingOptional as string[]).length).toBeGreaterThan(0);
  });

  it("never leaks env values — only set/missing booleans", async () => {
    process.env.RELAYER_PRIVATE_KEY = "SUPER_SECRET_DO_NOT_LEAK";
    mockProbeAllOk();
    const res = makeRes();
    await handler({}, res);
    const serialized = JSON.stringify(res.captured.body);
    expect(serialized).not.toContain("SUPER_SECRET_DO_NOT_LEAK");
  });
});
