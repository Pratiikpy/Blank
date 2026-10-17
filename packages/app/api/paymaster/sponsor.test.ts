// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /api/paymaster/sponsor request layer: method + chain + sender gates, the
// two rate limits (per IP, per account), the fail-closed key check, and
// SponsorError -> HTTP mapping. The sponsorship logic itself is covered in
// _lib/paymaster-sponsor.test.ts.

const checkRateLimitMock = vi.hoisted(() => vi.fn());
const sponsorUserOpMock = vi.hoisted(() => vi.fn());

vi.mock("../_lib/rate-limit.js", () => ({
  checkRateLimit: checkRateLimitMock,
  writeRateLimitHeaders: vi.fn(),
}));
vi.mock("../_lib/paymaster-sponsor.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/paymaster-sponsor.js")>("../_lib/paymaster-sponsor.js");
  return {
    ...actual,
    sponsorUserOp: sponsorUserOpMock,
    ethersSponsorChain: () => ({}),
  };
});

import handler from "./sponsor.js";
import { SponsorError } from "../_lib/paymaster-sponsor.js";

const SENDER = "0x" + "5e".repeat(20);
const body = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  userOp: { sender: SENDER, nonce: "0", initCode: "0x", callData: "0xb61d27f6", accountGasLimits: "0x" + "00".repeat(32), preVerificationGas: "0" },
  ...over,
});

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown>; headers: Record<string, string> } = { headers: {} };
  return {
    captured,
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    status(s: number) { captured.status = s; return this; },
    json(b: Record<string, unknown>) { captured.body = b; return this; },
  };
}

const req = (method: string, b?: unknown, query?: Record<string, string>) => ({
  method, body: b, query, headers: { "x-forwarded-for": "1.2.3.4" },
});

beforeEach(() => {
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ ok: true, resetSeconds: 0 });
  sponsorUserOpMock.mockReset();
  process.env.BLANK_PAYMASTER_SIGNER_PK = "0x" + "11".repeat(32);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.BLANK_PAYMASTER_SIGNER_PK;
  vi.restoreAllMocks();
});

describe("/api/paymaster/sponsor", () => {
  it("405 for anything but GET/POST", async () => {
    const res = makeRes();
    await handler(req("PUT"), res);
    expect(res.captured.status).toBe(405);
  });

  it("400 on an unsupported chain or a bad sender", async () => {
    let res = makeRes();
    await handler(req("POST", body({ chainId: 1 })), res);
    expect(res.captured.status).toBe(400);
    res = makeRes();
    await handler(req("POST", body({ userOp: { sender: "nope" } })), res);
    expect(res.captured.status).toBe(400);
    expect(sponsorUserOpMock).not.toHaveBeenCalled();
  });

  it("429 from the per-IP limit, then from the per-account limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ ok: false, resetSeconds: 30 });
    let res = makeRes();
    await handler(req("POST", body()), res);
    expect(res.captured.status).toBe(429);

    checkRateLimitMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, resetSeconds: 12 });
    res = makeRes();
    await handler(req("POST", body()), res);
    expect(res.captured.status).toBe(429);
    expect(String(res.captured.body?.error)).toMatch(/this account/);
    expect(checkRateLimitMock.mock.calls[2][0]).toMatchObject({ ip: `84532:${SENDER}`, key: "pm-sponsor-sender" });
    expect(sponsorUserOpMock).not.toHaveBeenCalled();
  });

  it("503 NOT_CONFIGURED when BLANK_PAYMASTER_SIGNER_PK is missing (fails closed, never signs)", async () => {
    delete process.env.BLANK_PAYMASTER_SIGNER_PK;
    const res = makeRes();
    await handler(req("POST", body()), res);
    expect(res.captured.status).toBe(503);
    expect(res.captured.body?.code).toBe("NOT_CONFIGURED");
    expect(sponsorUserOpMock).not.toHaveBeenCalled();
  });

  it("maps a SponsorError to its status + code, with Retry-After when given", async () => {
    sponsorUserOpMock.mockRejectedValue(new SponsorError("RATE_LIMITED", "next sponsored op allowed in 40s", 429, 40));
    const res = makeRes();
    await handler(req("POST", body()), res);
    expect(res.captured.status).toBe(429);
    expect(res.captured.body).toEqual({ error: "next sponsored op allowed in 40s", code: "RATE_LIMITED" });
    expect(res.captured.headers["Retry-After"]).toBe("40");
  });

  it("200 with the sponsorship, passing the op and account claim through", async () => {
    sponsorUserOpMock.mockResolvedValue({ paymasterAndData: "0xabc" });
    const res = makeRes();
    const claim = { ownerX: "1", ownerY: "2" };
    await handler(req("POST", JSON.stringify(body({ account: claim }))), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body).toEqual({ paymasterAndData: "0xabc" });
    expect(sponsorUserOpMock.mock.calls[0][2]).toMatchObject({ account: claim });
  });

  it("GET health: ready=false with the reason when the key is missing", async () => {
    delete process.env.BLANK_PAYMASTER_SIGNER_PK;
    const res = makeRes();
    await handler(req("GET", undefined, { chainId: "84532" }), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.ready).toBe(false);
    expect(String(res.captured.body?.error)).toMatch(/BLANK_PAYMASTER_SIGNER_PK/);
  });
});
