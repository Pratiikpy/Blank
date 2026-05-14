import { describe, it, expect } from "vitest";
import { ACTIVITY_TYPES, isKnownActivityType } from "./activity-types";
import { MESSAGE_FORMATTERS } from "./activity-messages";

describe("isKnownActivityType", () => {
  it("returns true for a known type", () => {
    expect(isKnownActivityType("payment")).toBe(true);
  });

  it("returns false for an unknown type", () => {
    expect(isKnownActivityType("not_a_real_type")).toBe(false);
  });
});

describe("MESSAGE_FORMATTERS exhaustiveness", () => {
  it("has a formatter for every value in ACTIVITY_TYPES", () => {
    const activityValues = Object.values(ACTIVITY_TYPES);
    const formatterKeys = new Set(Object.keys(MESSAGE_FORMATTERS));

    const missing = activityValues.filter((v) => !formatterKeys.has(v));
    expect(missing).toEqual([]);

    // Spot-check that at least one formatter is callable.
    const fmt = MESSAGE_FORMATTERS[ACTIVITY_TYPES.PAYMENT];
    expect(typeof fmt).toBe("function");
    expect(fmt({ from: "0xabc...def", note: "hi" })).toContain("0xabc...def");
  });
});

// §15.x extension: deeper coverage of the ACTIVITY_TYPES registry.
// The constants here are the single source of truth for what gets
// inserted into Supabase + emitted from EventHub + scanned by the
// frontend. A regression that renamed a value would silently
// orphan rows already in the database (under the old string) or
// cause the Activity event filter to miss the new emissions. The
// asymmetric inheritance keys (INHERITANCE_HEIR_SET = "heir_set"
// NOT "inheritance_heir_set"; INHERITANCE_PULSE = "heartbeat") are
// load-bearing — they match the on-chain event type strings
// emitted by the contracts, so a "consistent rename" refactor
// would break the database-to-chain join.

describe("ACTIVITY_TYPES registry shape + invariants", () => {
  it("has no duplicate string values (every key maps to a unique value)", () => {
    const values = Object.values(ACTIVITY_TYPES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  it("every value follows the canonical snake_case format (lowercase + underscore-separated)", () => {
    for (const value of Object.values(ACTIVITY_TYPES)) {
      expect(value, `${value} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      // No leading/trailing underscores or double underscores.
      expect(value).not.toMatch(/^_|__|_$/);
    }
  });

  it("has at least 50 distinct activity types (sentinel: catches accidental whole-section drops)", () => {
    // The exact count is brittle because new types get added; the
    // floor catches a regression that wiped out a whole category.
    expect(Object.keys(ACTIVITY_TYPES).length).toBeGreaterThanOrEqual(50);
    expect(Object.values(ACTIVITY_TYPES).length).toBeGreaterThanOrEqual(50);
  });

  it("PAYMENT family values match documented strings", () => {
    expect(ACTIVITY_TYPES.PAYMENT).toBe("payment");
    expect(ACTIVITY_TYPES.BATCH_PAYMENT).toBe("batch_payment");
    expect(ACTIVITY_TYPES.AGENT_PAYMENT).toBe("agent_payment");
    expect(ACTIVITY_TYPES.TIP).toBe("tip");
  });

  it("INHERITANCE keys use asymmetric on-chain-aligned values (NOT the JS-key conventions)", () => {
    // The contract emits these strings; the JS-side key is just an
    // alias for readability. A "consistent naming" refactor that
    // renamed these to inheritance_heir_set / inheritance_pulse
    // would break the EventHub join (events emitted with the OLD
    // strings would no longer match the new constants).
    expect(ACTIVITY_TYPES.INHERITANCE_HEIR_SET).toBe("heir_set");
    expect(ACTIVITY_TYPES.INHERITANCE_PULSE).toBe("heartbeat");
  });

  it("CLAIM_LINK_* values match what ClaimLinks.sol emits via EventHub", () => {
    // Per the source comment: "Strings match the on-chain activity
    // types emitted by ClaimLinks.sol via EventHub."
    expect(ACTIVITY_TYPES.CLAIM_LINK_CREATED).toBe("claim_link_created");
    expect(ACTIVITY_TYPES.CLAIM_LINK_CLAIMED).toBe("claim_link_claimed");
    expect(ACTIVITY_TYPES.CLAIM_LINK_REFUNDED).toBe("claim_link_refunded");
  });

  it("VAULT operations use the bare verb (shield / unshield / mint), not prefixed", () => {
    // These are documented self-events — short bare strings.
    expect(ACTIVITY_TYPES.SHIELD).toBe("shield");
    expect(ACTIVITY_TYPES.UNSHIELD).toBe("unshield");
    expect(ACTIVITY_TYPES.UNSHIELD_CLAIM).toBe("unshield_claim");
    expect(ACTIVITY_TYPES.MINT).toBe("mint");
  });

  it("STEALTH family uses 'stealth_' prefix consistently (3 events)", () => {
    expect(ACTIVITY_TYPES.STEALTH_SENT).toMatch(/^stealth_/);
    expect(ACTIVITY_TYPES.STEALTH_CLAIM_STARTED).toMatch(/^stealth_/);
    expect(ACTIVITY_TYPES.STEALTH_CLAIMED).toMatch(/^stealth_/);
  });

  it("ESCROW family uses 'escrow_' prefix consistently (9 events)", () => {
    const escrowTypes = Object.entries(ACTIVITY_TYPES)
      .filter(([k]) => k.startsWith("ESCROW_"))
      .map(([, v]) => v);
    expect(escrowTypes.length).toBeGreaterThanOrEqual(9);
    for (const v of escrowTypes) {
      expect(v, `escrow value should start with "escrow_": ${v}`).toMatch(/^escrow_/);
    }
  });

  it("GROUP family uses 'group_' prefix EXCEPT debt_settled (intentional carve-out)", () => {
    const groupKeysExceptDebt = Object.entries(ACTIVITY_TYPES)
      .filter(([k]) => k.startsWith("GROUP_"))
      .map(([, v]) => v);
    for (const v of groupKeysExceptDebt) {
      expect(v, `group value should start with "group_": ${v}`).toMatch(/^group_/);
    }
    // DEBT_SETTLED is intentionally NOT prefixed because it's also
    // emitted outside the group context (paired with peer settlements).
    expect(ACTIVITY_TYPES.DEBT_SETTLED).toBe("debt_settled");
  });
});

describe("ActivityType union type + isKnownActivityType edge cases", () => {
  it("isKnownActivityType returns false for the empty string", () => {
    expect(isKnownActivityType("")).toBe(false);
  });

  it("isKnownActivityType returns false for whitespace-only strings", () => {
    expect(isKnownActivityType("  ")).toBe(false);
    expect(isKnownActivityType("\t")).toBe(false);
  });

  it("isKnownActivityType is case-sensitive (uppercase variant rejected)", () => {
    // The contract emits lowercase strings; case-sensitivity protects
    // against a regression that accidentally normalizes via toLowerCase.
    expect(isKnownActivityType("PAYMENT")).toBe(false);
    expect(isKnownActivityType("Payment")).toBe(false);
    // But the lowercase form is accepted.
    expect(isKnownActivityType("payment")).toBe(true);
  });

  it("isKnownActivityType returns true for every value in ACTIVITY_TYPES (round-trip)", () => {
    for (const value of Object.values(ACTIVITY_TYPES)) {
      expect(isKnownActivityType(value), `${value} should be known`).toBe(true);
    }
  });

  it("isKnownActivityType does NOT match a value-substring (e.g. 'pay' isn't a known type)", () => {
    // The check uses Array.includes on the exact value list, so a
    // partial match shouldn't count.
    expect(isKnownActivityType("pay")).toBe(false);
    expect(isKnownActivityType("invoice")).toBe(false);
    expect(isKnownActivityType("claim_link")).toBe(false);
  });
});
