import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
vi.mock("./useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));

import { useReclaimProof } from "./useReclaimProof";

const TAKER = "0x00000000000000000000000000000000000000bb" as const;
const OFFRAMP = "0x5981C437032Da38844AE9a3aa382F993b1B8444a" as const;
const SIG = ("0x" + "12".repeat(65)) as `0x${string}`;

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: TAKER });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: object) {
  return { ok: true, status: 200, json: async () => body };
}

describe("useReclaimProof (mock mode)", () => {
  it("sends only { chainId, offramp, fillId } so the server signs on-chain values", async () => {
    fetchMock.mockResolvedValue(ok({ signature: SIG, signer: "0x1", providerId: 4, taker: TAKER }));
    const { result } = renderHook(() => useReclaimProof("mock"));
    let proof: string | null = null;
    await act(async () => {
      proof = (await result.current.requestProof({ chainId: 11155111, offramp: OFFRAMP, fillId: 7n, providerId: 4 })).proof;
    });
    expect(proof).toBe(SIG);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual({ kind: "mock-reclaim-sign", chainId: 11155111, offramp: OFFRAMP, fillId: "7" });
    expect(result.current.state).toBe("ready");
  });

  it("server reports a different rail -> error, proof not returned", async () => {
    fetchMock.mockResolvedValue(ok({ signature: SIG, signer: "0x1", providerId: 1, taker: TAKER }));
    const { result } = renderHook(() => useReclaimProof("mock"));
    await act(async () => {
      await expect(
        result.current.requestProof({ chainId: 11155111, offramp: OFFRAMP, fillId: 7n, providerId: 4 }),
      ).rejects.toThrow(/rail/);
    });
    expect(result.current.state).toBe("error");
  });

  it("fill locked by another account -> error before submitting", async () => {
    fetchMock.mockResolvedValue(ok({ signature: SIG, signer: "0x1", providerId: 4, taker: "0x00000000000000000000000000000000000000cc" }));
    const { result } = renderHook(() => useReclaimProof("mock"));
    await act(async () => {
      await expect(
        result.current.requestProof({ chainId: 11155111, offramp: OFFRAMP, fillId: 7n, providerId: 4 }),
      ).rejects.toThrow(/Only the taker/);
    });
  });

  it("server error message surfaces", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "Fill #7 is not awaiting a payment proof." }) });
    const { result } = renderHook(() => useReclaimProof("mock"));
    await act(async () => {
      await expect(
        result.current.requestProof({ chainId: 11155111, offramp: OFFRAMP, fillId: 7n, providerId: 4 }),
      ).rejects.toThrow(/not awaiting/);
    });
    expect(result.current.error).toMatch(/not awaiting/);
  });

  it("live mode is not wired -> honest error, no request", async () => {
    const { result } = renderHook(() => useReclaimProof("live"));
    await act(async () => {
      await expect(
        result.current.requestProof({ chainId: 11155111, offramp: OFFRAMP, fillId: 7n, providerId: 4 }),
      ).rejects.toThrow(/not wired/);
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
