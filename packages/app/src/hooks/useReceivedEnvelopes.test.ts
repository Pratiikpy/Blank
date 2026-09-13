import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// §15.x test for useReceivedEnvelopes. The receive half of gift envelopes,
// read straight from GiftMoney instead of from the indexer.
//
// CRITICAL pins:
//   - The whole point of this hook: the Gifts screen built its Received list
//     from the activity feed alone, so an indexer that was behind or down left
//     a funded, claimable envelope invisible AND unclaimable. Rows come back
//     shaped like ActivityRow so the screen merges them into the same list.
//   - Notes are re-prefixed with `[envelope:N]`. The on-chain note has no
//     prefix (useGiftMoney adds it only when writing the activity row), and
//     the screen's parseEnvelopeId regex is what turns a row into a Claim
//     button. Drop the prefix and the row renders with no way to claim it.
//   - Smart account AND EOA are both queried: a sender may have addressed
//     either. An envelope listed under both must appear once, attributed to
//     the first address that saw it, so the claim is signed by that identity.
//   - Zero / missing GiftMoney address and a missing public client short
//     circuit to [] — chains where the hub is not deployed must not throw.
//   - A failing read is logged and swallowed. The indexer-backed list is
//     still rendering; a dead RPC must not blank the screen.
//   - Identical poll results do not produce a new array. The screen derives
//     memoized lists from these rows, and a fresh array every 30s would
//     re-run the whole envelope-expiry fetch effect forever.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/abis", () => ({ GiftMoneyAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: logWarnMock, debug: vi.fn() } }));

import { useReceivedEnvelopes } from "./useReceivedEnvelopes";

const CHAIN_ID = 84532;
const GIFT_MONEY = "0x37374487A6575780A6DE3C83440441C7aB03cDDf";
const ZERO = "0x0000000000000000000000000000000000000000";
const SMART = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALICE = "0xcccccccccccccccccccccccccccccccccccccccc";
const VAULT = "0xdddddddddddddddddddddddddddddddddddddddd";

/** getEnvelope() tuple in declaration order. */
function envelope(over: Partial<{ sender: string; note: string; timestamp: bigint }> = {}) {
  return [
    over.sender ?? ALICE,
    VAULT,
    2n,
    0n,
    over.note ?? "Coffee on me",
    over.timestamp ?? 1_700_000_000n,
    true,
    0n,
  ] as const;
}

let readContractMock: ReturnType<typeof vi.fn>;

/**
 * Route reads by function name so a test only has to describe the data, not
 * the call order.
 */
function withChainData(received: Record<string, bigint[]>, envelopes: Record<string, unknown>) {
  readContractMock = vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
    if (functionName === "getReceivedEnvelopes") {
      return received[String(args[0]).toLowerCase()] ?? [];
    }
    if (functionName === "getEnvelope") {
      const found = envelopes[String(args[0])];
      if (!found) throw new Error("unknown envelope");
      return found;
    }
    throw new Error(`unexpected read ${functionName}`);
  });
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });
}

beforeEach(() => {
  usePublicClientMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  logWarnMock.mockReset();
  useChainMock.mockReturnValue({
    activeChainId: CHAIN_ID,
    contracts: { GiftMoney: GIFT_MONEY },
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART, eoa: EOA });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useReceivedEnvelopes — chain read (§15.x)", () => {
  it("CRITICAL turns on-chain envelopes into rows the Gifts screen can claim", async () => {
    withChainData({ [SMART.toLowerCase()]: [7n], [EOA.toLowerCase()]: [] }, { "7": envelope() });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    const row = result.current.rows[0];
    // The `[envelope:N]` prefix is what the screen parses to render Claim.
    expect(row.note).toBe("[envelope:7] Coffee on me");
    expect(row.user_from).toBe(ALICE.toLowerCase());
    expect(row.user_to).toBe(SMART.toLowerCase());
    expect(row.activity_type).toBe("gift_created");
    expect(row.chain_id).toBe(CHAIN_ID);
    expect(row.created_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("falls back to a placeholder note when the sender left it empty", async () => {
    withChainData({ [SMART.toLowerCase()]: [1n], [EOA.toLowerCase()]: [] }, { "1": envelope({ note: "" }) });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].note).toBe("[envelope:1] Gift envelope");
  });

  it("CRITICAL queries the smart account AND the EOA, listing a shared envelope once", async () => {
    withChainData(
      { [SMART.toLowerCase()]: [4n], [EOA.toLowerCase()]: [4n, 5n] },
      { "4": envelope({ note: "both" }), "5": envelope({ note: "eoa only" }) },
    );
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    const ids = result.current.rows.map((r) => r.note);
    expect(ids).toContain("[envelope:4] both");
    expect(ids).toContain("[envelope:5] eoa only");
    // #4 is addressed to both identities; the claim must be signed by the one
    // that saw it first, not by whichever read resolved last.
    const shared = result.current.rows.find((r) => r.note.startsWith("[envelope:4]"));
    expect(shared?.user_to).toBe(SMART.toLowerCase());
  });

  it("skips envelopes whose detail read fails rather than dropping the batch", async () => {
    withChainData(
      { [SMART.toLowerCase()]: [1n, 2n], [EOA.toLowerCase()]: [] },
      { "2": envelope({ note: "survivor" }) }, // 1 is missing -> getEnvelope throws
    );
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].note).toBe("[envelope:2] survivor");
  });

  it("CRITICAL an unchanged poll result keeps the same array identity", async () => {
    withChainData({ [SMART.toLowerCase()]: [7n], [EOA.toLowerCase()]: [] }, { "7": envelope() });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    const first = result.current.rows;

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(readContractMock.mock.calls.length).toBeGreaterThan(3));
    expect(result.current.rows).toBe(first);
  });
});

describe("useReceivedEnvelopes — defensive gates (§15.x)", () => {
  it("CRITICAL no public client -> no reads, empty rows", async () => {
    usePublicClientMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toEqual([]));
  });

  it("CRITICAL GiftMoney not deployed on this chain -> no reads", async () => {
    withChainData({}, {});
    useChainMock.mockReturnValue({
      activeChainId: CHAIN_ID,
      contracts: { GiftMoney: ZERO },
    });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("no address yet -> no reads", async () => {
    withChainData({}, {});
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined, eoa: undefined });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("a user with no envelopes reads clean and stays empty", async () => {
    withChainData({ [SMART.toLowerCase()]: [], [EOA.toLowerCase()]: [] }, {});
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(readContractMock).toHaveBeenCalled());
    expect(result.current.rows).toEqual([]);
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("CRITICAL a dead RPC warns and leaves the indexer-backed list alone", async () => {
    // Every address read failing means the RPC is down. Returning an empty
    // list quietly would render "no gifts received yet" over a wallet that
    // has some, which is exactly the lie this hook exists to stop telling.
    readContractMock = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(logWarnMock).toHaveBeenCalled());
    expect(logWarnMock.mock.calls[0][0]).toBe("useReceivedEnvelopes.readFailed");
    expect(result.current.rows).toEqual([]);
  });

  it("one address failing does not hide the other address's envelopes", async () => {
    readContractMock = vi.fn(
      async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === "getReceivedEnvelopes") {
          if (String(args[0]).toLowerCase() === SMART.toLowerCase()) throw new Error("HTTP 429");
          return [8n];
        }
        return envelope({ note: "reachable" });
      },
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { result } = renderHook(() => useReceivedEnvelopes());
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.rows[0].note).toBe("[envelope:8] reachable");
    expect(result.current.rows[0].user_to).toBe(EOA.toLowerCase());
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});
