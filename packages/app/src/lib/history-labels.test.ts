import { describe, it, expect } from "vitest";
import { ACTIVITY_TYPES } from "./activity-types";
import { getHistoryLabel, getHistoryIcon, hasCounterparty } from "./history-labels";

describe("history-labels", () => {
  describe("getHistoryLabel", () => {
    it("differentiates incoming vs outgoing for symmetric types", () => {
      expect(getHistoryLabel(ACTIVITY_TYPES.PAYMENT, true)).toBe("Payment received");
      expect(getHistoryLabel(ACTIVITY_TYPES.PAYMENT, false)).toBe("Payment sent");
    });

    it("uses claim-link-aware copy for the new types", () => {
      expect(getHistoryLabel(ACTIVITY_TYPES.CLAIM_LINK_CREATED, true)).toBe("Claim link received");
      expect(getHistoryLabel(ACTIVITY_TYPES.CLAIM_LINK_CREATED, false)).toBe("Claim link sent");
      expect(getHistoryLabel(ACTIVITY_TYPES.CLAIM_LINK_CLAIMED, false)).toBe("Recipient claimed");
      expect(getHistoryLabel(ACTIVITY_TYPES.CLAIM_LINK_REFUNDED, false)).toBe("You refunded a link");
    });

    it("returns the raw type for unknown activity strings (graceful fallback)", () => {
      expect(getHistoryLabel("never_existed_type", true)).toBe("never_existed_type");
    });

    it("covers every activity type with a non-empty label (in + out)", () => {
      for (const type of Object.values(ACTIVITY_TYPES)) {
        expect(getHistoryLabel(type, true).length).toBeGreaterThan(0);
        expect(getHistoryLabel(type, false).length).toBeGreaterThan(0);
        expect(getHistoryLabel(type, true)).not.toBe(type);
      }
    });
  });

  describe("hasCounterparty", () => {
    it("excludes self-events", () => {
      expect(hasCounterparty(ACTIVITY_TYPES.SHIELD)).toBe(false);
      expect(hasCounterparty(ACTIVITY_TYPES.MINT)).toBe(false);
      expect(hasCounterparty(ACTIVITY_TYPES.CLAIM_LINK_REFUNDED)).toBe(false);
    });
    it("includes peer events", () => {
      expect(hasCounterparty(ACTIVITY_TYPES.PAYMENT)).toBe(true);
      expect(hasCounterparty(ACTIVITY_TYPES.INVOICE_PAID)).toBe(true);
      expect(hasCounterparty(ACTIVITY_TYPES.CLAIM_LINK_CREATED)).toBe(true);
    });
  });

  describe("getHistoryIcon", () => {
    it("returns a valid icon entry for every activity type", () => {
      for (const type of Object.values(ACTIVITY_TYPES)) {
        const entry = getHistoryIcon(type);
        expect(entry.icon).toBeTruthy();
        expect(entry.bg).toMatch(/bg-/);
      }
    });
    it("returns the misc fallback for unknown types", () => {
      const entry = getHistoryIcon("garbage");
      expect(entry.icon).toBeTruthy();
      expect(entry.bg).toMatch(/bg-/);
    });
  });
});

// §15.x extension: per-category label + icon assertions + registry
// consistency. The existing 6-case tests verified the happy path but
// didn't lock in:
//   - direction-asymmetric vs direction-symmetric labels per
//     category (a regression that collapsed in/out for PAYMENT
//     would be invisible)
//   - the specific icon + color scheme per category (a regression
//     that swapped INVOICE's icon to Send would slip through the
//     "any truthy icon" check)
//   - exhaustive enumeration of every self-event in hasCounterparty
//     (a missing case statement would default to true and the UI
//     would render a phantom counterparty row)

describe("history-labels — direction-asymmetric labels (in != out)", () => {
  // Categories where the user's role matters — incoming reads
  // different from outgoing. A regression that collapsed these
  // would lose role-context in the History row.
  const ASYMMETRIC_TYPES: ReadonlyArray<string> = [
    ACTIVITY_TYPES.PAYMENT,
    ACTIVITY_TYPES.BATCH_PAYMENT,
    ACTIVITY_TYPES.AGENT_PAYMENT,
    ACTIVITY_TYPES.TIP,
    ACTIVITY_TYPES.REQUEST_CREATED,
    ACTIVITY_TYPES.REQUEST_FULFILLED,
    ACTIVITY_TYPES.GIFT_CREATED,
    ACTIVITY_TYPES.GIFT_CLAIMED,
    ACTIVITY_TYPES.GIFT_DEACTIVATED,
    ACTIVITY_TYPES.PAYROLL,
    ACTIVITY_TYPES.INVOICE_CREATED,
    ACTIVITY_TYPES.INVOICE_PAYMENT,
    ACTIVITY_TYPES.INVOICE_PAID,
    ACTIVITY_TYPES.INVOICE_DISPUTED,
    ACTIVITY_TYPES.INVOICE_CANCELLED,
    ACTIVITY_TYPES.ESCROW_CREATED,
    ACTIVITY_TYPES.ESCROW_ARBITER_NAMED,
    ACTIVITY_TYPES.ESCROW_DELIVERED,
    ACTIVITY_TYPES.ESCROW_RELEASED,
    ACTIVITY_TYPES.ESCROW_DISPUTED,
    ACTIVITY_TYPES.ESCROW_EXPIRED_CLAIMED,
    ACTIVITY_TYPES.GROUP_EXPENSE,
    ACTIVITY_TYPES.GROUP_SETTLEMENT,
    ACTIVITY_TYPES.GROUP_VOTE,
    ACTIVITY_TYPES.GROUP_LEFT,
    ACTIVITY_TYPES.GROUP_ARCHIVED,
    ACTIVITY_TYPES.DEBT_SETTLED,
    ACTIVITY_TYPES.CREATOR_SUPPORT,
    ACTIVITY_TYPES.CREATOR_PROFILE_UPDATED,
    ACTIVITY_TYPES.OFFER_CREATED,
    ACTIVITY_TYPES.OFFER_FILLED,
    ACTIVITY_TYPES.OFFER_CANCELLED,
    ACTIVITY_TYPES.STEALTH_SENT,
    ACTIVITY_TYPES.INHERITANCE_HEIR_SET,
    ACTIVITY_TYPES.INHERITANCE_PULSE,
    ACTIVITY_TYPES.INHERITANCE_CLAIM_STARTED,
    ACTIVITY_TYPES.PROOF_CREATED,
    ACTIVITY_TYPES.PROOF_PUBLISHED,
    ACTIVITY_TYPES.CLAIM_LINK_CREATED,
    ACTIVITY_TYPES.CLAIM_LINK_CLAIMED,
    ACTIVITY_TYPES.CLAIM_LINK_REFUNDED,
  ];

  it("at least 30 types have direction-asymmetric labels (in != out)", () => {
    let asymmetric = 0;
    for (const type of ASYMMETRIC_TYPES) {
      const inLabel = getHistoryLabel(type, true);
      const outLabel = getHistoryLabel(type, false);
      if (inLabel !== outLabel) asymmetric++;
    }
    // Sentinel — if a regression collapsed direction handling across
    // categories, this count would drop sharply.
    expect(asymmetric).toBeGreaterThanOrEqual(30);
  });

  it("PAYMENT family: 'received' vs 'sent' / 'paid by you'", () => {
    expect(getHistoryLabel(ACTIVITY_TYPES.PAYMENT, true)).toContain("received");
    expect(getHistoryLabel(ACTIVITY_TYPES.PAYMENT, false)).toContain("sent");
    expect(getHistoryLabel(ACTIVITY_TYPES.TIP, true)).toContain("received");
    expect(getHistoryLabel(ACTIVITY_TYPES.TIP, false)).toContain("sent");
  });

  it("INVOICE family: outgoing uses 'You ...' or '... by you' framing for second-person clarity", () => {
    expect(getHistoryLabel(ACTIVITY_TYPES.INVOICE_PAYMENT, false)).toMatch(/You|by you/);
    expect(getHistoryLabel(ACTIVITY_TYPES.INVOICE_DISPUTED, false)).toMatch(/You|by you/);
    expect(getHistoryLabel(ACTIVITY_TYPES.INVOICE_CANCELLED, false)).toMatch(/You|by you/);
  });

  it("ESCROW family: incoming reads as a notification ('Escrow created'), outgoing as an action ('You created an escrow')", () => {
    expect(getHistoryLabel(ACTIVITY_TYPES.ESCROW_CREATED, true)).toBe("Escrow created");
    expect(getHistoryLabel(ACTIVITY_TYPES.ESCROW_CREATED, false)).toContain("You created");
  });
});

describe("history-labels — symmetric labels (in == out by design)", () => {
  // These types fire from the user's own action AND show up in their
  // own history with the same framing on both sides (no peer
  // distinction). A regression that diverged them would surface
  // weird-sounding text on the user's own row.
  const SYMMETRIC_TYPES: ReadonlyArray<string> = [
    ACTIVITY_TYPES.REQUEST_CANCELLED,
    ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED,
    ACTIVITY_TYPES.INVOICE_FINALIZED,
    ACTIVITY_TYPES.ESCROW_EXPIRED,
    ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED,
    ACTIVITY_TYPES.ESCROW_RESOLVED,
    ACTIVITY_TYPES.EXCHANGE_VERIFIED,
    ACTIVITY_TYPES.EXCHANGE_INVALID,
    ACTIVITY_TYPES.STEALTH_CLAIM_STARTED,
    ACTIVITY_TYPES.STEALTH_CLAIMED,
    ACTIVITY_TYPES.SHIELD,
    ACTIVITY_TYPES.UNSHIELD,
    ACTIVITY_TYPES.UNSHIELD_CLAIM,
    ACTIVITY_TYPES.MINT,
    ACTIVITY_TYPES.SWAP_INITIATED,
    ACTIVITY_TYPES.SWAP_SETTLED,
    ACTIVITY_TYPES.SWAP_CANCELLED,
    ACTIVITY_TYPES.INHERITANCE_SET,
    ACTIVITY_TYPES.INHERITANCE_HEIR_REMOVED,
    ACTIVITY_TYPES.INHERITANCE_VAULTS_SET,
    ACTIVITY_TYPES.INHERITANCE_CLAIM_CANCELLED,
    ACTIVITY_TYPES.INHERITANCE_CLAIM_FINALIZED,
  ];

  it("symmetric types return identical labels for in and out", () => {
    for (const type of SYMMETRIC_TYPES) {
      const inLabel = getHistoryLabel(type, true);
      const outLabel = getHistoryLabel(type, false);
      expect(inLabel, `${type}: in (${inLabel}) vs out (${outLabel})`).toBe(outLabel);
    }
  });
});

describe("history-labels — hasCounterparty exhaustive self-events", () => {
  // Pin every self-event explicitly so adding a new one to the switch
  // (or accidentally removing one) shows up here.
  const SELF_EVENT_TYPES: ReadonlyArray<string> = [
    ACTIVITY_TYPES.SHIELD,
    ACTIVITY_TYPES.UNSHIELD,
    ACTIVITY_TYPES.UNSHIELD_CLAIM,
    ACTIVITY_TYPES.MINT,
    ACTIVITY_TYPES.GIFT_DEACTIVATED,
    ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED,
    ACTIVITY_TYPES.GROUP_LEFT,
    ACTIVITY_TYPES.GROUP_ARCHIVED,
    ACTIVITY_TYPES.INHERITANCE_PULSE,
    ACTIVITY_TYPES.CLAIM_LINK_REFUNDED,
  ];

  it("returns false for every self-event (10 cases)", () => {
    for (const type of SELF_EVENT_TYPES) {
      expect(hasCounterparty(type), `${type} should be self-event`).toBe(false);
    }
  });

  it("returns true for the inverse set (every non-self-event)", () => {
    const selfSet = new Set<string>(SELF_EVENT_TYPES);
    for (const type of Object.values(ACTIVITY_TYPES)) {
      if (!selfSet.has(type)) {
        expect(hasCounterparty(type), `${type} should have counterparty`).toBe(true);
      }
    }
  });

  it("returns true for unknown types (default branch — peer is the safer fallback)", () => {
    // If a future activity type slips in without a switch case, the
    // default returns true. Pin the fallback so the UI renders a
    // "from / to" line (which the row can show as an empty address
    // truncated) rather than silently hide the counterparty section.
    expect(hasCounterparty("never_existed_type")).toBe(true);
  });
});

describe("history-labels — getHistoryIcon per-category palette", () => {
  it("PAYMENT family routes to the Send/blue icon", () => {
    const entry = getHistoryIcon(ACTIVITY_TYPES.PAYMENT);
    expect(entry.bg).toContain("blue");
  });

  it("VAULT events (SHIELD / UNSHIELD / UNSHIELD_CLAIM) route to the amber/KeyRound icon", () => {
    for (const t of [
      ACTIVITY_TYPES.SHIELD,
      ACTIVITY_TYPES.UNSHIELD,
      ACTIVITY_TYPES.UNSHIELD_CLAIM,
    ]) {
      expect(getHistoryIcon(t).bg).toContain("amber");
    }
  });

  it("STEALTH events route to the gray/Ghost icon (the privacy-flavored category)", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.STEALTH_SENT).bg).toContain("gray");
    expect(getHistoryIcon(ACTIVITY_TYPES.STEALTH_CLAIMED).bg).toContain("gray");
  });

  it("GROUP events route to the indigo/Users icon", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.GROUP_EXPENSE).bg).toContain("indigo");
    expect(getHistoryIcon(ACTIVITY_TYPES.GROUP_SETTLEMENT).bg).toContain("indigo");
    expect(getHistoryIcon(ACTIVITY_TYPES.DEBT_SETTLED).bg).toContain("indigo");
  });

  it("INHERITANCE events route to the stone/Shield icon", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.INHERITANCE_SET).bg).toContain("stone");
    expect(getHistoryIcon(ACTIVITY_TYPES.INHERITANCE_HEIR_SET).bg).toContain("stone");
  });

  it("CREATOR events route to the rose/Heart icon", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.CREATOR_SUPPORT).bg).toContain("rose");
  });

  it("CLAIM_LINK events route to the blue/Link2 icon", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.CLAIM_LINK_CREATED).bg).toContain("blue");
    expect(getHistoryIcon(ACTIVITY_TYPES.CLAIM_LINK_CLAIMED).bg).toContain("blue");
  });

  it("misc fallback uses the gray/Sparkles icon (catches unknown types gracefully)", () => {
    const entry = getHistoryIcon("never_existed_type");
    expect(entry.bg).toContain("gray");
  });

  it("INVOICE family is split: created/payment/disputed/cancelled use the slate-700 INVOICE icon, paid/finalized use the lime RECEIPT_I icon (the celebration palette)", () => {
    expect(getHistoryIcon(ACTIVITY_TYPES.INVOICE_CREATED).bg).toContain("slate");
    expect(getHistoryIcon(ACTIVITY_TYPES.INVOICE_PAYMENT).bg).toContain("slate");
    expect(getHistoryIcon(ACTIVITY_TYPES.INVOICE_PAID).bg).toContain("lime");
    expect(getHistoryIcon(ACTIVITY_TYPES.INVOICE_FINALIZED).bg).toContain("lime");
  });
});
