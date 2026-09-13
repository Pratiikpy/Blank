import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// §15.x test for useOnChainRequests. Incoming payment requests read from
// PaymentHub so the payer can act on one before the indexer has a row for it.
//
// CRITICAL pins:
//   - RequestStatus { Pending, Fulfilled, Cancelled } is positional. Only
//     pending requests are returned: the incoming tab is an action list, and
//     surfacing a fulfilled request there invites a double payment.
//   - from_address is the PAYER and to_address the REQUESTER, matching the
//     Supabase column meaning. Swapping them would show the wrong
//     counterparty name on every row and pay the wrong person.
//   - Every address read failing warns rather than rendering an empty inbox
//     as if nobody had asked for money.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/abis", () => ({ PaymentHubAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: logWarnMock, debug: vi.fn() } }));

import { useOnChainRequests } from "./useOnChainRequests";

const CHAIN_ID = 84532;
const HUB = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const SMART = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REQUESTER = "0xcccccccccccccccccccccccccccccccccccccccc";
const VAULT = "0xdddddddddddddddddddddddddddddddddddddddd";

function request(over: Partial<{ note: string; status: number; createdAt: bigint }> = {}) {
  return [
    SMART, // from: the payer
    REQUESTER, // to: who gets paid
    VAULT,
    0n,
    over.note ?? "Dinner",
    over.status ?? 0,
    over.createdAt ?? 1_700_000_000n,
  ] as const;
}

let readContractMock: ReturnType<typeof vi.fn>;

function withChain(byAddress: Record<string, bigint[]>, byId: Record<string, unknown>) {
  readContractMock = vi.fn(
    async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === "getIncomingRequests") {
        return byAddress[String(args[0]).toLowerCase()] ?? [];
      }
      if (functionName === "getRequest") {
        const found = byId[String(args[0])];
        if (!found) throw new Error("unknown request");
        return found;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  );
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });
}

beforeEach(() => {
  usePublicClientMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  logWarnMock.mockReset();
  useChainMock.mockReturnValue({
    activeChainId: CHAIN_ID,
    contracts: { PaymentHub: HUB },
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART, eoa: EOA });
});

describe("useOnChainRequests (§15.x)", () => {
  it("CRITICAL a pending request is actionable without the indexer", async () => {
    withChain({ [SMART.toLowerCase()]: [4n] }, { "4": request() });
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(result.current.incoming).toHaveLength(1));

    const row = result.current.incoming[0];
    expect(row.request_id).toBe(4);
    expect(row.from_address).toBe(SMART.toLowerCase()); // payer
    expect(row.to_address).toBe(REQUESTER.toLowerCase()); // requester
    expect(row.note).toBe("Dinner");
    expect(row.status).toBe("pending");
    expect(row.created_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("CRITICAL fulfilled and cancelled requests are not offered for payment", async () => {
    withChain(
      { [SMART.toLowerCase()]: [1n, 2n, 3n] },
      {
        "1": request({ note: "still owed", status: 0 }),
        "2": request({ note: "already paid", status: 1 }),
        "3": request({ note: "called off", status: 2 }),
      },
    );
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(result.current.incoming).toHaveLength(1));
    expect(result.current.incoming[0].note).toBe("still owed");
  });

  it("reads both the smart account and the EOA", async () => {
    withChain(
      { [SMART.toLowerCase()]: [1n], [EOA.toLowerCase()]: [5n] },
      { "1": request(), "5": request({ note: "to the EOA" }) },
    );
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(result.current.incoming).toHaveLength(2));
    expect(result.current.incoming.map((r) => r.note)).toContain("to the EOA");
  });

  it("CRITICAL no PaymentHub on this chain -> no reads", async () => {
    withChain({}, {});
    useChainMock.mockReturnValue({
      activeChainId: CHAIN_ID,
      contracts: { PaymentHub: ZERO },
    });
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(result.current.incoming).toEqual([]));
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("CRITICAL a dead RPC warns instead of showing an empty inbox as fact", async () => {
    readContractMock = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(logWarnMock).toHaveBeenCalled());
    expect(logWarnMock.mock.calls[0][0]).toBe("useOnChainRequests.readFailed");
    expect(result.current.incoming).toEqual([]);
  });

  it("an unchanged refresh keeps the same array identity", async () => {
    withChain({ [SMART.toLowerCase()]: [1n] }, { "1": request() });
    const { result } = renderHook(() => useOnChainRequests());
    await waitFor(() => expect(result.current.incoming).toHaveLength(1));
    const first = result.current.incoming;
    const before = readContractMock.mock.calls.length;
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(readContractMock.mock.calls.length).toBeGreaterThan(before));
    expect(result.current.incoming).toBe(first);
  });
});
