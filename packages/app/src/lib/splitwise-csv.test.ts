import { describe, it, expect } from "vitest";
import { parseSplitwiseCsv } from "./splitwise-csv";

// §15.x lib test for the Splitwise CSV importer. Drives the
// group-expenses import flow. The shape is well-documented in the
// file header; pin the expected parse + edge cases.

describe("parseSplitwiseCsv", () => {
  it("parses a basic 2-member row", () => {
    const csv = [
      "Date,Description,Category,Cost,Currency,Alice,Bob",
      "2026-01-15,Lunch,Food,20,USD,-10,10",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);

    expect(out.errors).toEqual([]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual({
      date: "2026-01-15",
      description: "Lunch",
      category: "Food",
      cost: 20,
      currency: "USD",
      shares: { Alice: -10, Bob: 10 },
    });
    expect(out.members).toEqual(["Alice", "Bob"]);
  });

  it("strips $ and commas from amounts", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice,Bob",
      "2026-01-15,Big lunch,\"$1,234.56\",USD,-617.28,617.28",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].cost).toBe(1234.56);
    expect(out.rows[0].shares.Alice).toBe(-617.28);
  });

  it("drops members whose share is zero", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice,Bob,Charlie",
      "2026-01-15,Lunch,30,USD,-15,15,0",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].shares).toEqual({ Alice: -15, Bob: 15 });
    // Charlie still appears in the members list IF they ever had a
    // non-zero share elsewhere. With this single zero row, they do
    // NOT appear.
    expect(out.members).toEqual(["Alice", "Bob"]);
  });

  it("collects errors instead of throwing on malformed rows", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice",
      "2026-01-15,Bad row,,USD,-5",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows).toHaveLength(0);
    expect(out.errors).toEqual([
      { row: 2, reason: "Missing or invalid Cost column" },
    ]);
  });

  it("ignores Splitwise's optional 'Deleted' / 'Exchange rate' columns", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice,Bob,Deleted,Exchange rate",
      "2026-01-15,Lunch,20,USD,-10,10,false,1.0",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].shares).toEqual({ Alice: -10, Bob: 10 });
    // Deleted + Exchange rate are NOT treated as members.
    expect(out.members).toEqual(["Alice", "Bob"]);
  });

  it("uppercases currency", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice",
      "2026-01-15,A,10,eur,-10",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].currency).toBe("EUR");
  });

  it("accepts a YYYY-MM-DD ISO date directly without timezone drift", () => {
    // The fast-path matches /^\d{4}-\d{2}-\d{2}$/ and returns the
    // string verbatim. Non-ISO formats route through new Date() and
    // can drift by a day depending on the running TZ; tested
    // separately so timezone-dependent CI doesn't flake.
    const csv = [
      "Date,Description,Cost,Currency,Alice",
      "2026-01-15,A,10,USD,-10",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].date).toBe("2026-01-15");
  });

  it("returns null date for an unparseable date string", () => {
    const csv = [
      "Date,Description,Cost,Currency,Alice",
      "totally not a date,A,10,USD,-10",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.rows[0].date).toBeNull();
  });

  it("members list is sorted + deduplicated across rows", () => {
    const csv = [
      "Date,Description,Cost,Currency,Charlie,Alice,Bob",
      "2026-01-15,A,10,USD,-5,-5,10",
      "2026-01-16,B,20,USD,0,-10,10",
    ].join("\n");

    const out = parseSplitwiseCsv(csv);
    expect(out.members).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("handles empty CSV without crashing", () => {
    const out = parseSplitwiseCsv("");
    expect(out.rows).toEqual([]);
    expect(out.members).toEqual([]);
  });
});
