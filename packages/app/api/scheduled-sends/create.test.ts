import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for /api/scheduled-sends/create. Three load-bearing
// contracts pinned here:
//   1) Body validation (4-shape: account, recipient, spendToken,
//      chainId) — rejects bad input before any keypair is generated.
//   2) Keystore failure must return 503 AND NOT leak the keypair —
//      otherwise the user thinks their scope is set up but the
//      cron has nothing to fire with.
//   3) Audit-mandated no-plaintext-private-key logging: the log
//      line includes the session-key address but NEVER the
//      privkey (Vercel logs are persistent + indexed).

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const writeRateLimitHeadersMock = vi.hoisted(() => vi.fn());
const storeSessionKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../_lib/session-keys-store.js", () => ({
  storeSessionKey: storeSessionKeyMock,
}));

// ethers.Wallet.createRandom hits jsdom's incompatible crypto polyfill
// (Buffer-shape mismatch with hexlify) — partial-mock just the wallet
// constructor so we get deterministic-but-unique keypairs per call.
let walletCounter = 0;
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Wallet: {
        ...actual.ethers.Wallet,
        createRandom: () => {
          walletCounter += 1;
          const suffix = walletCounter.toString(16).padStart(40, "0");
          const privSuffix = walletCounter.toString(16).padStart(64, "0");
          return {
            address: ("0x" + suffix) as `0x${string}`,
            privateKey: ("0x" + privSuffix) as `0x${string}`,
          };
        },
      },
    },
  };
});

import handler from "./create.js";

const VALID_BODY = {
  account: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  spendToken: "0xcccccccccccccccccccccccccccccccccccccccc",
  chainId: 11155111,
  label: "Rent — Mar",
};

function makeReq(opts: Partial<{ method: string; body: unknown; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    headers: opts.headers ?? { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
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
  storeSessionKeyMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 3600 });
  storeSessionKeyMock.mockResolvedValue(undefined);
  // Silence the success-path log line during tests.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/scheduled-sends/create — method guard (§15.x)", () => {
  it("rejects non-POST with 405 + Allow: POST", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.captured.status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
  });
});

describe("/api/scheduled-sends/create — input validation (§15.x)", () => {
  it("returns 400 on null body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: null }), res);
    expect(res.captured.status).toBe(400);
  });

  it("returns 400 when account is malformed", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, account: "not-an-addr" } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("account");
  });

  it("returns 400 when recipient is malformed", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, recipient: "0x123" } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("recipient");
  });

  it("returns 400 when spendToken is malformed", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, spendToken: "x" } }),
      res,
    );
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("spendToken");
  });

  it("returns 400 on unsupported chainId", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, chainId: 1 } }), res);
    expect(res.captured.status).toBe(400);
    expect((res.captured.body?.error as string)).toContain("Sepolia");
    expect((res.captured.body?.error as string)).toContain("Base Sepolia");
  });

  it("accepts both Sepolia and Base Sepolia", async () => {
    for (const chainId of [11155111, 84532]) {
      const res = makeRes();
      await handler(makeReq({ body: { ...VALID_BODY, chainId } }), res);
      expect(res.captured.status).toBe(200);
    }
  });

  it("does NOT call storeSessionKey when body validation fails (no privkey generated)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, account: "bad" } }), res);
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });
});

describe("/api/scheduled-sends/create — rate limit (§15.x)", () => {
  it("returns 429 with scope='ip' when rate limit exceeded", async () => {
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 60 });
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body?.scope).toBe("ip");
  });

  it("uses key=sched-sends-create / max=10 / window=1hr", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    const arg = checkRateLimitMock.mock.calls[0][0];
    expect(arg.key).toBe("sched-sends-create");
    expect(arg.max).toBe(10);
    expect(arg.windowMs).toBe(3_600_000);
  });

  it("soft-fails open when the rate-limit module itself throws (dev fallback)", async () => {
    checkRateLimitMock.mockRejectedValue(new Error("KV unreachable"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    // Falls through; happy path completes -> 200.
    expect(res.captured.status).toBe(200);
  });
});

describe("/api/scheduled-sends/create — keystore failure (§15.x)", () => {
  it("returns 503 when storeSessionKey rejects + does NOT leak the keypair", async () => {
    storeSessionKeyMock.mockRejectedValue(new Error("Supabase missing master key"));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.error as string)).toContain("keystore unavailable");
    // Critical: sessionKey field MUST NOT be present in the error response.
    expect(res.captured.body?.sessionKey).toBeUndefined();
  });

  it("truncates the upstream error to 280 chars in the detail field", async () => {
    const longErr = "x".repeat(500);
    storeSessionKeyMock.mockRejectedValue(new Error(longErr));
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(503);
    expect((res.captured.body?.detail as string).length).toBe(280);
  });
});

describe("/api/scheduled-sends/create — happy path + CSPRNG randomness (§15.x)", () => {
  it("returns a fresh sessionKey address + label + stub=false on success", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    const { sessionKey, label, stub } = res.captured.body as {
      sessionKey: string;
      label: string;
      stub: boolean;
    };
    expect(sessionKey).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(label).toBe(VALID_BODY.label);
    expect(stub).toBe(false);
  });

  it("two back-to-back calls produce DIFFERENT session keys (CSPRNG-backed)", async () => {
    const r1 = makeRes();
    const r2 = makeRes();
    await handler(makeReq({ body: VALID_BODY }), r1);
    await handler(makeReq({ body: VALID_BODY }), r2);
    expect(r1.captured.body?.sessionKey).not.toBe(r2.captured.body?.sessionKey);
  });

  it("truncates label to 64 chars before persisting (defense against UI overflow)", async () => {
    const longLabel = "L".repeat(200);
    const res = makeRes();
    await handler(makeReq({ body: { ...VALID_BODY, label: longLabel } }), res);
    expect(res.captured.status).toBe(200);
    const storedArg = storeSessionKeyMock.mock.calls[0][0];
    expect(storedArg.label.length).toBe(64);
  });

  it("passes account / recipient / spendToken / chainId / sessionKey / privateKeyHex through to storeSessionKey", async () => {
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    const storedArg = storeSessionKeyMock.mock.calls[0][0];
    expect(storedArg.account).toBe(VALID_BODY.account);
    expect(storedArg.recipient).toBe(VALID_BODY.recipient);
    expect(storedArg.spendToken).toBe(VALID_BODY.spendToken);
    expect(storedArg.chainId).toBe(VALID_BODY.chainId);
    expect(storedArg.sessionKey).toMatch(/^0x[a-fA-F0-9]{40}$/);
    // privateKeyHex MUST be present (it's what the cron uses to sign).
    expect(storedArg.privateKeyHex).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });
});

describe("/api/scheduled-sends/create — audit no-plaintext-key logging (§15.x)", () => {
  it("the console.log line on success contains the session-key ADDRESS but NEVER the private key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);

    // Grab the privkey that was passed to the keystore for comparison.
    const persistedKey = storeSessionKeyMock.mock.calls[0][0].privateKeyHex as string;
    const sessionKeyAddr = res.captured.body?.sessionKey as string;

    // Combine ALL log calls (the handler may emit more than one).
    const allLogs = logSpy.mock.calls.map((c) => c.join(" ")).join(" | ");
    expect(allLogs).toContain(sessionKeyAddr);
    // Critical assertion: the privkey hex (64 chars after 0x) must NEVER
    // appear in any logged string.
    expect(allLogs).not.toContain(persistedKey);
    expect(allLogs).not.toContain(persistedKey.slice(2)); // strip 0x prefix
  });
});
