import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// §15.x test for useOnChainBusinessRecords. Invoices and escrows read straight
// from BusinessHub, so acting on them does not depend on the indexer.
//
// CRITICAL pins:
//   - Why it exists: BusinessTools loaded both lists from Supabase only. A
//     client named on a real on-chain invoice saw "No invoices yet" and had no
//     Pay button whenever the indexer was behind or unreachable. Same for a
//     beneficiary who could not find an escrow to mark delivered.
//   - Status enums are positional and must track the contract exactly:
//     InvoiceStatus { Pending, Paid, Cancelled, PaymentPending, Disputed } and
//     EscrowStatus { Active, Released, Disputed, Expired }. An off-by-one here
//     shows a paid invoice as still payable.
//   - Client AND vendor invoice lists are both read and unioned. A user is
//     usually one or the other, but the same wallet can be both, and reading
//     only one side hides half their invoices.
//   - Smart account AND EOA are queried; an id seen under both is listed once.
//   - created_at is left empty, not epoch. The chain does not return the
//     struct's createdAt, and the screen prints "No date" for an empty string
//     rather than dating every chain-sourced invoice to 1 Jan 1970.
//   - Every address read failing is an RPC failure, not "no records": it warns
//     rather than silently rendering an empty list over a wallet that has some.

const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/abis", () => ({ BusinessHubAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: logWarnMock, debug: vi.fn() } }));

import { useOnChainBusinessRecords } from "./useOnChainBusinessRecords";

const CHAIN_ID = 84532;
const HUB = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const SMART = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VENDOR = "0xcccccccccccccccccccccccccccccccccccccccc";
const VAULT = "0xdddddddddddddddddddddddddddddddddddddddd";
const ARBITER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function invoice(over: Partial<{ client: string; description: string; due: bigint; status: number }> = {}) {
  return [
    VENDOR,
    over.client ?? SMART,
    VAULT,
    0n,
    over.description ?? "Design work",
    over.due ?? 1_800_000_000n,
    over.status ?? 0,
  ] as const;
}

function escrow(over: Partial<{ description: string; deadline: bigint; status: number }> = {}) {
  return [
    VENDOR,
    SMART,
    ARBITER,
    VAULT,
    0n,
    over.description ?? "Milestone 1",
    over.deadline ?? 1_800_000_000n,
    over.status ?? 0,
  ] as const;
}

type Chain = {
  client?: Record<string, bigint[]>;
  vendor?: Record<string, bigint[]>;
  escrows?: Record<string, bigint[]>;
  invoiceById?: Record<string, unknown>;
  escrowById?: Record<string, unknown>;
};

let readContractMock: ReturnType<typeof vi.fn>;

function withChain(data: Chain) {
  readContractMock = vi.fn(
    async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      const key = String(args[0]).toLowerCase();
      switch (functionName) {
        case "getClientInvoices":
          return data.client?.[key] ?? [];
        case "getVendorInvoices":
          return data.vendor?.[key] ?? [];
        case "getUserEscrows":
          return data.escrows?.[key] ?? [];
        case "getInvoice": {
          const found = data.invoiceById?.[String(args[0])];
          if (!found) throw new Error("unknown invoice");
          return found;
        }
        case "getEscrow": {
          const found = data.escrowById?.[String(args[0])];
          if (!found) throw new Error("unknown escrow");
          return found;
        }
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
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
    contracts: { BusinessHub: HUB },
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART, eoa: EOA });
});

describe("useOnChainBusinessRecords — invoices (§15.x)", () => {
  it("CRITICAL an invoice naming this client is returned with no indexer involved", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [12n] },
      invoiceById: { "12": invoice() },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));

    const row = result.current.invoices[0];
    expect(row.invoice_id).toBe(12);
    expect(row.vendor_address).toBe(VENDOR.toLowerCase());
    expect(row.client_address).toBe(SMART.toLowerCase());
    expect(row.description).toBe("Design work");
    expect(row.status).toBe("pending");
    expect(row.chain_id).toBe(CHAIN_ID);
    expect(row.due_date).toBe(new Date(1_800_000_000_000).toISOString());
    // The chain has no createdAt on this view; "" renders as "No date".
    expect(row.created_at).toBe("");
  });

  it("CRITICAL status enum tracks the contract positionally", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [0n, 1n, 2n, 3n, 4n] },
      invoiceById: {
        "0": invoice({ status: 0 }),
        "1": invoice({ status: 1 }),
        "2": invoice({ status: 2 }),
        "3": invoice({ status: 3 }),
        "4": invoice({ status: 4 }),
      },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(5));
    const byId = Object.fromEntries(result.current.invoices.map((i) => [i.invoice_id, i.status]));
    expect(byId).toEqual({
      0: "pending",
      1: "paid",
      2: "cancelled",
      3: "payment_pending",
      4: "disputed",
    });
  });

  it("unions the client and vendor lists without duplicating a shared id", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [1n] },
      vendor: { [SMART.toLowerCase()]: [1n, 2n] },
      invoiceById: { "1": invoice(), "2": invoice({ description: "Second" }) },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(2));
    expect(result.current.invoices.map((i) => i.invoice_id).sort()).toEqual([1, 2]);
  });

  it("reads both the smart account and the EOA", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [1n], [EOA.toLowerCase()]: [9n] },
      invoiceById: { "1": invoice(), "9": invoice({ description: "To the EOA" }) },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(2));
    expect(result.current.invoices.map((i) => i.description)).toContain("To the EOA");
  });

  it("newest id first", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [3n, 11n, 7n] },
      invoiceById: { "3": invoice(), "11": invoice(), "7": invoice() },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(3));
    expect(result.current.invoices.map((i) => i.invoice_id)).toEqual([11, 7, 3]);
  });

  it("a due date of 0 becomes null rather than 1 Jan 1970", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [1n] },
      invoiceById: { "1": invoice({ due: 0n }) },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));
    expect(result.current.invoices[0].due_date).toBeNull();
  });
});

describe("useOnChainBusinessRecords — escrows (§15.x)", () => {
  it("CRITICAL escrow status enum tracks the contract positionally", async () => {
    withChain({
      escrows: { [SMART.toLowerCase()]: [0n, 1n, 2n, 3n] },
      escrowById: {
        "0": escrow({ status: 0 }),
        "1": escrow({ status: 1 }),
        "2": escrow({ status: 2 }),
        "3": escrow({ status: 3 }),
      },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.escrows).toHaveLength(4));
    const byId = Object.fromEntries(result.current.escrows.map((e) => [e.escrow_id, e.status]));
    expect(byId).toEqual({ 0: "active", 1: "released", 2: "disputed", 3: "expired" });
  });

  it("carries depositor, beneficiary and arbiter so role filters still work", async () => {
    withChain({
      escrows: { [SMART.toLowerCase()]: [5n] },
      escrowById: { "5": escrow() },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.escrows).toHaveLength(1));
    const row = result.current.escrows[0];
    expect(row.depositor_address).toBe(VENDOR.toLowerCase());
    expect(row.beneficiary_address).toBe(SMART.toLowerCase());
    expect(row.arbiter_address).toBe(ARBITER.toLowerCase());
    expect(row.description).toBe("Milestone 1");
  });
});

describe("useOnChainBusinessRecords — defensive gates (§15.x)", () => {
  it("CRITICAL no public client -> no reads", async () => {
    usePublicClientMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toEqual([]));
    expect(result.current.escrows).toEqual([]);
  });

  it("CRITICAL BusinessHub not deployed on this chain -> no reads", async () => {
    withChain({});
    useChainMock.mockReturnValue({
      activeChainId: CHAIN_ID,
      contracts: { BusinessHub: ZERO },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toEqual([]));
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("CRITICAL a dead RPC warns instead of showing an empty list as fact", async () => {
    readContractMock = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(logWarnMock).toHaveBeenCalled());
    expect(logWarnMock.mock.calls[0][0]).toBe("useOnChainBusinessRecords.readFailed");
    expect(result.current.invoices).toEqual([]);
  });

  it("a detail read that fails drops only that record", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [1n, 2n] },
      invoiceById: { "2": invoice({ description: "survivor" }) },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));
    expect(result.current.invoices[0].description).toBe("survivor");
  });

  it("CRITICAL an unchanged refresh keeps the same array identity", async () => {
    withChain({
      client: { [SMART.toLowerCase()]: [1n] },
      invoiceById: { "1": invoice() },
    });
    const { result } = renderHook(() => useOnChainBusinessRecords());
    await waitFor(() => expect(result.current.invoices).toHaveLength(1));
    const first = result.current.invoices;
    const callsBefore = readContractMock.mock.calls.length;

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(readContractMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(result.current.invoices).toBe(first);
  });
});
