import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEncryptedAnalytics } from "./useEncryptedAnalytics";
import type { ActivityRow } from "@/lib/supabase";

// Wave 5 Block 4 — useEncryptedAnalytics unit tests.
//
// Locks the aggregation logic against drift. Mocks the underlying
// activity feed + effective-address so we control inputs precisely.

const MY_ADDR = "0x1111111111111111111111111111111111111111";
const BOB    = "0x2222222222222222222222222222222222222222";
const CAROL  = "0x3333333333333333333333333333333333333333";

function row(
  partial: Partial<ActivityRow> & Pick<ActivityRow, "tx_hash" | "user_from" | "user_to" | "activity_type" | "created_at">,
): ActivityRow {
  return {
    id: partial.tx_hash + "_" + partial.user_to,
    contract_address: "0x0000000000000000000000000000000000000000",
    note: "",
    token_address: "0x0000000000000000000000000000000000000000",
    block_number: 0,
    chain_id: 11155111,
    ...partial,
  } as ActivityRow;
}

vi.mock("./useActivityFeed", () => ({
  useActivityFeed: () => ({
    activities: mockActivities,
    isLoading: false,
    isOffline: false,
  }),
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: () => ({
    effectiveAddress: MY_ADDR,
    eoa: MY_ADDR,
    notReadyReason: null,
  }),
}));

let mockActivities: ActivityRow[] = [];

describe("useEncryptedAnalytics", () => {
  it("returns empty snapshot when feed is empty", () => {
    mockActivities = [];
    const { result } = renderHook(() => useEncryptedAnalytics());
    expect(result.current.snapshot.totalEvents).toBe(0);
    expect(result.current.snapshot.sent).toBe(0);
    expect(result.current.snapshot.received).toBe(0);
    expect(result.current.snapshot.monthly).toEqual([]);
    expect(result.current.snapshot.counterparties).toEqual([]);
  });

  it("counts sends + receives per month", () => {
    mockActivities = [
      row({ tx_hash: "0xa", user_from: MY_ADDR, user_to: BOB, activity_type: "payment_sent", created_at: "2026-11-05T10:00:00Z" }),
      row({ tx_hash: "0xb", user_from: BOB, user_to: MY_ADDR, activity_type: "payment_received", created_at: "2026-11-12T10:00:00Z" }),
      row({ tx_hash: "0xc", user_from: MY_ADDR, user_to: CAROL, activity_type: "payment_sent", created_at: "2026-10-01T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useEncryptedAnalytics());
    expect(result.current.snapshot.totalEvents).toBe(3);
    expect(result.current.snapshot.sent).toBe(2);
    expect(result.current.snapshot.received).toBe(1);
    expect(result.current.snapshot.monthly).toHaveLength(2);
    expect(result.current.snapshot.monthly[0].yearMonth).toBe("2026-11");
    expect(result.current.snapshot.monthly[0].sent).toBe(1);
    expect(result.current.snapshot.monthly[0].received).toBe(1);
    expect(result.current.snapshot.monthly[1].yearMonth).toBe("2026-10");
    expect(result.current.snapshot.monthly[1].sent).toBe(1);
  });

  it("aggregates counterparties with directional counts", () => {
    mockActivities = [
      row({ tx_hash: "0xa", user_from: MY_ADDR, user_to: BOB, activity_type: "payment_sent", created_at: "2026-11-05T10:00:00Z" }),
      row({ tx_hash: "0xb", user_from: MY_ADDR, user_to: BOB, activity_type: "payment_sent", created_at: "2026-11-06T10:00:00Z" }),
      row({ tx_hash: "0xc", user_from: BOB, user_to: MY_ADDR, activity_type: "payment_received", created_at: "2026-11-07T10:00:00Z" }),
      row({ tx_hash: "0xd", user_from: CAROL, user_to: MY_ADDR, activity_type: "payment_received", created_at: "2026-11-08T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useEncryptedAnalytics());
    const bob = result.current.snapshot.counterparties.find((c) => c.address === BOB);
    const carol = result.current.snapshot.counterparties.find((c) => c.address === CAROL);
    expect(bob).toBeDefined();
    expect(bob!.total).toBe(3);
    expect(bob!.isReceiver).toBe(2); // I sent to Bob twice
    expect(bob!.isSender).toBe(1);   // Bob sent to me once
    expect(carol!.total).toBe(1);
    expect(carol!.isSender).toBe(1);
    // Top counterparty is Bob.
    expect(result.current.snapshot.counterparties[0].address).toBe(BOB);
  });

  it("categorizes activity_type slugs", () => {
    mockActivities = [
      row({ tx_hash: "0xa", user_from: MY_ADDR, user_to: BOB, activity_type: "invoice_paid", created_at: "2026-11-05T10:00:00Z" }),
      row({ tx_hash: "0xb", user_from: MY_ADDR, user_to: BOB, activity_type: "gift_created", created_at: "2026-11-06T10:00:00Z" }),
      row({ tx_hash: "0xc", user_from: BOB, user_to: MY_ADDR, activity_type: "escrow_released", created_at: "2026-11-07T10:00:00Z" }),
      row({ tx_hash: "0xd", user_from: MY_ADDR, user_to: BOB, activity_type: "offramp_offer_created", created_at: "2026-11-08T10:00:00Z" }),
      row({ tx_hash: "0xe", user_from: MY_ADDR, user_to: BOB, activity_type: "some_unknown_type", created_at: "2026-11-09T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useEncryptedAnalytics());
    const cats = result.current.snapshot.categories.map((c) => c.category);
    expect(cats).toContain("Invoices");
    expect(cats).toContain("Gifts");
    expect(cats).toContain("Escrow");
    expect(cats).toContain("Offramp");
    expect(cats).toContain("Other");
  });

  it("never includes plaintext amounts in the snapshot or CSV", () => {
    mockActivities = [
      row({ tx_hash: "0xa", user_from: MY_ADDR, user_to: BOB, activity_type: "payment_sent", created_at: "2026-11-05T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useEncryptedAnalytics());
    const snap = result.current.snapshot;
    // Snapshot shape has no `amount` / `usd` / `value` field anywhere.
    expect(Object.keys(snap.monthly[0])).not.toContain("amount");
    expect(Object.keys(snap.monthly[0])).not.toContain("usd");
    expect(Object.keys(snap.counterparties[0])).not.toContain("amount");
    // CSV header explicitly excludes amount.
    const header = result.current.csv.split("\n")[0];
    expect(header).not.toContain("amount");
    expect(header).not.toContain("usd");
    // CSV does carry tx_hash, direction, category, etc.
    expect(header).toContain("tx_hash");
    expect(header).toContain("direction");
    expect(header).toContain("category");
  });

  it("skips rows where the user is neither sender nor receiver", () => {
    mockActivities = [
      row({ tx_hash: "0xa", user_from: BOB, user_to: CAROL, activity_type: "payment_sent", created_at: "2026-11-05T10:00:00Z" }),
      row({ tx_hash: "0xb", user_from: MY_ADDR, user_to: BOB, activity_type: "payment_sent", created_at: "2026-11-06T10:00:00Z" }),
    ];
    const { result } = renderHook(() => useEncryptedAnalytics());
    expect(result.current.snapshot.totalEvents).toBe(1);
  });
});
