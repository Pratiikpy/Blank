import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for cron-scheduled-sends-tick. The CRON_SECRET fail-
// closed gate is the most consequential one in the codebase: an
// unauthenticated attacker hammering this endpoint could burn every
// active scope's per-period budget for free, because the validator
// advances lastFiredAt even on execution-phase reverts, locking
// real users out of their own scopes until next period.
//
// Coverage focuses on auth + the audit-relevant paths that don't
// need a full ethers/RPC stack: misconfigured validator address,
// empty keys list, listActiveKeysForChain rejection, snapshot shape.

const listActiveKeysForChainMock = vi.hoisted(() => vi.fn());

vi.mock("../session-keys-store.js", () => ({
  listActiveKeysForChain: listActiveKeysForChainMock,
  signWithSessionKey: vi.fn(),
  markRevoked: vi.fn(),
}));

import handler from "./cron-scheduled-sends-tick.js";

const SECRET = "tick-secret";

function makeReq(opts: Partial<{ method: string; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
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

beforeEach(() => {
  listActiveKeysForChainMock.mockReset();
  listActiveKeysForChainMock.mockResolvedValue([]);
  process.env.CRON_SECRET = SECRET;
  delete process.env.VITE_BLANK_11155111_SESSION_KEY_VALIDATOR;
  delete process.env.VITE_BLANK_84532_SESSION_KEY_VALIDATOR;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe("cron-scheduled-sends-tick — auth gate (§15.x)", () => {
  it("returns 401 when CRON_SECRET is unset (fail-closed prevents budget burn)", async () => {
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

  it("returns 401 when bearer secret is wrong", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer wrong" } }), res);
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when value matches but 'Bearer ' prefix is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: SECRET } }), res);
    expect(res.captured.status).toBe(401);
  });

  it("does NOT call listActiveKeysForChain when auth fails (no budget probing)", async () => {
    delete process.env.CRON_SECRET;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(listActiveKeysForChainMock).not.toHaveBeenCalled();
  });
});

describe("cron-scheduled-sends-tick — happy-path shape (§15.x)", () => {
  it("returns 200 with status='ok' + snapshots array covering both supported chains", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("ok");

    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.chainId).sort()).toEqual([11155111, 84532]);
  });

  it("scanned=0 and no errors when no active keys for either chain", async () => {
    listActiveKeysForChainMock.mockResolvedValue([]);
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<Record<string, unknown>>;
    for (const s of snapshots) {
      expect(s.scanned).toBe(0);
      expect(s.fired).toBe(0);
      expect(s.skipped).toBe(0);
      expect(s.errored).toBe(0);
      expect(s.errors).toEqual([]);
    }
  });
});

describe("cron-scheduled-sends-tick — listActiveKeysForChain rejection (§15.x)", () => {
  it("captures the listing error in snap.errors AND moves on to the next chain", async () => {
    listActiveKeysForChainMock.mockRejectedValue(new Error("Supabase RLS denied"));
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number; errors: string[] }>;
    for (const s of snapshots) {
      expect(s.errors.length).toBeGreaterThan(0);
      expect(s.errors[0]).toContain("list:Supabase RLS denied");
    }
    // The handler still returned 200 — one chain's failure doesn't
    // abort the whole tick.
    expect(res.captured.status).toBe(200);
  });

  it("truncates long listing errors to 120 chars to keep logs sane", async () => {
    const longMsg = "x".repeat(500);
    listActiveKeysForChainMock.mockRejectedValue(new Error(longMsg));
    const res = makeRes();
    await handler(makeReq(), res);
    const snap = (res.captured.body?.snapshots as Array<{ errors: string[] }>)[0];
    // Prefix "list:" + 120 chars truncated body = 125 total.
    expect(snap.errors[0].length).toBeLessThanOrEqual(125);
  });
});

describe("cron-scheduled-sends-tick — validator address config (§15.x)", () => {
  it("records 'config:VITE_BLANK_<chain>_SESSION_KEY_VALIDATOR unset' when missing for active-keys chain", async () => {
    // Force a non-empty keys list so we reach the validator-config check.
    listActiveKeysForChainMock.mockResolvedValue([
      {
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sessionKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        encryptedPrivateKey: "encrypted-blob",
        chainId: 11155111,
      },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number; errors: string[]; scanned: number }>;
    const eth = snapshots.find((s) => s.chainId === 11155111)!;
    expect(eth.scanned).toBe(1);
    expect(eth.errors).toContain("config:VITE_BLANK_<chain>_SESSION_KEY_VALIDATOR unset");
  });

  it("records the same config error when validator env value is malformed (not a 0x-40-char hex)", async () => {
    listActiveKeysForChainMock.mockResolvedValue([
      {
        account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sessionKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        encryptedPrivateKey: "blob",
        chainId: 11155111,
      },
    ]);
    process.env.VITE_BLANK_11155111_SESSION_KEY_VALIDATOR = "not-an-address";

    const res = makeRes();
    await handler(makeReq(), res);
    const eth = (res.captured.body?.snapshots as Array<{ chainId: number; errors: string[] }>).find(
      (s) => s.chainId === 11155111,
    )!;
    expect(eth.errors).toContain("config:VITE_BLANK_<chain>_SESSION_KEY_VALIDATOR unset");
    delete process.env.VITE_BLANK_11155111_SESSION_KEY_VALIDATOR;
  });
});
