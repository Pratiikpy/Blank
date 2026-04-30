/**
 * Phase 4.1 — server-held session-key keystore.
 *
 * AES-GCM encrypted at-rest in Supabase. The master key is a 32-byte
 * env-stored value (`SESSION_KEYS_MASTER_KEY`, hex). Compromise of the
 * Supabase row alone is NOT enough to forge UserOps — an attacker also
 * needs the env master key.
 *
 * Compromise of the master key (e.g. Vercel team-level access) IS
 * enough to forge UserOps for every stored scope. That's an explicit
 * trade-off documented up-front. Real KMS-grade storage (per-key HSM
 * or AWS KMS GenerateDataKey) is the right next step but out of scope
 * for the testnet MVP.
 *
 * Key rotation: NOT supported in this MVP. Rotating the master key
 * means re-encrypting every row (cron downtime + careful replay
 * protection). Documented as a follow-up.
 *
 * Threat model:
 *   • Read-only DB compromise → ciphertext unreadable, scopes safe
 *   • Write DB compromise → attacker can poison rows, but on-chain
 *     `setScope` writes are signed by the user's passkey, so they
 *     can't pivot to draining funds — they can only break cron firing
 *     by overwriting ciphertext (DOS, not theft)
 *   • Master key + DB compromise → full compromise of all stored scopes
 *     (attacker can sign UserOps within the on-chain scope, which is
 *     bounded by maxAmountPerCall + periodSeconds + validUntil)
 *
 * Scope bounding is the load-bearing safety: even with full key
 * compromise, attacker is limited to scope.maxAmountPerCall per fire,
 * scope.periodSeconds between fires, and only to scope.recipient.
 */

import { ethers } from "ethers";
import { getSupabaseAdmin } from "./supabase-admin.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PRIVATE_KEY_BYTES = 32;
const MASTER_KEY_HEX_LEN = 64; // 32 bytes hex

export interface StoredSessionKey {
  account: string;
  sessionKey: string;
  chainId: number;
  label: string;
  recipient: string;
  spendToken: string;
  revoked: boolean;
  createdAt: string;
}

function getMasterKey(): Buffer {
  const hex = process.env.SESSION_KEYS_MASTER_KEY;
  if (!hex) {
    throw new Error(
      "SESSION_KEYS_MASTER_KEY env var unset — generate via `openssl rand -hex 32` and set in Vercel project env",
    );
  }
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length !== MASTER_KEY_HEX_LEN) {
    throw new Error(
      `SESSION_KEYS_MASTER_KEY must be exactly 32 bytes (${MASTER_KEY_HEX_LEN} hex chars); got ${cleaned.length}`,
    );
  }
  return Buffer.from(cleaned, "hex");
}

async function importAesGcmKey(masterKey: Buffer): Promise<CryptoKey> {
  // Node 18+ exposes Web Crypto via globalThis.crypto.
  return crypto.subtle.importKey(
    "raw",
    masterKey as unknown as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a 32-byte raw private key with the server master key.
 *  Envelope: hex(nonce || ciphertext || tag) — Web Crypto's AES-GCM
 *  encrypt returns ciphertext+tag concatenated, so we just prepend nonce. */
export async function encryptPrivateKey(privateKeyHex: string): Promise<string> {
  const cleaned = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
  const raw = Buffer.from(cleaned, "hex");
  if (raw.length !== PRIVATE_KEY_BYTES) {
    throw new Error("private key must be 32 bytes");
  }
  const masterKey = getMasterKey();
  const aesKey = await importAesGcmKey(masterKey);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      raw as unknown as BufferSource,
    ),
  );
  // Concat: nonce || (ciphertext+tag)
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return Buffer.from(out).toString("hex");
}

/** Decrypt and return the private key hex (NOT prefixed with 0x — caller
 *  prepends if needed). NEVER log this value. */
export async function decryptPrivateKey(envelopeHex: string): Promise<string> {
  const cleaned = envelopeHex.startsWith("0x") ? envelopeHex.slice(2) : envelopeHex;
  const bytes = Buffer.from(cleaned, "hex");
  if (bytes.length < NONCE_BYTES + TAG_BYTES + PRIVATE_KEY_BYTES) {
    throw new Error("envelope truncated");
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const cipherAndTag = bytes.subarray(NONCE_BYTES);
  const masterKey = getMasterKey();
  const aesKey = await importAesGcmKey(masterKey);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource },
      aesKey,
      cipherAndTag as unknown as BufferSource,
    ),
  );
  if (plain.length !== PRIVATE_KEY_BYTES) {
    throw new Error("decrypted plaintext has unexpected length");
  }
  return Buffer.from(plain).toString("hex");
}

/** Persist a freshly-generated session key. Caller must have already
 *  validated the inputs (account/sessionKey shape, chain support). */
export async function storeSessionKey(args: {
  account: string;
  sessionKey: string;
  privateKeyHex: string;
  chainId: number;
  label: string;
  recipient: string;
  spendToken: string;
}): Promise<void> {
  const supa = getSupabaseAdmin();
  if (!supa) {
    throw new Error(
      "Supabase admin not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const encrypted = await encryptPrivateKey(args.privateKeyHex);
  const { error } = await supa.from("session_keys").upsert(
    {
      account: args.account.toLowerCase(),
      session_key: args.sessionKey.toLowerCase(),
      chain_id: args.chainId,
      encrypted_private_key: encrypted,
      label: args.label.slice(0, 64),
      recipient: args.recipient.toLowerCase(),
      spend_token: args.spendToken.toLowerCase(),
      revoked_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account,session_key,chain_id" },
  );
  if (error) {
    throw new Error(`session_keys upsert failed: ${error.message}`);
  }
}

/** Mark a session key as revoked. The cron tick skips revoked rows.
 *  On-chain revocation is independent — this is just the soft-delete
 *  optimization so the cron doesn't waste RPC reads on dead scopes. */
export async function markRevoked(args: {
  account: string;
  sessionKey: string;
  chainId: number;
}): Promise<void> {
  const supa = getSupabaseAdmin();
  if (!supa) return;
  await supa
    .from("session_keys")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("account", args.account.toLowerCase())
    .eq("session_key", args.sessionKey.toLowerCase())
    .eq("chain_id", args.chainId);
}

/** Cron tick query: load all NOT-revoked session keys for a chain.
 *  Returns ciphertext blobs alongside metadata; caller decrypts as
 *  needed (lazy — most ticks won't fire every scope). */
export async function listActiveKeysForChain(chainId: number): Promise<
  Array<{
    account: string;
    sessionKey: string;
    label: string;
    recipient: string;
    spendToken: string;
    encryptedPrivateKey: string;
  }>
> {
  const supa = getSupabaseAdmin();
  if (!supa) return [];
  const { data, error } = await supa
    .from("session_keys")
    .select(
      "account, session_key, label, recipient, spend_token, encrypted_private_key",
    )
    .eq("chain_id", chainId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`session_keys list failed: ${error.message}`);
  }
  return (data ?? []).map((row: Record<string, unknown>) => ({
    account: row.account as string,
    sessionKey: row.session_key as string,
    label: (row.label as string) ?? "",
    recipient: row.recipient as string,
    spendToken: row.spend_token as string,
    encryptedPrivateKey: row.encrypted_private_key as string,
  }));
}

/** Sign with a stored session key. Decrypts in-memory, signs, lets the
 *  Wallet object go out of scope so the private key is collected. The
 *  caller should NOT hold onto the returned Wallet — pass the digest
 *  to sign as input and we return the signature only. */
export async function signWithSessionKey(args: {
  encryptedPrivateKey: string;
  digest: string; // 0x-prefixed 32-byte hex
}): Promise<string> {
  const privHex = await decryptPrivateKey(args.encryptedPrivateKey);
  const wallet = new ethers.Wallet("0x" + privHex);
  const sig = wallet.signingKey.sign(args.digest);
  return sig.serialized;
}
