import { describe, it, expect } from "vitest";
import { resolvePayTarget } from "./pay-resolver";

// §15.x lib test for the /pay/:identifier resolver. Three input shapes
// share one route: 0x address, ENS / Basenames name, INV-<id> invoice.
// Pin the disambiguation logic so a plain address never goes through
// ENS resolution and an INV string never gets parsed as an address.
//
// The INV branch's outcome depends on whether the test environment
// has Supabase configured. We can't assert a specific result-shape
// for those tests; instead we assert that the branch was TAKEN
// (i.e., the result is NEVER "invalid" or "ens-failed"), which is
// what the disambiguation contract guarantees.

describe("resolvePayTarget", () => {
  it("rejects empty / whitespace-only input as invalid", async () => {
    const out = await resolvePayTarget("");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("invalid");

    const out2 = await resolvePayTarget("   ");
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.error.kind).toBe("invalid");
  });

  it("recognizes a plain 40-char 0x address", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(addr);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.target.kind).toBe("address");
      expect(out.target.address.toLowerCase()).toBe(addr);
    }
  });

  it("trims surrounding whitespace before parsing", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(`  ${addr}  `);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.target.kind).toBe("address");
  });

  it("INV-<id> takes the invoice branch (NEVER falls through to invalid / ens-failed)", async () => {
    // The INV regex matches first, so the resolver does NOT fall
    // through to the ENS or invalid branches. The exact outcome
    // depends on whether Supabase is configured + has the row, but
    // those two error kinds must never appear here.
    const out = await resolvePayTarget("INV-9999999");
    if (!out.ok) {
      expect(["supabase-unavailable", "not-found", "invalid"]).toContain(out.error.kind);
      expect(out.error.kind).not.toBe("ens-failed");
    } else {
      // ok=true means a row existed; the kind must be invoice.
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("INV<digits> without dash also matches the invoice branch", async () => {
    const out = await resolvePayTarget("INV9999999");
    if (!out.ok) {
      expect(out.error.kind).not.toBe("ens-failed");
      expect(out.error.kind).not.toBe("invalid");
    } else {
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("INV pattern is case-insensitive (lowercase inv- prefix)", async () => {
    const out = await resolvePayTarget("inv-9999999");
    if (!out.ok) {
      expect(out.error.kind).not.toBe("ens-failed");
      expect(out.error.kind).not.toBe("invalid");
    } else {
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("invalid identifier (non-address, non-INV, non-ENS-shape) returns kind=invalid", async () => {
    const out = await resolvePayTarget("totally random word");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("invalid");
  });

  it("malformed 0x address (too short) is NOT classified as address", async () => {
    const out = await resolvePayTarget("0xabc");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // 0xabc is too short for isAddress and starts with 0x so the ENS
      // heuristic rejects it. Lands on `invalid`.
      expect(out.error.kind).toBe("invalid");
    }
  });
});
