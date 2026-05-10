import { describe, it, expect, vi } from "vitest";
import { broadcastAction, onCrossTabAction } from "./cross-tab";

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
