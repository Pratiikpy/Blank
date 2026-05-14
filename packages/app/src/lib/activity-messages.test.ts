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

// §15.x extension: exhaustive formatter smoke + note-handling patterns
// + parseGiftEnvelope edge cases + per-category message pins + icon
// long-tail coverage. The toast text is what users SEE in realtime
// notifications, so a formatter regression that produced "undefined
// sent you a payment" or "{from} sent you a {note}" would land in
// users' inboxes immediately. The TypeScript Record<ActivityType,
// Formatter> already guarantees no missing keys at build time; this
// extension pins the OUTPUT shape per formatter so a refactor can't
// silently mangle a message.

describe("formatActivityMessage — exhaustive output smoke", () => {
  it("every formatter returns a non-empty string with both with-note and no-note inputs", () => {
    for (const type of Object.values(ACTIVITY_TYPES)) {
      const noNote = formatActivityMessage(type, "Alice", "");
      const withNote = formatActivityMessage(type, "Alice", "memo here");
      expect(noNote.length, `${type} no-note empty`).toBeGreaterThan(0);
      expect(withNote.length, `${type} with-note empty`).toBeGreaterThan(0);
    }
  });

  it("every formatter (except privacy-preserving stealth events) interpolates the 'from' argument", () => {
    const fromSentinel = "0xUNIQUE_SENTINEL_VALUE";
    // STEALTH_SENT intentionally omits the from address — that's the
    // privacy property of ERC-5564: the recipient sees a notification
    // WITHOUT learning who the sender was at the toast layer.
    // STEALTH_CLAIM_STARTED and STEALTH_CLAIMED include from because
    // the "from" there is the recipient themselves (performing the
    // claim action, not the original sender) — no privacy leak. Pin
    // the exclusion list so a future formatter change that re-
    // introduces a from-leak in STEALTH_SENT fails loud.
    const PRIVACY_OMIT_FROM: ReadonlySet<string> = new Set([
      ACTIVITY_TYPES.STEALTH_SENT,
    ]);
    for (const type of Object.values(ACTIVITY_TYPES)) {
      const out = formatActivityMessage(type, fromSentinel, "");
      if (PRIVACY_OMIT_FROM.has(type)) {
        expect(out, `${type} should NOT leak from-sentinel (privacy)`).not.toContain(
          fromSentinel,
        );
      } else {
        expect(out, `${type} missing from-sentinel`).toContain(fromSentinel);
      }
    }
  });

  it("STEALTH_SENT message does NOT contain the sender (privacy invariant)", () => {
    // Hard-pin the privacy contract: even when a buggy caller passes a
    // real address, the toast layer must keep it hidden. ERC-5564's
    // promise of "the recipient doesn't see the sender" extends to the
    // notification system, not just the on-chain layer.
    const out = formatActivityMessage(ACTIVITY_TYPES.STEALTH_SENT, "0xRealSenderAddress", "");
    expect(out).not.toContain("0xRealSenderAddress");
    // But the message still conveys that something arrived.
    expect(out.toLowerCase()).toContain("stealth");
  });

  it("no formatter output contains the literal 'undefined' or '[object Object]' (bug-trap)", () => {
    for (const type of Object.values(ACTIVITY_TYPES)) {
      for (const note of ["", "test note", "with quotes \"inside\""]) {
        const out = formatActivityMessage(type, "Alice", note);
        expect(out, `${type} leaked undefined`).not.toContain("undefined");
        expect(out, `${type} leaked [object Object]`).not.toContain("[object Object]");
      }
    }
  });
});

describe("formatActivityMessage — note-quoting patterns", () => {
  it("PAYMENT family wraps the note in double quotes", () => {
    expect(formatActivityMessage(ACTIVITY_TYPES.PAYMENT, "Alice", "rent")).toContain('"rent"');
    expect(formatActivityMessage(ACTIVITY_TYPES.TIP, "Alice", "thanks")).toContain('"thanks"');
    expect(formatActivityMessage(ACTIVITY_TYPES.AGENT_PAYMENT, "Alice", "auto-pay")).toContain('"auto-pay"');
    expect(formatActivityMessage(ACTIVITY_TYPES.REQUEST_CREATED, "Alice", "loan")).toContain('"loan"');
  });

  it("INVOICE_CREATED + ESCROW_CREATED use colon-prefixed note (not quotes)", () => {
    expect(formatActivityMessage(ACTIVITY_TYPES.INVOICE_CREATED, "Vendor", "April")).toContain(
      ": April",
    );
    expect(formatActivityMessage(ACTIVITY_TYPES.ESCROW_CREATED, "Alice", "milestone-1")).toContain(
      ": milestone-1",
    );
    expect(formatActivityMessage(ACTIVITY_TYPES.ESCROW_ARBITER_NAMED, "Alice", "case-1")).toContain(
      ": case-1",
    );
  });

  it("GIFT_EXPIRY_CHANGED wraps note in parentheses (a different note style)", () => {
    expect(formatActivityMessage(ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED, "Alice", "+7d")).toContain(
      "(+7d)",
    );
  });

  it("formatters with no note still produce a complete sentence (no dangling colon / quote / paren)", () => {
    const out = formatActivityMessage(ACTIVITY_TYPES.INVOICE_CREATED, "Vendor", "");
    expect(out).toBe("New invoice from Vendor");
    expect(out).not.toContain(":");
    expect(out).not.toContain('""');
  });
});

describe("formatActivityMessage — gift envelope parsing", () => {
  it("plain '[envelope:N]' with no display text omits the quoted message", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "[envelope:5]"),
    ).toBe("Alice sent you a gift! Envelope #5");
  });

  it("'[envelope:N] message' includes both the envelope id AND the quoted message", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "[envelope:99] dinner with friends"),
    ).toBe('Alice sent you a gift! Envelope #99 "dinner with friends"');
  });

  it("malformed envelope tag falls back to plain gift format (treated as literal note)", () => {
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "[envelope] hi"),
    ).toBe('Alice sent you a gift "[envelope] hi"');
    expect(
      formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "envelope:5 missing brackets"),
    ).toBe('Alice sent you a gift "envelope:5 missing brackets"');
  });

  it("empty note produces a bare gift message (no quotes, no envelope)", () => {
    expect(formatActivityMessage(ACTIVITY_TYPES.GIFT_CREATED, "Alice", "")).toBe(
      "Alice sent you a gift",
    );
  });
});

describe("formatActivityMessage — per-category pins", () => {
  it("ESCROW state-transition family produces distinct messages per state", () => {
    const messages = [
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_CREATED, "Alice", ""),
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_DELIVERED, "Alice", ""),
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_RELEASED, "Alice", ""),
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_DISPUTED, "Alice", ""),
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_EXPIRED, "Alice", ""),
      formatActivityMessage(ACTIVITY_TYPES.ESCROW_RESOLVED, "Alice", ""),
    ];
    // All 6 escrow-state messages must be unique strings — a regression
    // that collapsed two states to the same message would erase the
    // visible distinction in the activity feed.
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("INVOICE state-transition family produces distinct messages per state", () => {
    const messages = [
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_CREATED, "Vendor", ""),
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_PAYMENT, "Client", ""),
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_PAID, "Client", ""),
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_FINALIZED, "Client", ""),
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_DISPUTED, "Client", ""),
      formatActivityMessage(ACTIVITY_TYPES.INVOICE_CANCELLED, "Vendor", ""),
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("CLAIM_LINK family produces 3 distinct messages (created / claimed / refunded)", () => {
    const m1 = formatActivityMessage(ACTIVITY_TYPES.CLAIM_LINK_CREATED, "Alice", "lunch");
    const m2 = formatActivityMessage(ACTIVITY_TYPES.CLAIM_LINK_CLAIMED, "Bob", "");
    const m3 = formatActivityMessage(ACTIVITY_TYPES.CLAIM_LINK_REFUNDED, "Alice", "");
    expect(m1).toContain("claim link");
    expect(m2).toContain("claimed");
    expect(m3).toContain("refunded");
    expect(new Set([m1, m2, m3]).size).toBe(3);
  });
});

describe("iconForActivityType — long-tail fallbacks", () => {
  it("VAULT events return the generic 📬 icon (no dedicated emoji)", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.SHIELD)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.UNSHIELD)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.MINT)).toBe("📬");
  });

  it("GROUP events return the generic 📬 icon", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.GROUP_EXPENSE)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.GROUP_SETTLEMENT)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.DEBT_SETTLED)).toBe("📬");
  });

  it("SWAP + PROOF + CREATOR events return the generic 📬 icon", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.SWAP_INITIATED)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.PROOF_CREATED)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.CREATOR_SUPPORT)).toBe("📬");
  });

  it("STEALTH events return the 🕵️ detective icon (the privacy-flavored emoji)", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.STEALTH_SENT)).toBe("🕵️");
    expect(iconForActivityType(ACTIVITY_TYPES.STEALTH_CLAIMED)).toBe("🕵️");
  });

  it("STEALTH_CLAIM_STARTED falls through to generic (intentional — only sent/claimed have the detective emoji)", () => {
    // The source only catches STEALTH_SENT + STEALTH_CLAIMED; the
    // intermediate "claim started" state intentionally uses generic
    // because the user already saw the detective emoji on the sent
    // notification.
    expect(iconForActivityType(ACTIVITY_TYPES.STEALTH_CLAIM_STARTED)).toBe("📬");
  });

  it("INHERITANCE_HEIR_SET is the only inheritance event with the lock icon (others fall through)", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.INHERITANCE_HEIR_SET)).toBe("🔒");
    // Other inheritance events return generic.
    expect(iconForActivityType(ACTIVITY_TYPES.INHERITANCE_SET)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.INHERITANCE_PULSE)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED)).toBe("📬");
  });

  it("CLAIM_LINK events return the generic icon (no dedicated link emoji at toast layer)", () => {
    expect(iconForActivityType(ACTIVITY_TYPES.CLAIM_LINK_CREATED)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.CLAIM_LINK_CLAIMED)).toBe("📬");
    expect(iconForActivityType(ACTIVITY_TYPES.CLAIM_LINK_REFUNDED)).toBe("📬");
  });

  it("empty string falls through to generic 📬 (don't crash on missing type)", () => {
    expect(iconForActivityType("")).toBe("📬");
  });
});
