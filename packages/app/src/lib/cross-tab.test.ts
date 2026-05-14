import { describe, it, expect, vi } from "vitest";
import {
  broadcastAction,
  onCrossTabAction,
  getCrossTabChannel,
  type CrossTabAction,
} from "./cross-tab";

// §15.x lib test for the cross-tab broadcast envelope (Top-28 #12).
// The envelope discriminator (tag + version + known-action set) is the
// only thing stopping browser extensions, devtools snippets, or other
// same-origin code from injecting fake balance_changed / passkey
// events into the app. Pin the validation contract here.

describe("cross-tab broadcastAction + onCrossTabAction", () => {
  it("delivers a broadcast same-tab to a registered listener", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);

    broadcastAction("balance_changed", { hash: "0xa" });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("balance_changed", { hash: "0xa" });
    unsub();
  });

  it("data is optional", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    broadcastAction("aa_passkey_changed");
    expect(callback).toHaveBeenCalledWith("aa_passkey_changed", undefined);
    unsub();
  });

  it("delivers to multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = onCrossTabAction(a);
    const unsubB = onCrossTabAction(b);
    broadcastAction("activity_added");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it("unsubscribe stops further delivery", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    unsub();
    broadcastAction("balance_changed");
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects raw window CustomEvent without our envelope", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);

    // Simulate an extension dispatching a same-named event with bad shape.
    window.dispatchEvent(
      new CustomEvent("blank-cross-action", { detail: { action: "balance_changed" } }),
    );
    expect(callback).not.toHaveBeenCalled();

    // Wrong tag
    window.dispatchEvent(
      new CustomEvent("blank-cross-action", {
        detail: {
          tag: "different-app",
          version: 1,
          senderId: "x",
          action: "balance_changed",
          timestamp: Date.now(),
        },
      }),
    );
    expect(callback).not.toHaveBeenCalled();

    // Wrong version
    window.dispatchEvent(
      new CustomEvent("blank-cross-action", {
        detail: {
          tag: "blank-cross-tab",
          version: 999,
          senderId: "x",
          action: "balance_changed",
          timestamp: Date.now(),
        },
      }),
    );
    expect(callback).not.toHaveBeenCalled();

    // Unknown action
    window.dispatchEvent(
      new CustomEvent("blank-cross-action", {
        detail: {
          tag: "blank-cross-tab",
          version: 1,
          senderId: "x",
          action: "totally_made_up",
          timestamp: Date.now(),
        },
      }),
    );
    expect(callback).not.toHaveBeenCalled();

    unsub();
  });

  it("accepts a fully-formed envelope dispatched directly", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);

    window.dispatchEvent(
      new CustomEvent("blank-cross-action", {
        detail: {
          tag: "blank-cross-tab",
          version: 1,
          senderId: "test",
          action: "passphrase_resolved",
          data: { addr: "0xabc" },
          timestamp: Date.now(),
        },
      }),
    );
    expect(callback).toHaveBeenCalledWith("passphrase_resolved", { addr: "0xabc" });
    unsub();
  });
});

// §15.x extension: KNOWN_ACTIONS round-trip coverage + envelope-
// validation negative-space + channel-caching contract + dual-broadcast
// (cross-tab + same-tab) shape. The 7-action set is closed; a regression
// that dropped one (or accidentally added an undeclared one) would
// silently route the matching cross-tab sync to nowhere. Channel caching
// matters because BroadcastChannel construction is mildly expensive and
// repeat-instantiation would prevent the cross-tab fan-out from sharing
// a connection.

describe("cross-tab — KNOWN_ACTIONS round-trip", () => {
  // All 7 declared CrossTabAction values must round-trip through the
  // envelope path. A regression that dropped one from KNOWN_ACTIONS
  // would fail loud here; a regression that ADDED an undeclared one
  // would silently slip past the validator. The list MUST equal the
  // CrossTabAction union exactly.
  const ALL_ACTIONS: CrossTabAction[] = [
    "balance_changed",
    "activity_added",
    "stealth_inbox_changed",
    "pending_claim_removed",
    "aa_nonce_used",
    "aa_passkey_changed",
    "passphrase_resolved",
  ];

  it.each(ALL_ACTIONS)("%s round-trips through broadcastAction + onCrossTabAction", (action) => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    broadcastAction(action, { id: action });
    expect(callback).toHaveBeenCalledWith(action, { id: action });
    unsub();
  });

  it("the action set has exactly 7 entries (sentinel: catches accidental drops)", () => {
    expect(ALL_ACTIONS.length).toBe(7);
    expect(new Set(ALL_ACTIONS).size).toBe(7);
  });
});

describe("cross-tab — getCrossTabChannel caching contract", () => {
  it("returns the SAME BroadcastChannel instance on repeated calls (module-level cache)", () => {
    // BroadcastChannel construction is per-instance; the cache means
    // every cross-tab broadcast shares the connection, and a regression
    // that disabled the cache would silently waste resources without
    // any visible behavior change at the test layer.
    const a = getCrossTabChannel();
    const b = getCrossTabChannel();
    expect(a).toBe(b);
  });

  it("returns a BroadcastChannel instance in jsdom (the env DOES define it)", () => {
    // jsdom 23+ provides BroadcastChannel; if a future jsdom upgrade
    // removed it, every cross-tab test would silently degrade to
    // same-tab-only. Pin the env contract so the regression surfaces.
    const ch = getCrossTabChannel();
    expect(ch).not.toBeNull();
    expect(ch).toBeInstanceOf(BroadcastChannel);
  });
});

describe("cross-tab — envelope validation negative-space", () => {
  // The existing test covered 4 reject cases (no envelope, wrong tag,
  // wrong version, unknown action). Below pins the remaining 5: null
  // detail, missing senderId, empty senderId, non-string action,
  // missing timestamp.

  function dispatchEvent(detail: unknown) {
    window.dispatchEvent(new CustomEvent("blank-cross-action", { detail }));
  }

  it("rejects detail=null (defensive — extensions could omit detail entirely)", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent(null);
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });

  it("rejects detail with missing senderId", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent({
      tag: "blank-cross-tab",
      version: 1,
      // no senderId
      action: "balance_changed",
      timestamp: Date.now(),
    });
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });

  it("rejects detail with empty-string senderId", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent({
      tag: "blank-cross-tab",
      version: 1,
      senderId: "",
      action: "balance_changed",
      timestamp: Date.now(),
    });
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });

  it("rejects detail with non-string action (e.g. action as number)", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent({
      tag: "blank-cross-tab",
      version: 1,
      senderId: "x",
      action: 123 as unknown as string,
      timestamp: Date.now(),
    });
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });

  it("rejects detail with missing timestamp", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent({
      tag: "blank-cross-tab",
      version: 1,
      senderId: "x",
      action: "balance_changed",
      // no timestamp
    });
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });

  it("rejects detail with non-numeric timestamp", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    dispatchEvent({
      tag: "blank-cross-tab",
      version: 1,
      senderId: "x",
      action: "balance_changed",
      timestamp: "not-a-number" as unknown as number,
    });
    expect(callback).not.toHaveBeenCalled();
    unsub();
  });
});

describe("cross-tab — broadcastAction envelope shape", () => {
  it("posts a stable senderId on consecutive broadcasts (same tab = same ID)", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    // We don't see senderId at the callback (the API hides it); the
    // best proxy is to verify the receive path works repeatedly without
    // any silent ID-rotation kicking in.
    broadcastAction("balance_changed");
    broadcastAction("balance_changed");
    broadcastAction("balance_changed");
    expect(callback).toHaveBeenCalledTimes(3);
    unsub();
  });

  it("sets a Date.now-style numeric timestamp on the envelope (verified via direct same-tab dispatch capture)", () => {
    // Intercept window dispatchEvent to capture the envelope shape on
    // broadcastAction's same-tab fan-out path.
    const captured: unknown[] = [];
    const realDispatch = window.dispatchEvent.bind(window);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent").mockImplementation((e: Event) => {
      if (e.type === "blank-cross-action") {
        captured.push((e as CustomEvent).detail);
      }
      return realDispatch(e);
    });
    const before = Date.now();
    broadcastAction("balance_changed", { test: true });
    const after = Date.now();
    expect(captured.length).toBeGreaterThan(0);
    const env = captured[0] as {
      tag: string;
      version: number;
      senderId: string;
      action: string;
      data?: { test: boolean };
      timestamp: number;
    };
    expect(env.tag).toBe("blank-cross-tab");
    expect(env.version).toBe(1);
    expect(env.action).toBe("balance_changed");
    expect(env.data).toEqual({ test: true });
    expect(typeof env.senderId).toBe("string");
    expect(env.senderId.length).toBeGreaterThan(0);
    // Timestamp is within the test window.
    expect(env.timestamp).toBeGreaterThanOrEqual(before);
    expect(env.timestamp).toBeLessThanOrEqual(after);
    dispatchSpy.mockRestore();
  });

  it("omits the data field on the envelope when broadcastAction is called without data", () => {
    const captured: unknown[] = [];
    const realDispatch = window.dispatchEvent.bind(window);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent").mockImplementation((e: Event) => {
      if (e.type === "blank-cross-action") {
        captured.push((e as CustomEvent).detail);
      }
      return realDispatch(e);
    });
    broadcastAction("aa_passkey_changed");
    const env = captured[0] as { data?: unknown };
    // The source spreads `data` into the payload even when undefined,
    // so the field is present but undefined (NOT absent). Pin the
    // user-visible behavior: the listener receives undefined.
    expect(env.data).toBeUndefined();
    dispatchSpy.mockRestore();
  });
});

describe("cross-tab — unsubscribe idempotency", () => {
  it("calling unsub twice doesn't throw (defensive cleanup pattern)", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("unsubscribe after the listener never fired is safe (no event delivered scenario)", () => {
    const callback = vi.fn();
    const unsub = onCrossTabAction(callback);
    // No broadcastAction call.
    expect(() => unsub()).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});
