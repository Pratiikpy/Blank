import { describe, it, expect } from "vitest";
import { encryptBlob, decryptBlob } from "./burner-registry";

// §15.x lib test for the AES-256-GCM burner backup envelope. The
// passphrase-derived key is the only thing standing between an
// attacker who reads MetadataSet event data on-chain and the user's
// burner labels. The encrypt + decrypt round-trip + the wrong-
// passphrase rejection are the load-bearing invariants.

const PAYLOAD = {
  id: "b-1",
  salt: "1234567890",
  label: "Coffee fund",
  createdAt: 1_700_000_000_000,
  notes: "Pre-funded for hackathons",
};

describe("encryptBlob + decryptBlob round-trip", () => {
  it("decrypts back to the original payload with the same passphrase", async () => {
    const env = await encryptBlob(PAYLOAD, "correct horse battery staple");
    const out = await decryptBlob(env, "correct horse battery staple");
    expect(out).toEqual(PAYLOAD);
  });

  it("decrypt fails on a wrong passphrase (AES-GCM auth-tag mismatch)", async () => {
    const env = await encryptBlob(PAYLOAD, "passphrase-A");
    await expect(decryptBlob(env, "passphrase-B")).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it("re-encrypting the same payload twice produces different ciphertexts (fresh salt + nonce)", async () => {
    // Without fresh salt + nonce, the ciphertext would leak whether
    // the user's burner list has changed (an attacker observing two
    // event posts could tell). The randomization is a privacy
    // property, not just correctness.
    const a = await encryptBlob(PAYLOAD, "shared-passphrase");
    const b = await encryptBlob(PAYLOAD, "shared-passphrase");
    expect(a).not.toBe(b);
    // Both still decrypt to the same value:
    expect(await decryptBlob(a, "shared-passphrase")).toEqual(PAYLOAD);
    expect(await decryptBlob(b, "shared-passphrase")).toEqual(PAYLOAD);
  });

  it("rejects empty / too-short passphrase at encrypt time", async () => {
    await expect(encryptBlob(PAYLOAD, "")).rejects.toThrow(
      /at least 6 characters/,
    );
    await expect(encryptBlob(PAYLOAD, "12345")).rejects.toThrow(
      /at least 6 characters/,
    );
  });

  it("rejects a truncated envelope", async () => {
    await expect(decryptBlob("0xdeadbeef", "anything")).rejects.toThrow(
      /Ciphertext truncated/,
    );
  });

  it("rejects an unknown version byte", async () => {
    const env = await encryptBlob(PAYLOAD, "passphrase-X");
    // Replace the 1-byte version prefix (after "0x") with a non-1 value.
    // Real envelope: "0x01<salt><nonce><ct>". Replacing 01 → ff is
    // enough to trigger the "Unknown ciphertext version" branch
    // before the AES-GCM auth check.
    const tampered = "0xff" + env.slice(4);
    await expect(decryptBlob(tampered, "passphrase-X")).rejects.toThrow(
      /Unknown ciphertext version/,
    );
  });

  it("preserves all payload fields including optional notes", async () => {
    const minimal = { id: "x", salt: "0", label: "L", createdAt: 1 };
    const env = await encryptBlob(minimal, "mypassphrase");
    expect(await decryptBlob(env, "mypassphrase")).toEqual(minimal);
  });
});
