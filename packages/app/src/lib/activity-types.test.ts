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
