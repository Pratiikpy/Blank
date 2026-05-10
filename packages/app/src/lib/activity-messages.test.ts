import { describe, it, expect } from "vitest";
import { formatActivityMessage, iconForActivityType, MESSAGE_FORMATTERS } from "./activity-messages";
import { ACTIVITY_TYPES } from "./activity-types";

// §15.x lib test for activity-feed message formatters. Every realtime
// notification toast and history-row label routes through these. The
// MESSAGE_FORMATTERS Record is typed `Record<ActivityType, Formatter>`
// so TS catches missing entries at build time; this test pins runtime
// behavior and the unknown-type fallback path.

describe("formatActivityMessage", () => {
  it("formats a plain payment with no note", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.PAYMENT, "0xabc...def", ""),
    ).toBe("0xabc...def sent you a payment");
  });

  it("formats a payment with a note in quotes", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.PAYMENT, "0xabc...def", "rent"),
    ).toBe('0xabc...def sent you a payment "rent"');
  });

  it("formats invoice-created with colon-separated note", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_CREATED, "Vendor", "April"),
    ).toBe("New invoice from Vendor: April");
  });

  it("parses envelope id from gift note: [envelope:123]", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "[envelope:42] hello"),
    ).toBe('Alice sent you a gift! Envelope #42 "hello"');
  });

  it("falls back to plain gift format when no envelope prefix", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "hi"),
    ).toBe('Alice sent you a gift "hi"');
  });

  it("formats claim-link created with note", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.CLAIM_LINK_CREATED, "Alice", "lunch"),
    ).toBe('Alice sent you a claim link "lunch"');
  });

  it("falls back to default for unknown activity type", () => {
    expect(
      formatActivityMessage("totally_made_up_type", "Alice", ""),
    ).toBe("Activity from Alice");
  });

  it("has a formatter for every declared ActivityType", () => {
    // Build-time TS already enforces this via the Record<ActivityType, ...>
    // type. Runtime sanity: every value of ACTIVITY_TYPES has a formatter.
    for (const type of Object.values(ACTIVITY_TYPES)) {
      expect(typeof MESSAGE_FORMATTERS[type]).toBe("function");
    }
  });
});

describe("iconForActivityType", () => {
  it("returns 💰 for payment-shaped activity types", () => {
    const money = "💰";
    expect(iconForActivityType(ACTIVITY_TYPES.PAYMENT)).toBe(money);
    expect(iconForActivityType(ACTIVITY_TYPES.TIP)).toBe(money);
    expect(iconForActivityType(ACTIVITY_TYPES.AGENT_PAYMENT)).toBe(money);
  });

  it("returns 🎁 for gift activity types", () => {
    const gift = "🎁";
    expect(iconForActivityType(ACTIVITY_TYPES.GIFT_CREATED)).toBe(gift);
    expect(iconForActivityType(ACTIVITY_TYPES.GIFT_CLAIMED)).toBe(gift);
  });

  it("returns 📥 for incoming-request activity", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.REQUEST_CREATED)).toBe("📥");
  });

  it("returns 📄 for invoice activities", () => {
    const inv = "📄";
    expect(iconForActivityType(ACTIVITY_TYPES.INVOICE_CREATED)).toBe(inv);
    expect(iconForActivityType(ACTIVITY_TYPES.INVOICE_PAID)).toBe(inv);
  });

  it("returns 🔒 for inheritance heir set", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.INHERITANCE_HEIR_SET)).toBe("🔒");
  });

  it("returns generic 📬 for unknown types", () => {
    expect(iconForActivityType("unknown_type")).toBe("📬");
  });
});
