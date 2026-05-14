import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  storeSessionKey,
  markRevoked,
  listActiveKeysForChain,
  signWithSessionKey,
} from "./session-keys-store.js";
import { getSupabaseAdmin } from "./supabase-admin.js";

vi.mock("./supabase-admin.js", () => ({
  getSupabaseAdmin: vi.fn(),
}));

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

  it("master key with 0x prefix is accepted (canonical hex representation)", async () => {
    process.env.SESSION_KEYS_MASTER_KEY = "0x" + MASTER_KEY;
    const env = await encryptPrivateKey(RAW_PK);
    expect(await decryptPrivateKey(env)).toBe(RAW_PK);
  });
});

// §15.x extension: storeSessionKey + markRevoked +
// listActiveKeysForChain + signWithSessionKey. These are the
// supabase-bound paths that get NO coverage from the existing
// crypto-only test. A regression in any of them would either
// silently fail to persist a fresh session key (cron fires never
// happen) or fail to mark revoked rows (cron wastes RPC reads on
// dead scopes) or, worst case, sign for the wrong account (forged
// UserOps for someone else's smart wallet).

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE_LOWER = ALICE.toLowerCase();
const SESSION_KEY = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SESSION_KEY_LOWER = SESSION_KEY.toLowerCase();
const RECIPIENT = "0xCccccccccccccccccccccccccccccccccccccccc";
const SPEND_TOKEN = "0xDddddddddddddddddddddddddddddddddddddddd";
const CHAIN_ID = 11155111;

function mockSupabaseUpsert(error: { message: string } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error });
  const from = vi.fn(() => ({ upsert }));
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return { from, upsert };
}

function mockSupabaseUpdate() {
  const eq3 = vi.fn().mockResolvedValue({ error: null });
  const eq2 = vi.fn(() => ({ eq: eq3 }));
  const eq1 = vi.fn(() => ({ eq: eq2 }));
  const update = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn(() => ({ update }));
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return { from, update, eq1, eq2, eq3 };
}

function mockSupabaseSelect(returnValue: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(returnValue);
  const isMethod = vi.fn(() => ({ order }));
  const eq = vi.fn(() => ({ is: isMethod }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return { from, select, eq, is: isMethod, order };
}

describe("storeSessionKey", () => {
  beforeEach(() => {
    vi.mocked(getSupabaseAdmin).mockReset();
  });

  it("upserts the encrypted row with lowercased account + session_key + recipient + spend_token", async () => {
    const { from, upsert } = mockSupabaseUpsert();
    await storeSessionKey({
      account: ALICE,
      sessionKey: SESSION_KEY,
      privateKeyHex: RAW_PK,
      chainId: CHAIN_ID,
      label: "test scope",
      recipient: RECIPIENT,
      spendToken: SPEND_TOKEN,
    });
    expect(from).toHaveBeenCalledWith("session_keys");
    expect(upsert).toHaveBeenCalledTimes(1);
    const row = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.account).toBe(ALICE_LOWER);
    expect(row.session_key).toBe(SESSION_KEY_LOWER);
    expect(row.recipient).toBe(RECIPIENT.toLowerCase());
    expect(row.spend_token).toBe(SPEND_TOKEN.toLowerCase());
    expect(row.chain_id).toBe(CHAIN_ID);
    expect(row.label).toBe("test scope");
    expect(row.revoked_at).toBeNull();
    // encrypted_private_key is hex, NOT the raw private key.
    expect(typeof row.encrypted_private_key).toBe("string");
    expect(row.encrypted_private_key).not.toContain(RAW_PK);
  });

  it("truncates labels longer than 64 characters (storage cap)", async () => {
    const { upsert } = mockSupabaseUpsert();
    const longLabel = "x".repeat(200);
    await storeSessionKey({
      account: ALICE,
      sessionKey: SESSION_KEY,
      privateKeyHex: RAW_PK,
      chainId: CHAIN_ID,
      label: longLabel,
      recipient: RECIPIENT,
      spendToken: SPEND_TOKEN,
    });
    const row = upsert.mock.calls[0]![0] as { label: string };
    expect(row.label.length).toBe(64);
    expect(row.label).toBe("x".repeat(64));
  });

  it("uses onConflict='account,session_key,chain_id' (per-chain idempotency)", async () => {
    const { upsert } = mockSupabaseUpsert();
    await storeSessionKey({
      account: ALICE,
      sessionKey: SESSION_KEY,
      privateKeyHex: RAW_PK,
      chainId: CHAIN_ID,
      label: "x",
      recipient: RECIPIENT,
      spendToken: SPEND_TOKEN,
    });
    const opts = upsert.mock.calls[0]![1] as { onConflict: string };
    expect(opts.onConflict).toBe("account,session_key,chain_id");
  });

  it("throws when getSupabaseAdmin returns null (env not configured)", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(null);
    await expect(
      storeSessionKey({
        account: ALICE,
        sessionKey: SESSION_KEY,
        privateKeyHex: RAW_PK,
        chainId: CHAIN_ID,
        label: "x",
        recipient: RECIPIENT,
        spendToken: SPEND_TOKEN,
      }),
    ).rejects.toThrow(/Supabase admin not configured/);
  });

  it("throws when supabase upsert returns an error (surface the message)", async () => {
    mockSupabaseUpsert({ message: "row-level security violation" });
    await expect(
      storeSessionKey({
        account: ALICE,
        sessionKey: SESSION_KEY,
        privateKeyHex: RAW_PK,
        chainId: CHAIN_ID,
        label: "x",
        recipient: RECIPIENT,
        spendToken: SPEND_TOKEN,
      }),
    ).rejects.toThrow(/session_keys upsert failed.*row-level security/);
  });
});

describe("markRevoked", () => {
  beforeEach(() => {
    vi.mocked(getSupabaseAdmin).mockReset();
  });

  it("issues an update with revoked_at + updated_at, keyed by (account, session_key, chain_id)", async () => {
    const { from, update, eq1, eq2, eq3 } = mockSupabaseUpdate();
    await markRevoked({ account: ALICE, sessionKey: SESSION_KEY, chainId: CHAIN_ID });
    expect(from).toHaveBeenCalledWith("session_keys");
    const updatePayload = update.mock.calls[0]![0] as { revoked_at: unknown; updated_at: unknown };
    expect(updatePayload.revoked_at).toEqual(expect.any(String));
    expect(updatePayload.updated_at).toEqual(expect.any(String));
    // 3 chained .eq calls keyed by lowercased values.
    expect(eq1).toHaveBeenCalledWith("account", ALICE_LOWER);
    expect(eq2).toHaveBeenCalledWith("session_key", SESSION_KEY_LOWER);
    expect(eq3).toHaveBeenCalledWith("chain_id", CHAIN_ID);
  });

  it("silently returns (no throw) when getSupabaseAdmin returns null", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(null);
    // Source: `if (!supa) return;` — no throw on missing config. This
    // is intentional because markRevoked is called from a best-effort
    // soft-delete path (the cron tick still skips dead scopes via
    // the listActiveKeysForChain `revoked_at is null` filter).
    await expect(
      markRevoked({ account: ALICE, sessionKey: SESSION_KEY, chainId: CHAIN_ID }),
    ).resolves.toBeUndefined();
  });
});

describe("listActiveKeysForChain", () => {
  beforeEach(() => {
    vi.mocked(getSupabaseAdmin).mockReset();
  });

  it("returns empty array when getSupabaseAdmin returns null", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(null);
    const out = await listActiveKeysForChain(CHAIN_ID);
    expect(out).toEqual([]);
  });

  it("returns mapped rows with camelCase keys (DB columns -> JS field names)", async () => {
    mockSupabaseSelect({
      data: [
        {
          account: ALICE_LOWER,
          session_key: SESSION_KEY_LOWER,
          label: "scope-1",
          recipient: RECIPIENT.toLowerCase(),
          spend_token: SPEND_TOKEN.toLowerCase(),
          encrypted_private_key: "deadbeef",
        },
      ],
      error: null,
    });
    const out = await listActiveKeysForChain(CHAIN_ID);
    expect(out).toEqual([
      {
        account: ALICE_LOWER,
        sessionKey: SESSION_KEY_LOWER,
        label: "scope-1",
        recipient: RECIPIENT.toLowerCase(),
        spendToken: SPEND_TOKEN.toLowerCase(),
        encryptedPrivateKey: "deadbeef",
      },
    ]);
  });

  it("filters by chain_id AND revoked_at IS NULL (the cron skip-revoked invariant)", async () => {
    const { eq, is } = mockSupabaseSelect({ data: [], error: null });
    await listActiveKeysForChain(CHAIN_ID);
    expect(eq).toHaveBeenCalledWith("chain_id", CHAIN_ID);
    expect(is).toHaveBeenCalledWith("revoked_at", null);
  });

  it("defaults label to empty string when DB row has null label (no undefined leak)", async () => {
    mockSupabaseSelect({
      data: [
        {
          account: ALICE_LOWER,
          session_key: SESSION_KEY_LOWER,
          label: null,
          recipient: RECIPIENT.toLowerCase(),
          spend_token: SPEND_TOKEN.toLowerCase(),
          encrypted_private_key: "deadbeef",
        },
      ],
      error: null,
    });
    const out = await listActiveKeysForChain(CHAIN_ID);
    expect(out[0]!.label).toBe("");
  });

  it("throws when supabase returns an error (cron tick fails loudly, doesn't silently skip)", async () => {
    mockSupabaseSelect({ data: null, error: { message: "connection refused" } });
    await expect(listActiveKeysForChain(CHAIN_ID)).rejects.toThrow(
      /session_keys list failed.*connection refused/,
    );
  });
});

describe("signWithSessionKey", () => {
  it("decrypts + signs a digest with the recovered private key (round-trip)", async () => {
    // Build a known wallet so we can verify the signature.
    const wallet = new ethers.Wallet("0x" + RAW_PK);
    const encrypted = await encryptPrivateKey(RAW_PK);
    // Sign a known digest (32 bytes).
    const digest = ethers.keccak256(ethers.toUtf8Bytes("test message"));
    const sig = await signWithSessionKey({
      encryptedPrivateKey: encrypted,
      digest,
    });
    // Recover the signer from the digest + signature.
    const recovered = ethers.recoverAddress(digest, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("produces a 132-char (65-byte + 0x) hex signature for any 32-byte digest", async () => {
    const encrypted = await encryptPrivateKey(RAW_PK);
    const digest = "0x" + "aa".repeat(32);
    const sig = await signWithSessionKey({ encryptedPrivateKey: encrypted, digest });
    // 65 bytes = r(32) + s(32) + v(1) = 130 hex + "0x" = 132.
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("a different digest produces a different signature (basic cryptographic property)", async () => {
    const encrypted = await encryptPrivateKey(RAW_PK);
    const sigA = await signWithSessionKey({
      encryptedPrivateKey: encrypted,
      digest: "0x" + "aa".repeat(32),
    });
    const sigB = await signWithSessionKey({
      encryptedPrivateKey: encrypted,
      digest: "0x" + "bb".repeat(32),
    });
    expect(sigA).not.toBe(sigB);
  });

  it("throws when the encrypted envelope is corrupted (auth-tag mismatch protection)", async () => {
    const encrypted = await encryptPrivateKey(RAW_PK);
    // Corrupt one byte in the middle (after the nonce, inside the ciphertext).
    const corrupted = encrypted.slice(0, 60) + (encrypted[60] === "0" ? "1" : "0") + encrypted.slice(61);
    await expect(
      signWithSessionKey({
        encryptedPrivateKey: corrupted,
        digest: "0x" + "aa".repeat(32),
      }),
    ).rejects.toThrow();
  });
});
