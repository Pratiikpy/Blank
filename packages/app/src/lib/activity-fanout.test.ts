import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertActivitiesFanout } from "./activity-fanout";

// Mock the supabase insertActivity dependency BEFORE importing the
// SUT. activity-fanout uses Promise.allSettled across N concurrent
// inserts; partial failures must NOT halt remaining inserts.
vi.mock("./supabase", async () => {
  const actual = await vi.importActual<typeof import("./supabase")>("./supabase");
  return {
    ...actual,
    insertActivity: vi.fn(),
  };
});

import { insertActivity } from "./supabase";

const insertActivityMock = insertActivity as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  insertActivityMock.mockReset();
});

const ACTIVITY = (txHash: string) =>
  ({
    user_from: "0xa",
    user_to: "0xb",
    activity_type: "payment",
    note: "",
    tx_hash: txHash,
    chain_id: 11155111,
    source_contract: "0xc",
    ref_id: 0,
  }) as unknown as Parameters<typeof insertActivitiesFanout>[0][number];

describe("insertActivitiesFanout", () => {
  it("returns successes=N for all-success path", async () => {
    insertActivityMock.mockResolvedValue(undefined);
    const out = await insertActivitiesFanout([ACTIVITY("tx1"), ACTIVITY("tx2"), ACTIVITY("tx3")]);
    expect(out).toEqual({ successes: 3, failures: 0, errors: [] });
  });

  it("partial failures do NOT halt remaining inserts (Promise.allSettled)", async () => {
    insertActivityMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("supabase down"))
      .mockResolvedValueOnce(undefined);

    const out = await insertActivitiesFanout([ACTIVITY("tx1"), ACTIVITY("tx2"), ACTIVITY("tx3")]);

    // Critical: insertActivity must have been called for ALL 3, even
    // though tx2 rejected. Sequential await would have stopped at tx2.
    expect(insertActivityMock).toHaveBeenCalledTimes(3);
    expect(out.successes).toBe(2);
    expect(out.failures).toBe(1);
    expect(out.errors).toEqual([{ tx_hash: "tx2", error: "supabase down" }]);
  });

  it("returns full failure summary when every insert rejects", async () => {
    insertActivityMock.mockRejectedValue(new Error("offline"));
    const out = await insertActivitiesFanout([ACTIVITY("tx1"), ACTIVITY("tx2")]);
    expect(out.successes).toBe(0);
    expect(out.failures).toBe(2);
    expect(out.errors.map((e) => e.tx_hash)).toEqual(["tx1", "tx2"]);
    expect(out.errors.every((e) => e.error === "offline")).toBe(true);
  });

  it("handles non-Error rejection reasons by stringifying", async () => {
    insertActivityMock.mockRejectedValueOnce("just a string");
    const out = await insertActivitiesFanout([ACTIVITY("tx1")]);
    expect(out.errors[0].error).toBe("just a string");
  });

  it("returns empty result for empty input", async () => {
    const out = await insertActivitiesFanout([]);
    expect(out).toEqual({ successes: 0, failures: 0, errors: [] });
    expect(insertActivityMock).not.toHaveBeenCalled();
  });
});
