import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildStorageKey,
  STORAGE_KEYS,
  getStoredJson,
  setStoredJson,
  clearAddressScope,
} from "./storage";

describe("buildStorageKey", () => {
  beforeEach(() => localStorage.clear());

  it("builds a scope-only key", () => {
    expect(buildStorageKey("foo")).toBe("blank:foo");
  });

  it("lowercases the address segment", () => {
    expect(buildStorageKey("foo", "0xABC")).toBe("blank:foo:0xabc");
  });

  it("appends the chain id when provided", () => {
    expect(buildStorageKey("foo", "0xABC", 84532)).toBe(
      "blank:foo:0xabc:84532",
    );
  });
});

describe("STORAGE_KEYS", () => {
  it("activities() returns the expected shape", () => {
    expect(STORAGE_KEYS.activities("0xA", 1)).toBe("blank:activities:0xa:1");
  });
});

describe("getStoredJson / setStoredJson", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips an object", () => {
    const key = "blank:test:round-trip";
    const value = { hello: "world", n: 42, nested: { ok: true } };
    const stored = setStoredJson(key, value);
    expect(stored).toBe(true);
    expect(getStoredJson(key, null)).toEqual(value);
  });

  it("returns the fallback when the key is missing", () => {
    const fallback = { fallback: true };
    expect(getStoredJson("blank:test:missing", fallback)).toBe(fallback);
  });

  it("returns the fallback when the stored JSON is corrupt", () => {
    const key = "blank:test:corrupt";
    localStorage.setItem(key, "{not-json");
    const fallback = { fallback: true };
    expect(getStoredJson(key, fallback)).toBe(fallback);
  });

  it("handles out-of-quota localStorage gracefully", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    try {
      expect(setStoredJson("blank:test:quota", { big: "payload" })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("clearAddressScope", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("removes only the keys matching the given scope + address", () => {
    // In scope — should be removed
    localStorage.setItem(STORAGE_KEYS.activities("0xabc", 1), "a");
    localStorage.setItem(STORAGE_KEYS.activities("0xabc", 84532), "b");
    // Different address — should survive
    localStorage.setItem(STORAGE_KEYS.activities("0xdef", 1), "c");
    // Different scope — should survive
    localStorage.setItem(STORAGE_KEYS.contacts("0xabc"), "d");
    // Unrelated key — should survive
    localStorage.setItem("some-other-app:0xabc", "e");

    clearAddressScope("activities", "0xabc");

    expect(localStorage.getItem(STORAGE_KEYS.activities("0xabc", 1))).toBeNull();
    expect(
      localStorage.getItem(STORAGE_KEYS.activities("0xabc", 84532)),
    ).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.activities("0xdef", 1))).toBe("c");
    expect(localStorage.getItem(STORAGE_KEYS.contacts("0xabc"))).toBe("d");
    expect(localStorage.getItem("some-other-app:0xabc")).toBe("e");
  });
});
