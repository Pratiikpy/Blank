import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_EVENTS,
  ALL_EVENT_TYPES,
  buildEventId,
  fillBody,
} from "./notification-events";

describe("notification-events", () => {
  it("ships exactly the 12 event types per Wave 5 §5.1", () => {
    expect(ALL_EVENT_TYPES).toHaveLength(12);
  });

  it("every event has at least one channel", () => {
    for (const t of ALL_EVENT_TYPES) {
      const def = NOTIFICATION_EVENTS[t];
      expect(def.channels.length).toBeGreaterThan(0);
    }
  });

  it("buildEventId is deterministic on (tx_hash + logIndex + type + handle)", () => {
    const a = buildEventId({ txHash: "0xabc", logIndex: 0, eventType: "invoice_paid", handle: "0xdEad" });
    const b = buildEventId({ txHash: "0xABC", logIndex: 0, eventType: "invoice_paid", handle: "0xdead" });
    expect(a).toBe(b);
  });

  it("buildEventId differs when logIndex differs", () => {
    const a = buildEventId({ txHash: "0xabc", logIndex: 0, eventType: "invoice_paid", handle: "0xdead" });
    const b = buildEventId({ txHash: "0xabc", logIndex: 1, eventType: "invoice_paid", handle: "0xdead" });
    expect(a).not.toBe(b);
  });

  it("fillBody substitutes variables and preserves unknown keys", () => {
    expect(fillBody("Hi {name}, you have {n} pending.", { name: "Alice", n: 3 }))
      .toBe("Hi Alice, you have 3 pending.");
    expect(fillBody("Hi {name}, unknown {missing}.", { name: "Alice" }))
      .toBe("Hi Alice, unknown {missing}.");
  });
});
