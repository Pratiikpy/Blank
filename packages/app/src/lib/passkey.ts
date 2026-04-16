// Noble v2 layout: p256 is exported from /nist (covers all NIST curves).
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// ─────────────────────────────────────────────────────────────────────
//  passkey — P-256 keypair stored encrypted at rest in IndexedDB.
//
//  Key generation: @noble/curves/p256 — secp256r1, 32-byte private key,
//  64-byte uncompressed pubkey (32 each for x and y).
//
//  Encryption: Web Crypto AES-256-GCM with a key derived from the user's
//  passphrase via PBKDF2 (250K iterations). The derived key never leaves
//  Web Crypto's opaque handles. The encrypted blob + salt + iv are stored
//  in IndexedDB; the passphrase is required to unlock for every signature.
//
//  Storage: IndexedDB instead of localStorage so the encrypted blob can be
//  large + survives across sessions but is per-origin-isolated. One key
//  per chain (chainId scoped) so a user can have separate AA addresses
//  on Eth Sepolia vs Base Sepolia if they want.
//
//  This is the "smart wallet" key flow — separate from the user's primary
//  wallet (MetaMask). It's what BlankAccount._validateSignature verifies.
// ─────────────────────────────────────────────────────────────────────

const DB_NAME = "blank_passkey";
const STORE_NAME = "keys";
const PBKDF2_ITERATIONS = 250_000;

export interface PasskeyRecord {
  /** P-256 pubkey x coordinate as a 0x-hex bigint string */
  pubX: `0x${string}`;
  /** P-256 pubkey y coordinate */
  pubY: `0x${string}`;
  /** Encrypted private key blob (AES-GCM ciphertext) */
  encryptedPrivKey: string;
  /** AES-GCM IV (base64) */
  iv: string;
  /** PBKDF2 salt (base64) */
  salt: string;
  /** Chain id this key was created for */
  chainId: number;
  /** Optional human label */
  label?: string;
  createdAt: number;
}

// ─── IndexedDB helpers ──────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "chainId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(chainId: number): Promise<PasskeyRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(chainId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record: PasskeyRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(chainId: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(chainId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Crypto helpers ─────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesGcmEncrypt(
  passphrase: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { ciphertext: b64encode(new Uint8Array(ctBuf)), iv: b64encode(iv), salt: b64encode(salt) };
}

async function aesGcmDecrypt(
  passphrase: string,
  record: Pick<PasskeyRecord, "encryptedPrivKey" | "iv" | "salt">,
): Promise<Uint8Array> {
  const salt = b64decode(record.salt);
  const iv = b64decode(record.iv);
  const ct = b64decode(record.encryptedPrivKey);
  const key = await deriveAesKey(passphrase, salt);
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new Uint8Array(ptBuf);
}

// ─── Public API ─────────────────────────────────────────────────────

/** Whether a passkey already exists for this chain. */
export async function hasPasskey(chainId: number): Promise<boolean> {
  try {
    const rec = await dbGet(chainId);
    return rec !== null;
  } catch {
    return false;
  }
}

/** Read the public keypair for this chain (no passphrase needed). */
export async function getPasskeyPubkey(
  chainId: number,
): Promise<{ pubX: `0x${string}`; pubY: `0x${string}` } | null> {
  const rec = await dbGet(chainId);
  if (!rec) return null;
  return { pubX: rec.pubX, pubY: rec.pubY };
}

/**
 * Generate a new P-256 keypair and store it encrypted with the user's
 * passphrase. Throws if a key already exists for this chain — caller
 * should call deletePasskey first if reset is intended.
 */
export async function createPasskey(
  chainId: number,
  passphrase: string,
  label?: string,
): Promise<{ pubX: `0x${string}`; pubY: `0x${string}` }> {
  if (await hasPasskey(chainId)) {
    throw new Error("passkey already exists for this chain — delete it first");
  }
  if (passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }

  const privBytes = p256.utils.randomSecretKey();
  const pubBytes = p256.getPublicKey(privBytes, false); // uncompressed: 0x04 || x(32) || y(32)
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error("unexpected pubkey format");
  }
  const pubX = ("0x" + bytesToHex(pubBytes.slice(1, 33))) as `0x${string}`;
  const pubY = ("0x" + bytesToHex(pubBytes.slice(33, 65))) as `0x${string}`;

  const enc = await aesGcmEncrypt(passphrase, privBytes);

  await dbPut({
    pubX,
    pubY,
    encryptedPrivKey: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
    chainId,
    label,
    createdAt: Date.now(),
  });

  return { pubX, pubY };
}

/**
 * Sign a 32-byte hash with the stored P-256 key. Returns (r, s) as
 * 0x-hex bigints so the caller can abi.encode them for BlankAccount's
 * _validateSignature.
 */
export async function signHash(
  chainId: number,
  passphrase: string,
  hash: `0x${string}`,
): Promise<{ r: `0x${string}`; s: `0x${string}` }> {
  const rec = await dbGet(chainId);
  if (!rec) throw new Error("no passkey for this chain");

  const privBytes = await aesGcmDecrypt(passphrase, rec);
  const hashBytes = hexToBytes(hash.startsWith("0x") ? hash.slice(2) : hash);
  if (hashBytes.length !== 32) throw new Error("hash must be 32 bytes");

  // p256.sign returns compact-format bytes (r||s, 64 bytes total) with
  // low-s normalization by default.
  //
  // CRITICAL: `prehash: false` is non-negotiable here. Noble's default is
  // `prehash: true`, which means it re-hashes the input via SHA-256 before
  // signing. We pass an already-computed digest (userOpHash, EIP-712 hash,
  // etc.) so re-hashing produces a sig over `sha256(digest)` instead of
  // `digest` — which the on-chain verifiers (RIP-7212 precompile, Daimo
  // p256-verifier, BlankAccount.P256.verify) reject because they verify
  // against the RAW digest. Signing with prehash:false preserves the
  // canonical "sign the 32-byte hash you were handed" semantics.
  const sigBytes = p256.sign(hashBytes, privBytes, { prehash: false });
  if (sigBytes.length < 64) throw new Error("unexpected signature length");
  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  return {
    r: ("0x" + bytesToHex(r)) as `0x${string}`,
    s: ("0x" + bytesToHex(s)) as `0x${string}`,
  };
}

/** Delete the passkey for this chain. Irreversible — the user loses access. */
export async function deletePasskey(chainId: number): Promise<void> {
  await dbDelete(chainId);
}

/** Verify a passphrase by attempting to decrypt — useful for unlock prompts. */
export async function verifyPassphrase(chainId: number, passphrase: string): Promise<boolean> {
  const rec = await dbGet(chainId);
  if (!rec) return false;
  try {
    await aesGcmDecrypt(passphrase, rec);
    return true;
  } catch {
    return false;
  }
}

// Tiny helper that hashes a message with sha256 — used by tests and any
// caller that wants a 32-byte hash for signHash.
export function sha256Hex(data: Uint8Array | string): `0x${string}` {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return ("0x" + bytesToHex(sha256(bytes))) as `0x${string}`;
}

/**
 * E2E-only helper: import a known P-256 private key as the passkey for a
 * given chain. Used by Phase 2 tests so the test browser talks to a
 * PRE-FUNDED smart account (whose address was pre-computed in the setup
 * script). Without this, every test run would create a fresh passkey →
 * fresh smart account → needs re-funding → slow.
 *
 * Flow: hex private key → AES-GCM encrypt with passphrase → IndexedDB.
 * Same shape as createPasskey() produces, so every downstream path
 * (useSmartAccount, signHash) works unchanged.
 *
 * NOT for production use. Exported with a leading underscore so it's
 * clear this bypasses random-key generation.
 */
export async function _testImportPasskey(
  chainId: number,
  privKeyHex: string,
  passphrase: string,
  label?: string,
): Promise<{ pubX: `0x${string}`; pubY: `0x${string}` }> {
  const clean = privKeyHex.startsWith("0x") ? privKeyHex.slice(2) : privKeyHex;
  if (clean.length !== 64) throw new Error("privKeyHex must be 32 bytes (64 hex chars)");
  const privBytes = hexToBytes(clean);
  const pubBytes = p256.getPublicKey(privBytes, false);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error("unexpected pubkey format");
  }
  const pubX = ("0x" + bytesToHex(pubBytes.slice(1, 33))) as `0x${string}`;
  const pubY = ("0x" + bytesToHex(pubBytes.slice(33, 65))) as `0x${string}`;
  const enc = await aesGcmEncrypt(passphrase, privBytes);
  await dbPut({
    pubX,
    pubY,
    encryptedPrivKey: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
    chainId,
    label: label ?? "e2e-import",
    createdAt: Date.now(),
  });
  return { pubX, pubY };
}

/**
 * Verify a P-256 signature with pure JS math — same curve, same equations
 * that BlankAccount.P256Verifier runs on-chain (either via RIP-7212
 * precompile on Base or daimo Solidity verifier on Sepolia). Used by
 * e2e tests to prove the signature encoding round-trip works before
 * committing to an on-chain verification call.
 */
export function verifyP256(
  hash: `0x${string}`,
  r: `0x${string}`,
  s: `0x${string}`,
  pubX: `0x${string}`,
  pubY: `0x${string}`,
): boolean {
  const toBytes = (hex: string, len: number): Uint8Array => {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const padded = clean.padStart(len * 2, "0");
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const hashBytes = toBytes(hash, 32);
  const compactSig = new Uint8Array(64);
  compactSig.set(toBytes(r, 32), 0);
  compactSig.set(toBytes(s, 32), 32);
  const pubKey = new Uint8Array(65);
  pubKey[0] = 0x04;
  pubKey.set(toBytes(pubX, 32), 1);
  pubKey.set(toBytes(pubY, 32), 33);
  try {
    // Match the signing path: verify the raw digest, no re-hashing.
    // Default `prehash:true` in noble would treat hashBytes as a message
    // to hash — fine in isolation but breaks consistency with the on-
    // chain verifiers that operate on the raw digest.
    return p256.verify(compactSig, hashBytes, pubKey, { prehash: false });
  } catch {
    return false;
  }
}
