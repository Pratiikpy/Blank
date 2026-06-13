import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for cron-reconcile-tick. Pins the CRON_SECRET fail-
// closed gate (the audit fix that closes the publicly-callable
// hole the earlier `if (expected && ...)` guard left open), the
// 0x0-sender skip (without it every tick wastes RPC on burn/mint
// events), and the MAX_ADDRESSES_PER_TICK cap.

const getSupabaseAdminMock = vi.hoisted(() => vi.fn());

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

import handler from "./cron-reconcile-tick.js";

const SECRET = "tick-secret";
const ZERO = "0x0000000000000000000000000000000000000000";

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { authorization: `Bearer ${SECRET}` },
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

// Build a supabase admin mock whose `select(...).gt(...).limit(N)` resolves
// to { data: rows } so we control which addresses surface in the tick.
function adminWithActivities(rows: Array<{ user_from?: string; user_to?: string }>) {
  const limitMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain,
    gt: () => chain,
    limit: limitMock,
  };
  return { from: () => chain };
}

beforeEach(() => {
  getSupabaseAdminMock.mockReset();
  process.env.CRON_SECRET = SECRET;
  delete process.env.VERCEL_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_URL;
});

describe("cron-reconcile-tick — auth gate (§15.x)", () => {
  it("returns 401 when CRON_SECRET env is unset (fail-closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when Authorization is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: {} }), res);
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when bearer doesn't match the secret", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer wrong" } }), res);
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when bearer prefix is missing even if value matches", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: SECRET } }), res);
    expect(res.captured.status).toBe(401);
  });
});

describe("cron-reconcile-tick — no-DB graceful (§15.x)", () => {
  it("returns 200 status='no-db' when supabase admin is missing", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("no-db");
    expect(res.captured.body?.indexed).toBe(0);
  });
});

describe("cron-reconcile-tick — address aggregation (§15.x)", () => {
  it("skips 0x0 sender/receiver addresses (audit-relevant: avoids wasted RPC on burn/mint)", async () => {
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bob = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    getSupabaseAdminMock.mockReturnValue(
      adminWithActivities([
        { user_from: ZERO, user_to: alice }, // 0x0 sender filtered, alice kept
        { user_from: bob, user_to: ZERO },   // bob kept, 0x0 receiver filtered
      ]),
    );

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ indexed: 1 }),
    }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.captured.body?.addresses).toBe(2);
    // 2 addresses × 3 chains = 6 fetch calls, NOT 6 + 3 (zero address skipped).
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    // Verify no fetch carried the zero address.
    const calls = fetchSpy.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    const bodies = calls.map((c) => JSON.parse(c[1].body as string));
    for (const b of bodies) {
      expect(b.address).not.toBe(ZERO);
    }
  });

  it("dedups the same address appearing as sender + receiver across multiple rows", async () => {
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    getSupabaseAdminMock.mockReturnValue(
      adminWithActivities([
        { user_from: alice, user_to: alice }, // self-send: dedup to 1
        { user_from: alice, user_to: alice },
        { user_from: alice, user_to: alice },
      ]),
    );

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ indexed: 0 }),
    }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.captured.body?.addresses).toBe(1);
    // 1 address × 3 chains = 3 fetch calls.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("caps the per-tick address set at MAX_ADDRESSES_PER_TICK (=50)", async () => {
    // Generate 100 distinct addresses; the cap kicks in at 50.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      user_from: "0x" + i.toString(16).padStart(40, "0"),
      user_to: ZERO,
    }));
    getSupabaseAdminMock.mockReturnValue(adminWithActivities(rows));

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ indexed: 0 }),
    }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.captured.body?.addresses).toBe(50);
    expect(fetchSpy).toHaveBeenCalledTimes(50 * 3);
  });
});

describe("cron-reconcile-tick — reconcile-user fanout (§15.x)", () => {
  beforeEach(() => {
    const alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    getSupabaseAdminMock.mockReturnValue(
      adminWithActivities([{ user_from: alice }]),
    );
  });

  it("sums totalIndexed across all (address, chainId) reconcile-user calls", async () => {
    // 1 address × 3 chains: each returns indexed=3 -> totalIndexed = 9.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ indexed: 3 }),
    }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.captured.body?.totalIndexed).toBe(9);
  });

  it("a failing reconcile-user call does NOT kill the tick (others still run)", async () => {
    let callIdx = 0;
    const fetchSpy = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("rpc 502");
      return { ok: true, json: async () => ({ indexed: 5 }) };
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    // First call rejected -> the remaining two still run and contribute 5 each.
    expect(res.captured.body?.totalIndexed).toBe(10);
    expect(res.captured.status).toBe(200);
  });

  it("non-OK reconcile-user response is silently ignored (no totalIndexed bump)", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "rate limited" }),
    }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.captured.body?.totalIndexed).toBe(0);
  });

  it("body shape: includes addresses + chainsPerAddress=3 + totalIndexed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ indexed: 0 }) })) as unknown as typeof fetch,
    );

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res.captured.body!;
    expect(body.status).toBe("ok");
    expect(typeof body.addresses).toBe("number");
    expect(body.chainsPerAddress).toBe(3);
    expect(typeof body.totalIndexed).toBe("number");
  });

  it("uses https://VERCEL_URL when set, localhost otherwise (deploy-aware base URL)", async () => {
    process.env.VERCEL_URL = "blank-vercel-deploy.vercel.app";
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ indexed: 0 }) }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const res = makeRes();
    await handler(makeReq(), res);

    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit?]>;
    const url = calls[0]?.[0];
    if (!url) throw new Error("fetch was not called");
    expect(url).toBe("https://blank-vercel-deploy.vercel.app/api/reconcile-user");
  });
});
