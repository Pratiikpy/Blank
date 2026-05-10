import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptPrivateKey, decryptPrivateKey } from "./session-keys-store.js";

// §15.x server-side test for the session-key AES-GCM envelope.
// SECURITY: this is the encryption layer protecting raw session
// private keys at rest in Supabase. Compromise of the DB row
// alone is NOT enough to forge UserOps; an attacker also needs
// the env master key. Pin the round-trip + truncation rejection.

const MASTER_KEY = "00112233445566778899aabbccddeeff" + "00112233445566778899aabbccddeeff";
const RAW_PK = "deadbeef" + "00".repeat(28); // 32 bytes hex

beforeEach(() => {
  process.env.SESSION_KEYS_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.SESSION_KEYS_MASTER_KEY;
});

describe("encryptPrivateKey + decryptPrivateKey", () => {
  it("round-trips the hex private key with the master key", async () => {
    const env = await encryptPrivateKey(RAW_PK);
    const out = await decryptPrivateKey(env);
    expect(out).toBe(RAW_PK);
  });

  it("accepts 0x-prefixed input on encrypt", async () => {
    const env = await encryptPrivateKey("0x" + RAW_PK);
    const out = await decryptPrivateKey(env);
    expect(out).toBe(RAW_PK);
  });

  it("re-encrypting the same key produces DIFFERENT ciphertext (fresh nonce)", async () => {
    // Without fresh nonce, an attacker observing two stored rows
    // for the same user could detect that they're the same key.
    // The randomization is a privacy property.
    const a = await encryptPrivateKey(RAW_PK);
    const b = await encryptPrivateKey(RAW_PK);
    expect(a).not.toBe(b);
    expect(await decryptPrivateKey(a)).toBe(RAW_PK);
    expect(await decryptPrivateKey(b)).toBe(RAW_PK);
  });

  it("rejects a private key that isn't 32 bytes", async () => {
    await expect(encryptPrivateKey("00")).rejects.toThrow(/32 bytes/);
    await expect(encryptPrivateKey("00".repeat(31))).rejects.toThrow(/32 bytes/);
    await expect(encryptPrivateKey("00".repeat(33))).rejects.toThrow(/32 bytes/);
  });

  it("rejects a truncated envelope on decrypt", async () => {
    await expect(decryptPrivateKey("0x00")).rejects.toThrow(/truncated/);
  });

  it("throws when SESSION_KEYS_MASTER_KEY is unset", async () => {
    delete process.env.SESSION_KEYS_MASTER_KEY;
    await expect(encryptPrivateKey(RAW_PK)).rejects.toThrow(
      /SESSION_KEYS_MASTER_KEY/,
    );
  });

  it("throws when master key has wrong length (not 32 bytes)", async () => {
    process.env.SESSION_KEYS_MASTER_KEY = "00".repeat(16);
    await expect(encryptPrivateKey(RAW_PK)).rejects.toThrow(/32 bytes/);
  });

  it("decrypt fails with a different master key (auth-tag mismatch)", async () => {
    const env = await encryptPrivateKey(RAW_PK);
    process.env.SESSION_KEYS_MASTER_KEY = "ff".repeat(32);
    await expect(decryptPrivateKey(env)).rejects.toThrow();
  });
});
