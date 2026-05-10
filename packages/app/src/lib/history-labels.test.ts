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
