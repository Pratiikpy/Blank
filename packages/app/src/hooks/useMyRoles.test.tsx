import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useMyRoles. Pure roleKey() lives outside React state
// — exhaustively tested for stable identity. The aggregation path
// merges 5 parallel fetches into one role list; coverage focuses on
// the filter conditions that gate each role kind (e.g. arbiter only
// fires for status=active escrows).

const fetchActivitiesMock = vi.hoisted(() => vi.fn());
const fetchUserGroupsMock = vi.hoisted(() => vi.fn());
const fetchUserEscrowsMock = vi.hoisted(() => vi.fn());
const fetchIncomingRequestsMock = vi.hoisted(() => vi.fn());
const fetchClientInvoicesMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  fetchActivities: fetchActivitiesMock,
  fetchUserGroups: fetchUserGroupsMock,
  fetchUserEscrows: fetchUserEscrowsMock,
  fetchIncomingRequests: fetchIncomingRequestsMock,
  fetchClientInvoices: fetchClientInvoicesMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/providers/RealtimeProvider", () => ({
  useRealtime: () => ({
    subscribe: () => () => {},
  }),
}));

import { useMyRoles, roleKey, type MyRole } from "./useMyRoles";
import { ACTIVITY_TYPES } from "@/lib/activity-types";

const ME = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbBBbBBBbBBBBBbbBbBBBBBbbbBBBBBBBBBbbBbB";
const BOB = "0xCccCCcCccCCCccccccccccCcCcCCcccCcccCCCcC";

beforeEach(() => {
  localStorage.clear();
  fetchActivitiesMock.mockReset();
  fetchUserGroupsMock.mockReset();
  fetchUserEscrowsMock.mockReset();
  fetchIncomingRequestsMock.mockReset();
  fetchClientInvoicesMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  fetchActivitiesMock.mockResolvedValue([]);
  fetchUserGroupsMock.mockResolvedValue([]);
  fetchUserEscrowsMock.mockResolvedValue([]);
  fetchIncomingRequestsMock.mockResolvedValue([]);
  fetchClientInvoicesMock.mockResolvedValue([]);
});

describe("roleKey (pure)", () => {
  it("uses stable per-kind prefixes for collision resistance", () => {
    const arb: MyRole = { kind: "arbiter", escrowId: 1, depositor: ALICE, description: "x", createdAt: "" };
    const ben: MyRole = { kind: "escrow_beneficiary", escrowId: 1, depositor: ALICE, description: "x", createdAt: "" };
    // Same escrowId but different roles must produce different keys.
    expect(roleKey(arb)).not.toBe(roleKey(ben));
    expect(roleKey(arb).startsWith("arb:")).toBe(true);
    expect(roleKey(ben).startsWith("ben:")).toBe(true);
  });

  it("lowercases the heir principal for case-insensitive identity", () => {
    const upper: MyRole = { kind: "heir", principal: ALICE.toUpperCase(), createdAt: "" };
    const lower: MyRole = { kind: "heir", principal: ALICE.toLowerCase(), createdAt: "" };
    expect(roleKey(upper)).toBe(roleKey(lower));
  });

  it("encodes group_member / invoice_pending / request_pending by id", () => {
    expect(roleKey({ kind: "group_member", groupId: 7, groupName: "g", createdAt: "" })).toBe("grp:7");
    expect(roleKey({ kind: "invoice_pending", invoiceId: 5, vendor: ALICE, description: "x", createdAt: "" })).toBe("inv:5");
    expect(roleKey({ kind: "request_pending", requestId: 3, requester: ALICE, note: "x", createdAt: "" })).toBe("req:3");
  });
});

describe("useMyRoles — empty + loading (§15.x)", () => {
  it("returns no roles + zero unread when address is null", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.roles).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
    expect(fetchActivitiesMock).not.toHaveBeenCalled();
  });
});

describe("useMyRoles — aggregation (§15.x)", () => {
  it("surfaces heir designations only from INHERITANCE_HEIR_SET activities targeting me", async () => {
    fetchActivitiesMock.mockResolvedValue([
      // Targeting me, correct type → kept.
      { activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_SET, user_from: ALICE, user_to: ME, created_at: "2026-05-10T00:00:00Z" },
      // Wrong target (not me) → dropped.
      { activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_SET, user_from: ALICE, user_to: BOB, created_at: "2026-05-10T00:00:00Z" },
      // Wrong type → dropped.
      { activity_type: "payment", user_from: ALICE, user_to: ME, created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(1));
    expect(result.current.roles[0].kind).toBe("heir");
    if (result.current.roles[0].kind === "heir") {
      expect(result.current.roles[0].principal).toBe(ALICE);
    }
  });

  it("only surfaces arbiter assignments on ACTIVE escrows", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      { escrow_id: 1, arbiter_address: ME, depositor_address: ALICE, description: "active escrow", status: "active", created_at: "2026-05-10T00:00:00Z" },
      { escrow_id: 2, arbiter_address: ME, depositor_address: ALICE, description: "settled escrow", status: "released", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(1));
    expect(result.current.roles[0].kind).toBe("arbiter");
    if (result.current.roles[0].kind === "arbiter") {
      expect(result.current.roles[0].escrowId).toBe(1);
    }
  });

  it("matches arbiter address case-insensitively", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      { escrow_id: 1, arbiter_address: ME.toUpperCase(), depositor_address: ALICE, description: "x", status: "active", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(1));
    expect(result.current.roles[0].kind).toBe("arbiter");
  });

  it("sorts the merged list newest-first across kinds", async () => {
    fetchActivitiesMock.mockResolvedValue([
      { activity_type: ACTIVITY_TYPES.INHERITANCE_HEIR_SET, user_from: ALICE, user_to: ME, created_at: "2026-01-01T00:00:00Z" },
    ]);
    fetchUserGroupsMock.mockResolvedValue([
      { group_id: 1, group_name: "g", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(2));
    // Group is newer than heir → group comes first.
    expect(result.current.roles[0].kind).toBe("group_member");
    expect(result.current.roles[1].kind).toBe("heir");
  });

  it("surfaces pending invoices but skips ones with non-pending status", async () => {
    fetchClientInvoicesMock.mockResolvedValue([
      { invoice_id: 1, vendor_address: ALICE, description: "pending", status: "pending", created_at: "2026-05-10T00:00:00Z" },
      { invoice_id: 2, vendor_address: ALICE, description: "paid", status: "paid", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(1));
    expect(result.current.roles[0].kind).toBe("invoice_pending");
    if (result.current.roles[0].kind === "invoice_pending") {
      expect(result.current.roles[0].invoiceId).toBe(1);
    }
  });

  it("surfaces escrow_beneficiary roles on active escrows", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      { escrow_id: 1, beneficiary_address: ME, depositor_address: ALICE, description: "x", status: "active", created_at: "2026-05-10T00:00:00Z" },
      // Released → dropped.
      { escrow_id: 2, beneficiary_address: ME, depositor_address: ALICE, description: "x", status: "released", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(1));
    expect(result.current.roles[0].kind).toBe("escrow_beneficiary");
  });
});

describe("useMyRoles — unread + markSeen (§15.x)", () => {
  it("unreadCount equals roles.length when nothing has been seen", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      { group_id: 1, group_name: "g1", created_at: "2026-05-10T00:00:00Z" },
      { group_id: 2, group_name: "g2", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.roles.length).toBe(2));
    expect(result.current.unreadCount).toBe(2);
  });

  it("markAllSeen drops unreadCount to 0", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      { group_id: 1, group_name: "g1", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    act(() => { result.current.markAllSeen(); });
    expect(result.current.unreadCount).toBe(0);
  });

  it("markSeen on one role decrements unreadCount but leaves others", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      { group_id: 1, group_name: "g1", created_at: "2026-05-10T00:00:00Z" },
      { group_id: 2, group_name: "g2", created_at: "2026-05-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useMyRoles());
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    act(() => { result.current.markSeen(result.current.roles[0]); });
    expect(result.current.unreadCount).toBe(1);
  });
});
