import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// §15.x test for useOnChainGroups. Group membership read from GroupManager so
// a member who was just added can open the group and settle without waiting on
// the indexer to write their row.
//
// CRITICAL pins:
//   - Archived groups (active === false) are dropped. A member should not be
//     offered a settle button for a group the admin closed.
//   - is_admin is always false on a chain-sourced row. Admin is an
//     indexer-side concept; inferring it here would hand out leave/archive
//     controls the contract will reject.
//   - member_address is the identity the membership was found under (smart
//     account or EOA), because settleDebt has to be signed by that address.
//   - Every address read failing warns instead of quietly rendering "no
//     groups" over a wallet that is in several.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/abis", () => ({ GroupManagerAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: logWarnMock, debug: vi.fn() } }));

import { useOnChainGroups } from "./useOnChainGroups";

const CHAIN_ID = 84532;
const MANAGER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const SMART = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";

function group(over: Partial<{ name: string; active: boolean }> = {}) {
  return [over.name ?? "Flatmates", [SMART, OTHER], 2n, over.active ?? true] as const;
}

let readContractMock: ReturnType<typeof vi.fn>;

function withChain(byAddress: Record<string, bigint[]>, byId: Record<string, unknown>) {
  readContractMock = vi.fn(
    async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === "getUserGroups") {
        return byAddress[String(args[0]).toLowerCase()] ?? [];
      }
      if (functionName === "getGroup") {
        const found = byId[String(args[0])];
        if (!found) throw new Error("unknown group");
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
    contracts: { GroupManager: MANAGER },
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART, eoa: EOA });
});

describe("useOnChainGroups (§15.x)", () => {
  it("CRITICAL a membership on chain is enough to open the group", async () => {
    withChain({ [SMART.toLowerCase()]: [3n] }, { "3": group() });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));

    const row = result.current.groups[0];
    expect(row.group_id).toBe(3);
    expect(row.group_name).toBe("Flatmates");
    expect(row.member_address).toBe(SMART.toLowerCase());
    expect(row.chain_id).toBe(CHAIN_ID);
  });

  it("CRITICAL archived groups are dropped", async () => {
    withChain(
      { [SMART.toLowerCase()]: [1n, 2n] },
      { "1": group({ name: "Live", active: true }), "2": group({ name: "Closed", active: false }) },
    );
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0].group_name).toBe("Live");
  });

  it("CRITICAL never claims admin from the chain", async () => {
    withChain({ [SMART.toLowerCase()]: [1n] }, { "1": group() });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0].is_admin).toBe(false);
  });

  it("attributes a group to the identity it was found under", async () => {
    withChain({ [SMART.toLowerCase()]: [], [EOA.toLowerCase()]: [7n] }, { "7": group() });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0].member_address).toBe(EOA.toLowerCase());
  });

  it("names an unnamed group by its id rather than showing a blank row", async () => {
    withChain({ [SMART.toLowerCase()]: [12n] }, { "12": group({ name: "" }) });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0].group_name).toBe("Group #12");
  });

  it("CRITICAL no GroupManager on this chain -> no reads", async () => {
    withChain({}, {});
    useChainMock.mockReturnValue({
      activeChainId: CHAIN_ID,
      contracts: { GroupManager: ZERO },
    });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toEqual([]));
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("CRITICAL a dead RPC warns instead of showing an empty list as fact", async () => {
    readContractMock = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(logWarnMock).toHaveBeenCalled());
    expect(logWarnMock.mock.calls[0][0]).toBe("useOnChainGroups.readFailed");
    expect(result.current.groups).toEqual([]);
  });

  it("an unchanged refresh keeps the same array identity", async () => {
    withChain({ [SMART.toLowerCase()]: [1n] }, { "1": group() });
    const { result } = renderHook(() => useOnChainGroups());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    const first = result.current.groups;
    const before = readContractMock.mock.calls.length;
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(readContractMock.mock.calls.length).toBeGreaterThan(before));
    expect(result.current.groups).toBe(first);
  });
});
