import { describe, it, expect, beforeEach } from "vitest";
import {
  unlockStealthKeys,
  loadStealthKeys,
  hasStealthKeysStored,
  clearStealthKeys,
  saveStealthKeysAsync,
} from "./stealth-keystore";
import { STORAGE_KEYS } from "./storage";

// §15.x lib test for the stealth-key keystore. The crypto round-trip
// depends on real secp256k1-derived meta-addresses; tests for those
// live in stealth.test.ts. This file pins the lock/cache semantics
// + storage-presence checks that hold without real keys: a fresh
// keystore returns null, clear empties cache + localStorage, and
// hasStealthKeysStored agrees with what readRaw sees.

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  localStorage.clear();
});

describe("stealth-keystore lock/cache semantics (no real keys)", () => {
  it("loadStealthKeys returns null when nothing is stored AND nothing is unlocked", () => {
    expect(loadStealthKeys(ALICE)).toBeNull();
  });

  it("hasStealthKeysStored returns false on a fresh keystore", () => {
    expect(hasStealthKeysStored(ALICE)).toBe(false);
  });

  it("hasStealthKeysStored returns true when raw localStorage has an envelope shape", () => {
    // Simulate a previously-saved encrypted record. We don't decrypt
    // here (that's the round-trip test elsewhere); just verify
    // storage detection reports true.
    const fakeEnvelope = { v: 1, salt: "AA==", iv: "AA==", ct: "AA==" };
    // Using STORAGE_KEYS.stealthKeys(addr) format from the source:
    // the actual key is implementation-specific so we exercise the
    // detection by writing through the keystore's own format.
    // For this test, we just need ANY value in the slot; readRaw
    // returns null only when localStorage has no entry.
    localStorage.setItem(
      STORAGE_KEYS.stealthKeys(ALICE),
      JSON.stringify(fakeEnvelope),
    );
    expect(hasStealthKeysStored(ALICE)).toBe(true);
  });

  it("unlockStealthKeys returns null when no record exists", async () => {
    const out = await unlockStealthKeys(ALICE, "any-passphrase");
    expect(out).toBeNull();
  });

  it("unlockStealthKeys returns null for a falsy address", async () => {
    expect(await unlockStealthKeys("", "any")).toBeNull();
  });

  it("clearStealthKeys empties both localStorage AND the session cache", () => {
    localStorage.setItem(
      STORAGE_KEYS.stealthKeys(ALICE),
      JSON.stringify({ v: 1, salt: "x", iv: "y", ct: "z" }),
    );
    expect(hasStealthKeysStored(ALICE)).toBe(true);
    clearStealthKeys(ALICE);
    expect(hasStealthKeysStored(ALICE)).toBe(false);
    expect(loadStealthKeys(ALICE)).toBeNull();
  });

  it("clearStealthKeys is a no-op for a falsy address", () => {
    // Just must not throw.
    expect(() => clearStealthKeys("")).not.toThrow();
  });

  it("normalizes the address case in the cache key", async () => {
    // Two case variants should resolve to the same cache slot. With
    // no record stored, both return null but exercise the lc() path.
    expect(await unlockStealthKeys(ALICE.toUpperCase(), "x")).toBeNull();
    expect(await unlockStealthKeys(ALICE.toLowerCase(), "x")).toBeNull();
  });

  it("isolates cache + storage by address", () => {
    localStorage.setItem(
      STORAGE_KEYS.stealthKeys(ALICE),
      JSON.stringify({ v: 1, salt: "x", iv: "y", ct: "z" }),
    );
    // Bob has no record; must NOT inherit Alice's storage.
    expect(hasStealthKeysStored(ALICE)).toBe(true);
    expect(hasStealthKeysStored(BOB)).toBe(false);
  });

  it("saveStealthKeysAsync rejects short passphrases (12-char minimum)", async () => {
    // Real keys aren't needed here — the length check fires before any
    // crypto runs. Pass a plausibly-shaped record; the function only
    // validates passphrase first.
    const fakeRecord = {
      spendingPrivateKey: "0x" + "11".repeat(32) as `0x${string}`,
      viewingPrivateKey: "0x" + "22".repeat(32) as `0x${string}`,
      metaAddress: "st:eth:0x" + "33".repeat(66) as `st:eth:0x${string}`,
    } as unknown as Parameters<typeof saveStealthKeysAsync>[1];
    await expect(saveStealthKeysAsync(ALICE, fakeRecord, "")).rejects.toThrow(/at least 12 characters/);
    await expect(saveStealthKeysAsync(ALICE, fakeRecord, "tooShort")).rejects.toThrow(/at least 12 characters/);
  });
});
