import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for /api/relayer-health. The status enum (ok / low_funds /
// degraded / unconfigured) drives ops alerts AND the frontend's
// graceful-degradation decision (whether to gray out smart-wallet
// buttons). The endpoint always returns 200 by design — degraded
// ops must not block the frontend that calls this to decide UI state.

const getBalanceMock = vi.hoisted(() => vi.fn());
const getAddressMock = vi.hoisted(() => vi.fn());
const getSignerMock = vi.hoisted(() => vi.fn());

vi.mock("ethers", () => {
  const parseEther = (s: string) => BigInt(Math.floor(parseFloat(s) * 1e18));
  const formatEther = (w: bigint) => (Number(w) / 1e18).toString();
  return {
    parseEther,
    formatEther,
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getBalance: getBalanceMock,
    })),
  };
});

vi.mock("./_lib/signer.js", () => ({
  getSigner: getSignerMock,
}));

// Health endpoint dispatches to relayer-balance probe via ?kind=relayer
// (consolidated from former /api/relayer-health for Hobby 12-function cap).
import healthHandler from "./health.js";

const handler = (req: any, res: any) => {
  req.query = { ...(req.query ?? {}), kind: "relayer" };
  return healthHandler(req, res);
};

const RELAYER_ADDR = "0xRElaYErAddrEsS00000000000000000000000000";

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  return {
    captured,
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
  getBalanceMock.mockReset();
  getAddressMock.mockReset();
  getSignerMock.mockReset();
  getAddressMock.mockResolvedValue(RELAYER_ADDR);
  getSignerMock.mockReturnValue({ getAddress: getAddressMock });
});

describe("/api/relayer-health — status enum (§15.x)", () => {
  it("returns 'unconfigured' (still HTTP 200) when getSigner throws (no RELAYER_PRIVATE_KEY)", async () => {
    getSignerMock.mockImplementation(() => {
      throw new Error("RELAYER_PRIVATE_KEY not set");
    });
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("unconfigured");
    expect(res.captured.body?.chains).toEqual({});
  });

  it("returns 'ok' when all chain balances are above the 0.5 ETH threshold", async () => {
    // 1 ETH on every chain.
    getBalanceMock.mockResolvedValue(BigInt("1000000000000000000"));
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("ok");
  });

  it("returns 'low_funds' when ANY chain balance falls below threshold", async () => {
    // First chain (Sepolia): 0.1 ETH = below. Second (Base Sepolia): 1 ETH.
    getBalanceMock
      .mockResolvedValueOnce(BigInt("100000000000000000"))
      .mockResolvedValueOnce(BigInt("1000000000000000000"));
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("low_funds");
  });

  it("returns 'degraded' when a chain probe errors but no low-funds chain", async () => {
    // First chain succeeds (1 ETH), second chain RPC throws.
    getBalanceMock
      .mockResolvedValueOnce(BigInt("1000000000000000000"))
      .mockRejectedValueOnce(new Error("rpc 503"));
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.body?.status).toBe("degraded");
  });

  it("prefers 'low_funds' over 'degraded' when both conditions are present", async () => {
    // First chain: low funds. Second: error.
    getBalanceMock
      .mockResolvedValueOnce(BigInt("100000000000000000"))
      .mockRejectedValueOnce(new Error("rpc 503"));
    const res = makeRes();
    await handler({}, res);
    // Per source: `anyLowFunds ? "low_funds" : anyError ? "degraded" : "ok"`
    expect(res.captured.body?.status).toBe("low_funds");
  });
});

describe("/api/relayer-health — per-chain probe (§15.x)", () => {
  it("includes balanceWei + balanceEth + lowFunds for each chain on success", async () => {
    getBalanceMock.mockResolvedValue(BigInt("1500000000000000000"));
    const res = makeRes();
    await handler({}, res);
    const chains = res.captured.body?.chains as Record<string, Record<string, unknown>>;
    expect(chains["11155111"].balanceWei).toBe("1500000000000000000");
    expect(chains["11155111"].balanceEth).toBe("1.5");
    expect(chains["11155111"].lowFunds).toBe(false);
    expect(chains["11155111"].chainName).toBe("Ethereum Sepolia");
    expect(chains["84532"].chainName).toBe("Base Sepolia");
  });

  it("includes error field on failed chain probe (does not skip the chain entry)", async () => {
    getBalanceMock.mockRejectedValue(new Error("rpc dead"));
    const res = makeRes();
    await handler({}, res);
    const chains = res.captured.body?.chains as Record<string, Record<string, unknown>>;
    expect(chains["11155111"].error).toBe("rpc dead");
    expect(chains["84532"].error).toBe("rpc dead");
    // chainName still surfaced for ops debugging.
    expect(chains["11155111"].chainName).toBe("Ethereum Sepolia");
  });

  it("response includes relayer address + ISO timestamp", async () => {
    getBalanceMock.mockResolvedValue(BigInt("1000000000000000000"));
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.body?.relayer).toBe(RELAYER_ADDR);
    expect(typeof res.captured.body?.timestamp).toBe("string");
    // ISO 8601 shape (YYYY-MM-DDTHH:MM:SS...).
    expect((res.captured.body?.timestamp as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("/api/relayer-health — fault tolerance (§15.x)", () => {
  it("returns HTTP 200 'unconfigured' when getAddress() rejects (caught in inner try/catch)", async () => {
    // The inner try/catch wraps BOTH getSigner() AND signer.getAddress(),
    // so an address-resolution failure (e.g. KMS timeout) surfaces as
    // unconfigured rather than crashing the endpoint.
    getAddressMock.mockRejectedValue(new Error("kms timeout"));
    getSignerMock.mockReturnValue({ getAddress: getAddressMock });
    const res = makeRes();
    await handler({}, res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("unconfigured");
    expect((res.captured.body?.error as string)).toContain("kms timeout");
  });

});
