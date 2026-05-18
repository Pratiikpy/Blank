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
const verifyOwnerSignatureMock = vi.hoisted(() => vi.fn());
const strictScheduledSendsAuthEnabledMock = vi.hoisted(() => vi.fn());
const checkTimestampWindowMock = vi.hoisted(() => vi.fn());
const buildScheduledSendCreateMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: writeRateLimitHeadersMock,
}));

vi.mock("../_lib/session-keys-store.js", () => ({
  storeSessionKey: storeSessionKeyMock,
}));

vi.mock("../_lib/sig-auth.js", () => ({
  verifyOwnerSignature: verifyOwnerSignatureMock,
  strictScheduledSendsAuthEnabled: strictScheduledSendsAuthEnabledMock,
  checkTimestampWindow: checkTimestampWindowMock,
  buildScheduledSendCreateMessage: buildScheduledSendCreateMessageMock,
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
  verifyOwnerSignatureMock.mockReset();
  strictScheduledSendsAuthEnabledMock.mockReset();
  checkTimestampWindowMock.mockReset();
  buildScheduledSendCreateMessageMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 3600 });
  storeSessionKeyMock.mockResolvedValue(undefined);
  // Default mode for legacy-shape tests: LAX (unsigned requests proceed).
  // The new strict-mode tests override per-test.
  strictScheduledSendsAuthEnabledMock.mockReturnValue(false);
  // Default-good signature verification when sig fields are present.
  verifyOwnerSignatureMock.mockResolvedValue({ ok: true });
  checkTimestampWindowMock.mockReturnValue(null);
  buildScheduledSendCreateMessageMock.mockReturnValue("test-message");
  // Silence the success-path log line + the unsigned-request warning during tests.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

// ─── #350 wallet-signed auth (anti-pollution gate) ──────────────────
//
// Pre-fix the endpoint generated + stored a server-side keypair on ANY
// POST with a syntactically valid body. An attacker who knew (or
// guessed) a victim's AA address could spam keypair generation tied to
// that account, exhausting KMS slots and polluting the row store. The
// fix attaches a wallet signature requirement: the caller must prove
// they control `body.account` before the server creates the key. Strict
// mode (default-on) rejects unsigned requests; lax mode (legacy /
// local dev) accepts them with a warn log.

const SIGNED_BODY = {
  ...VALID_BODY,
  signature: "0xabcd" as const,
  signerAddress: VALID_BODY.account,
  signedAt: Math.floor(Date.now() / 1000),
  signerChainId: VALID_BODY.chainId,
};

describe("/api/scheduled-sends/create — #350 strict-mode auth gate", () => {
  it("strict mode rejects unsigned requests with 401", async () => {
    strictScheduledSendsAuthEnabledMock.mockReturnValue(true);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("signature required");
    // The keystore must NOT be touched on rejection.
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });

  it("strict mode accepts a valid signed request (200)", async () => {
    strictScheduledSendsAuthEnabledMock.mockReturnValue(true);
    const res = makeRes();
    await handler(makeReq({ body: SIGNED_BODY }), res);
    expect(res.captured.status).toBe(200);
    expect(verifyOwnerSignatureMock).toHaveBeenCalledOnce();
  });

  it("lax mode (default) still accepts unsigned requests — keeps legacy callers working", async () => {
    strictScheduledSendsAuthEnabledMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ body: VALID_BODY }), res);
    expect(res.captured.status).toBe(200);
    // verifyOwnerSignature MUST NOT be called when no sig fields present.
    expect(verifyOwnerSignatureMock).not.toHaveBeenCalled();
  });
});

describe("/api/scheduled-sends/create — #350 signature verification", () => {
  it("rejects signedAt outside the timestamp window (401)", async () => {
    checkTimestampWindowMock.mockReturnValue("signedAt is too old (max 90s)");
    const res = makeRes();
    await handler(makeReq({ body: SIGNED_BODY }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("too old");
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });

  it("rejects when signerAddress doesn't match account (403, anti-impersonation)", async () => {
    // Attacker signed for their own address but POSTed the victim's
    // account in the body — must reject before doing crypto.
    const res = makeRes();
    await handler(
      makeReq({
        body: { ...SIGNED_BODY, signerAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      }),
      res,
    );
    expect(res.captured.status).toBe(403);
    expect((res.captured.body?.error as string)).toContain("signer does not match account");
    expect(verifyOwnerSignatureMock).not.toHaveBeenCalled();
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });

  it("rejects when verifyOwnerSignature returns ok:false (401, sig mismatch)", async () => {
    verifyOwnerSignatureMock.mockResolvedValue({ ok: false, reason: "ecdsa-mismatch" });
    const res = makeRes();
    await handler(makeReq({ body: SIGNED_BODY }), res);
    expect(res.captured.status).toBe(401);
    expect((res.captured.body?.error as string)).toContain("ecdsa-mismatch");
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });

  it("returns 500 if the sig-auth module throws unexpectedly (verifier broken)", async () => {
    verifyOwnerSignatureMock.mockRejectedValue(new Error("rpc unreachable"));
    const res = makeRes();
    await handler(makeReq({ body: SIGNED_BODY }), res);
    expect(res.captured.status).toBe(500);
    expect(storeSessionKeyMock).not.toHaveBeenCalled();
  });

  it("binds account + recipient + spendToken into the signed message (replay protection)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: SIGNED_BODY }), res);
    expect(buildScheduledSendCreateMessageMock).toHaveBeenCalledOnce();
    const args = buildScheduledSendCreateMessageMock.mock.calls[0][0];
    expect(args.account).toBe(SIGNED_BODY.account);
    expect(args.recipient).toBe(SIGNED_BODY.recipient);
    expect(args.spendToken).toBe(SIGNED_BODY.spendToken);
    expect(args.chainId).toBe(SIGNED_BODY.chainId);
    expect(args.signedAt).toBe(SIGNED_BODY.signedAt);
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
