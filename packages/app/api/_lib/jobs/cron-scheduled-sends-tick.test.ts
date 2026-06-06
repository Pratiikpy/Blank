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
  it("returns 200 with status='ok' + snapshots array covering all supported chains", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("ok");

    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number }>;
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([84532, 421614, 11155111].sort((a, b) => a - b));
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

// §15.x extension: auth case-sensitivity + empty-secret + per-chain
// isolation + snapshot init defaults + multi-chain processing.

describe("cron-scheduled-sends-tick — auth case-sensitivity + empty values", () => {
  it("returns 401 when CRON_SECRET is empty string (fail-closed treats empty as missing)", async () => {
    process.env.CRON_SECRET = "";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(401);
    expect(listActiveKeysForChainMock).not.toHaveBeenCalled();
  });

  it("returns 401 when scheme is 'bearer' (lowercase) — the source compares 'Bearer ' exactly", async () => {
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: `bearer ${SECRET}` } }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when Authorization has the right token but extra whitespace before it", async () => {
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: `Bearer  ${SECRET}` } }), // double space
      res,
    );
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 when CRON_SECRET equals the literal string 'Bearer '+something (no spoofing via secret value)", async () => {
    process.env.CRON_SECRET = "Bearer real-secret";
    const res = makeRes();
    // Attacker passes the secret directly without a Bearer prefix —
    // the source requires `Bearer ${expected}` so this MUST 401.
    await handler(
      makeReq({ headers: { authorization: "Bearer real-secret" } }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });
});

describe("cron-scheduled-sends-tick — snapshot defaults + array init", () => {
  it("snap.errors is an empty array (not undefined) when no errors occurred", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<Record<string, unknown>>;
    for (const s of snapshots) {
      // The shape pins that errors is ALWAYS an Array, never undefined.
      // A regression that lazy-inited it would leak `undefined` to JSON
      // consumers (jq filters would crash, frontend would error).
      expect(Array.isArray(s.errors)).toBe(true);
      expect(s.errors).toEqual([]);
    }
  });

  it("every snapshot has all 6 documented fields (chainId / scanned / fired / skipped / errored / errors)", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<Record<string, unknown>>;
    for (const s of snapshots) {
      expect(s).toHaveProperty("chainId");
      expect(s).toHaveProperty("scanned");
      expect(s).toHaveProperty("fired");
      expect(s).toHaveProperty("skipped");
      expect(s).toHaveProperty("errored");
      expect(s).toHaveProperty("errors");
    }
  });

  it("snapshots array is in canonical chain-id order (11155111 then 84532 then 421614)", async () => {
    // The source iterates SUPPORTED_CHAINS in declared order; pin it
    // so a JSON consumer can rely on the position-based indexing.
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number }>;
    expect(snapshots[0]!.chainId).toBe(11155111);
    expect(snapshots[1]!.chainId).toBe(84532);
    expect(snapshots[2]!.chainId).toBe(421614);
  });
});

describe("cron-scheduled-sends-tick — per-chain isolation", () => {
  it("a validator-config error on ETH Sepolia does NOT prevent Base Sepolia from scanning + processing", async () => {
    // Set up keys only for ETH and only set the BASE validator — so
    // ETH lands on the config error, BASE has no keys and lands on
    // the no-keys early-return. Both snapshots should populate.
    listActiveKeysForChainMock.mockImplementation(async (chainId: number) => {
      if (chainId === 11155111) {
        return [{
          account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sessionKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          encryptedPrivateKey: "blob",
          chainId,
          label: "",
          recipient: "0xc0",
          spendToken: "0xc1",
        }];
      }
      return [];
    });
    // Both chains miss their validator config -> both record the config error.
    // We're verifying the per-chain ITERATION: a failure on chain 1 doesn't
    // skip chain 2's snapshot creation.
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number; scanned: number; errors: string[] }>;
    const eth = snapshots.find((s) => s.chainId === 11155111)!;
    const base = snapshots.find((s) => s.chainId === 84532)!;
    expect(eth).toBeDefined();
    expect(base).toBeDefined();
    expect(eth.scanned).toBe(1);
    expect(base.scanned).toBe(0);
    expect(eth.errors.some((e) => e.startsWith("config:"))).toBe(true);
  });

  it("listActiveKeysForChain rejection on ONE chain doesn't abort the OTHER chain's snapshot creation", async () => {
    listActiveKeysForChainMock.mockImplementation(async (chainId: number) => {
      if (chainId === 11155111) {
        throw new Error("supabase ETH timeout");
      }
      return [];
    });
    const res = makeRes();
    await handler(makeReq(), res);
    const snapshots = res.captured.body?.snapshots as Array<{ chainId: number; errors: string[] }>;
    // All snapshots exist; ETH has the error, BASE + ARB are clean.
    expect(snapshots).toHaveLength(3);
    const eth = snapshots.find((s) => s.chainId === 11155111)!;
    const base = snapshots.find((s) => s.chainId === 84532)!;
    const arb = snapshots.find((s) => s.chainId === 421614)!;
    expect(eth.errors.length).toBeGreaterThan(0);
    expect(base.errors).toEqual([]);
    expect(arb.errors).toEqual([]);
  });

  it("handler returns 200 even when EVERY chain hit the list-rejection path (overall status is 'ok')", async () => {
    listActiveKeysForChainMock.mockRejectedValue(new Error("everywhere fails"));
    const res = makeRes();
    await handler(makeReq(), res);
    // The handler's contract: 200 + status='ok' with errors captured
    // in the snapshots. A 5xx would suggest pipeline-level failure
    // and prompt PagerDuty; 200 with per-chain errors keeps the cron
    // visible without paging on transient supabase blips.
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("ok");
  });
});
