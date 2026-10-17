import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeAbiParameters, keccak256, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The handler must sign only values it read from the chain, bound to the
// fill and taker, in the exact layout MockReclaimVerifier.attestationDigest
// uses. readContract is mocked per function name.

const readContractMock = vi.hoisted(() => vi.fn());
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: () => ({ readContract: readContractMock }) };
});

import { handleMockReclaimSign, isValidMockSignRequest, mockReclaimDigest } from "./mock-reclaim-sign";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OPERATOR = privateKeyToAccount(PK).address;
const OFFRAMP = "0x5981C437032Da38844AE9a3aa382F993b1B8444a" as const;
const ADAPTER = "0xf866EA7630eE91cCcd0Df638679865BCD909cce6" as const;
const VERIFIER = "0xdfc2606B1Ba148CC35b93849ac888BD7DfFD28a8" as const;
const TAKER = "0x00000000000000000000000000000000000000bb" as const;
const HANDLE = ("0x" + "ab".repeat(32)) as Hex;
const CHAIN = 11155111;

function res() {
  const out: { code?: number; body?: Record<string, unknown> } = {};
  return {
    out,
    status(code: number) {
      out.code = code;
      return { json: (b: object) => { out.body = b as Record<string, unknown>; } };
    },
  };
}

function chainState(over: Partial<{ state: number; operator: string; next: bigint; digestOverride: Hex }> = {}) {
  readContractMock.mockImplementation(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    switch (functionName) {
      case "nextFillId": return over.next ?? 10n;
      case "getFill": return [3n, TAKER, 2_500_000n, 1, 0, ("0x" + "00".repeat(32)), over.state ?? 0];
      case "getOffer": return ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000cc", 2_500_000n, 1_000_000n, 4, HANDLE, 0, 2];
      case "reclaimAdapter": return ADAPTER;
      case "verifier": return VERIFIER;
      case "operator": return over.operator ?? OPERATOR;
      case "attestationDigest": {
        if (over.digestOverride) return over.digestOverride;
        const [offramp, fillId, taker, providerId, receiver, amount] = args as [Hex, bigint, Hex, number, Hex, bigint];
        return keccak256(encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "address" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint64" }],
          [BigInt(CHAIN), VERIFIER, offramp, fillId, taker, providerId, receiver, amount],
        ));
      }
      default: throw new Error(`unexpected ${functionName}`);
    }
  });
}

const body = { kind: "mock-reclaim-sign", chainId: CHAIN, offramp: OFFRAMP, fillId: "7" };

beforeEach(() => {
  readContractMock.mockReset();
  process.env.MOCK_RECLAIM_OPERATOR_PK = PK;
});
afterEach(() => {
  delete process.env.MOCK_RECLAIM_OPERATOR_PK;
});

describe("isValidMockSignRequest", () => {
  it("accepts the fill-bound shape", () => {
    expect(isValidMockSignRequest(body)).toBe(true);
  });
  it("rejects the old caller-chosen shape (providerId/receiver/amount)", () => {
    expect(isValidMockSignRequest({ kind: "mock-reclaim-sign", providerId: 4, receiverHandle: HANDLE, amountMicroUSD: "1" })).toBe(false);
  });
  it("rejects an unsupported chain, a bad address and a non-uint64 fill id", () => {
    expect(isValidMockSignRequest({ ...body, chainId: 1 })).toBe(false);
    expect(isValidMockSignRequest({ ...body, offramp: "0x123" })).toBe(false);
    expect(isValidMockSignRequest({ ...body, fillId: "-1" })).toBe(false);
    expect(isValidMockSignRequest({ ...body, fillId: (2n ** 64n).toString() })).toBe(false);
  });
});

describe("handleMockReclaimSign", () => {
  it("signs the on-chain fill: EIP-191 over the verifier digest, recovered to the operator", async () => {
    chainState();
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(200);
    expect(r.out.body?.providerId).toBe(4);
    expect(r.out.body?.taker).toBe(TAKER);
    const digest = mockReclaimDigest({
      chainId: CHAIN, verifier: VERIFIER, offramp: OFFRAMP, fillId: 7n, taker: TAKER,
      providerId: 4, receiverHandle: HANDLE, amountMicroUSD: 2_500_000n,
    });
    const signer = await recoverMessageAddress({ message: { raw: digest }, signature: r.out.body?.signature as Hex });
    expect(signer).toBe(OPERATOR);
  });

  it("fill not Locked -> 409, nothing signed", async () => {
    chainState({ state: 1 });
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(409);
    expect(r.out.body?.signature).toBeUndefined();
  });

  it("fill id beyond nextFillId -> 404", async () => {
    chainState({ next: 5n });
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(404);
  });

  it("server key is not the verifier operator -> 503", async () => {
    chainState({ operator: "0x0000000000000000000000000000000000000001" });
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(503);
  });

  it("on-chain digest differs (layout drift) -> 500, nothing signed", async () => {
    chainState({ digestOverride: ("0x" + "11".repeat(32)) as Hex });
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(500);
    expect(r.out.body?.signature).toBeUndefined();
  });

  it("missing operator key -> 503", async () => {
    delete process.env.MOCK_RECLAIM_OPERATOR_PK;
    const r = res();
    await handleMockReclaimSign(body, r);
    expect(r.out.code).toBe(503);
  });

  it("invalid body -> 400", async () => {
    const r = res();
    await handleMockReclaimSign({ kind: "mock-reclaim-sign" }, r);
    expect(r.out.code).toBe(400);
  });
});
