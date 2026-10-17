import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ProofOfBalance is retired: the hook is read-only. Pins that no write path
// survives and that an empty record reads as "not found".

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/abis", () => ({ ProofOfBalanceAbi: [] }));

import { useProofOfBalance } from "./useProofOfBalance";

const POB = "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856";
const PROVER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const readContract = vi.fn();

beforeEach(() => {
  readContract.mockReset();
  usePublicClientMock.mockReturnValue({ readContract });
  useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: { ProofOfBalance: POB } });
});

describe("useProofOfBalance (retired, read-only)", () => {
  it("exposes only deployed + fetchProof", () => {
    const { result } = renderHook(() => useProofOfBalance());
    expect(Object.keys(result.current).sort()).toEqual(["deployed", "fetchProof"]);
    expect(result.current.deployed).toBe(true);
  });

  it("fetchProof maps getProof", async () => {
    readContract.mockResolvedValue([PROVER, 5_000_000n, 1_700_000_000n, true, false]);
    const { result } = renderHook(() => useProofOfBalance());
    let r: unknown;
    await act(async () => {
      r = await result.current.fetchProof(4n);
    });
    expect(readContract.mock.calls[0][0]).toMatchObject({ address: POB, functionName: "getProof", args: [4n] });
    expect(r).toEqual({ id: 4n, prover: PROVER, thresholdMicroUSD: 5_000_000n, createdAt: 1_700_000_000n, revealed: true, revealedValue: false });
  });

  it("empty record or read failure -> null", async () => {
    readContract.mockResolvedValueOnce([ZERO, 0n, 0n, false, false]).mockRejectedValueOnce(new Error("rpc"));
    const { result } = renderHook(() => useProofOfBalance());
    let a: unknown = 1;
    let b: unknown = 1;
    await act(async () => {
      a = await result.current.fetchProof(1n);
      b = await result.current.fetchProof(2n);
    });
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("not deployed on this chain -> deployed false, no read", async () => {
    useChainMock.mockReturnValue({ activeChainId: 421614, contracts: { ProofOfBalance: ZERO } });
    const { result } = renderHook(() => useProofOfBalance());
    expect(result.current.deployed).toBe(false);
    await act(async () => {
      expect(await result.current.fetchProof(1n)).toBeNull();
    });
    expect(readContract).not.toHaveBeenCalled();
  });
});
