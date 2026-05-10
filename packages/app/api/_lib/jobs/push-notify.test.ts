import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for push-notify. Pins the bearer-auth gate (without it
// anyone could spam users) and the auto-prune contract for dead
// browser subscriptions (HTTP 404/410 from the push service).
// Without the prune, dead rows accumulate forever in Supabase, each
// slowing down every subsequent fan-out.

const sendPushMock = vi.hoisted(() => vi.fn());
const webPushConfiguredMock = vi.hoisted(() => vi.fn());
const getSupabaseAdminMock = vi.hoisted(() => vi.fn());

vi.mock("../web-push.js", () => ({
  sendPush: sendPushMock,
  webPushConfigured: webPushConfiguredMock,
}));

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

import handler from "./push-notify.js";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VALID_PAYLOAD = { title: "Acme paid", body: "$3,700 received" };

const SECRET = "test-secret-123";

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

// Builder for supabase admin mock with controllable select() result.
function makeAdmin(opts: {
  selectData?: Array<{ endpoint: string; p256dh: string; auth: string }>;
  selectError?: { message: string } | null;
}) {
  const selectInMock = vi.fn().mockResolvedValue({
    data: opts.selectData ?? [],
    error: opts.selectError ?? null,
  });
  const deleteInMock = vi.fn().mockResolvedValue({ error: null });
  return {
    selectInMock,
    deleteInMock,
    client: {
      from: () => ({
        select: () => ({ in: selectInMock }),
        delete: () => ({ in: deleteInMock }),
      }),
    },
  };
}

beforeEach(() => {
  sendPushMock.mockReset();
  webPushConfiguredMock.mockReset();
  getSupabaseAdminMock.mockReset();

  process.env.PUSH_NOTIFY_SECRET = SECRET;
  webPushConfiguredMock.mockReturnValue(true);
  getSupabaseAdminMock.mockReturnValue(makeAdmin({ selectData: [] }).client);
  sendPushMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.PUSH_NOTIFY_SECRET;
});

describe("push-notify — method guard (§15.x)", () => {
  it("rejects non-POST with 405 + Allow: POST", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});

describe("push-notify — bearer auth gate (§15.x)", () => {
  it("returns 503 when PUSH_NOTIFY_SECRET env is unset", async () => {
    delete process.env.PUSH_NOTIFY_SECRET;
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("PUSH_NOTIFY_SECRET");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { addresses: [ALICE], payload: VALID_PAYLOAD },
        headers: {},
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when Authorization bearer doesn't match the secret", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { addresses: [ALICE], payload: VALID_PAYLOAD },
        headers: { authorization: "Bearer wrong-secret" },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 even when the secret value matches but the 'Bearer ' prefix is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { addresses: [ALICE], payload: VALID_PAYLOAD },
        headers: { authorization: SECRET },
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });
});

describe("push-notify — service-config gates (§15.x)", () => {
  it("returns 503 when Web Push is not configured (VAPID missing)", async () => {
    webPushConfiguredMock.mockReturnValue(false);
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("VAPID");
  });

  it("returns 503 when Supabase admin is not configured", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(503);
  });
});

describe("push-notify — body validation (§15.x)", () => {
  it("returns 400 when body is null", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when addresses is not an array", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { addresses: "not-array", payload: VALID_PAYLOAD } }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when addresses is an array but contains no valid hex addresses", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: ["not-hex", 12345, "0x123"], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("at least one valid");
  });

  it("returns 400 when payload.title is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: { body: "x" } } }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when payload.body is missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: { title: "x" } } }),
      res,
    );
    expect(res.captured.status).toBe(400);
  });

  it("normalizes addresses to lowercase before querying Supabase", async () => {
    const admin = makeAdmin({ selectData: [] });
    getSupabaseAdminMock.mockReturnValue(admin.client);

    const mixedCase = "0x" + ALICE.slice(2).toUpperCase();
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [mixedCase], payload: VALID_PAYLOAD } }),
      res,
    );

    expect(admin.selectInMock).toHaveBeenCalledWith("address", [ALICE.toLowerCase()]);
  });

  it("filters out non-hex entries but keeps the valid ones (mixed array)", async () => {
    const admin = makeAdmin({ selectData: [] });
    getSupabaseAdminMock.mockReturnValue(admin.client);
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          addresses: [ALICE, "not-hex", 12345, BOB, "0x123"],
          payload: VALID_PAYLOAD,
        },
      }),
      res,
    );
    expect(admin.selectInMock).toHaveBeenCalledWith("address", [ALICE, BOB]);
  });
});

describe("push-notify — Supabase lookup error (§15.x)", () => {
  it("returns 500 when the select query errors", async () => {
    const admin = makeAdmin({ selectError: { message: "RLS denied" } });
    getSupabaseAdminMock.mockReturnValue(admin.client);
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(500);
    expect(res.captured.body?.error).toBe("RLS denied");
  });
});

describe("push-notify — no subscriptions (§15.x)", () => {
  it("returns sent=0 + pruned=0 (no sendPush call) when address has no subs", async () => {
    const admin = makeAdmin({ selectData: [] });
    getSupabaseAdminMock.mockReturnValue(admin.client);
    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.sent).toBe(0);
    expect(res.captured.body?.pruned).toBe(0);
    expect(sendPushMock).not.toHaveBeenCalled();
  });
});

describe("push-notify — fanout + auto-prune (§15.x)", () => {
  it("increments sent for each ok push response", async () => {
    const subs = [
      { endpoint: "ep-1", p256dh: "k1", auth: "a1" },
      { endpoint: "ep-2", p256dh: "k2", auth: "a2" },
    ];
    getSupabaseAdminMock.mockReturnValue(makeAdmin({ selectData: subs }).client);
    sendPushMock.mockResolvedValue({ ok: true });

    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );

    expect(res.captured.body?.sent).toBe(2);
    expect(res.captured.body?.pruned).toBe(0);
  });

  it("prunes endpoints that return gone=true (404/410 from push service)", async () => {
    const admin = makeAdmin({
      selectData: [
        { endpoint: "alive", p256dh: "k1", auth: "a1" },
        { endpoint: "dead-1", p256dh: "k2", auth: "a2" },
        { endpoint: "dead-2", p256dh: "k3", auth: "a3" },
      ],
    });
    getSupabaseAdminMock.mockReturnValue(admin.client);
    sendPushMock.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint === "alive") return { ok: true };
      return { ok: false, gone: true };
    });

    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );

    expect(res.captured.body?.sent).toBe(1);
    expect(res.captured.body?.pruned).toBe(2);
    expect(admin.deleteInMock).toHaveBeenCalledWith("endpoint", ["dead-1", "dead-2"]);
  });

  it("does NOT prune transient failures (ok=false, gone=false)", async () => {
    const admin = makeAdmin({
      selectData: [{ endpoint: "transient-fail", p256dh: "k", auth: "a" }],
    });
    getSupabaseAdminMock.mockReturnValue(admin.client);
    sendPushMock.mockResolvedValue({ ok: false, gone: false });

    const res = makeRes();
    await handler(
      makeReq({ body: { addresses: [ALICE], payload: VALID_PAYLOAD } }),
      res,
    );

    expect(res.captured.body?.sent).toBe(0);
    expect(res.captured.body?.pruned).toBe(0);
    // delete.in() should NOT have been called.
    expect(admin.deleteInMock).not.toHaveBeenCalled();
  });
});
