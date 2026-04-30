/**
 * Stealth meta-address keystore — passphrase-encrypted at rest.
 *
 * The earlier shape stored `spendingPrivateKey` and `viewingPrivateKey`
 * as plaintext localStorage. Anyone with browser access (rogue extension,
 * exfiltrated localStorage backup, in-page XSS) could reconstruct the
 * meta-address and sweep funds. This module replaces that with WebCrypto
 * AES-GCM-at-rest using a passphrase-derived key (PBKDF2-SHA-256, 250k
 * iterations).
 *
 * Sync-vs-async API
 * -----------------
 * The previous module was sync. WebCrypto is async, so we split the API:
 *
 *   • `unlockStealthKeys(address, passphrase)` — async; decrypts the
 *      stored record and caches the plaintext in module memory for the
 *      session. Call once when the user enters a stealth-protected screen.
 *   • `loadStealthKeys(address)` — sync; reads the in-memory cache. Returns
 *      null if `unlockStealthKeys` hasn't been called yet this session.
 *      Existing call sites stay sync.
 *   • `saveStealthKeysAsync(address, record, passphrase)` — async; encrypts
 *      and persists. Caches the plaintext on success.
 *
 * Migration
 * ---------
 * Records written by the previous (plaintext) shape are auto-detected on
 * unlock. We move them through the unlock cache and re-persist encrypted
 * on the next save — so a user who lands on a screen that calls unlock
 * with their existing passphrase silently upgrades their on-disk record.
 */
import { type Address } from "viem";
import { STORAGE_KEYS } from "./storage";
import {
  metaAddressFromPrivKeys,
  parseMetaAddress,
  type StealthMetaAddress,
} from "./stealth";

export interface StealthKeyRecord {
  spendingPrivateKey: `0x${string}`;
  viewingPrivateKey: `0x${string}`;
  metaAddress: StealthMetaAddress;
  publishedAt?: number;
  publishTxHash?: `0x${string}`;
}

interface EncryptedEnvelope {
  v: 1;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const sessionCache = new Map<string, StealthKeyRecord>();

function lc(addr: Address | string): string {
  return String(addr).toLowerCase();
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptRecord(
  passphrase: string,
  record: StealthKeyRecord,
): Promise<EncryptedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(record)) as BufferSource,
  );
  return {
    v: 1,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ctBuf)),
  };
}

async function decryptEnvelope(
  passphrase: string,
  env: EncryptedEnvelope,
): Promise<StealthKeyRecord> {
  const key = await deriveKey(passphrase, fromB64(env.salt));
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(env.iv) as BufferSource },
    key,
    fromB64(env.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(ptBuf)) as StealthKeyRecord;
}

function isEnvelope(x: unknown): x is EncryptedEnvelope {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as Record<string, unknown>).v === 1 &&
    typeof (x as Record<string, unknown>).salt === "string" &&
    typeof (x as Record<string, unknown>).iv === "string" &&
    typeof (x as Record<string, unknown>).ct === "string"
  );
}

function readRaw(mainAddress: Address | string): unknown | null {
  const raw = window.localStorage.getItem(STORAGE_KEYS.stealthKeys(mainAddress));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Decrypts the stored record (or migrates a legacy plaintext record) and
 *  caches the plaintext in module memory for the rest of the session.
 *  Returns null if nothing is stored. Throws on wrong passphrase. */
export async function unlockStealthKeys(
  mainAddress: Address | string,
  passphrase: string,
): Promise<StealthKeyRecord | null> {
  if (!mainAddress) return null;
  const k = lc(mainAddress);

  const cached = sessionCache.get(k);
  if (cached) return cached;

  const raw = readRaw(mainAddress);
  if (!raw) return null;

  if (isEnvelope(raw)) {
    const rec = await decryptEnvelope(passphrase, raw);
    sessionCache.set(k, rec);
    return rec;
  }

  // Legacy plaintext — migrate. Cache the plaintext so the caller can
  // proceed; re-persist encrypted in the background. If the migration
  // write fails we still surface the keys this session — the next save
  // (e.g. publishedAt update) will encrypt then.
  const legacy = raw as StealthKeyRecord;
  sessionCache.set(k, legacy);
  void encryptRecord(passphrase, legacy).then((env) => {
    window.localStorage.setItem(
      STORAGE_KEYS.stealthKeys(mainAddress),
      JSON.stringify(env),
    );
  });
  return legacy;
}

/** Sync read from the in-session cache. Returns null if `unlockStealthKeys`
 *  hasn't been called yet — the caller should treat that as "locked, prompt
 *  the user for their passphrase". */
export function loadStealthKeys(mainAddress: Address | string): StealthKeyRecord | null {
  if (!mainAddress) return null;
  return sessionCache.get(lc(mainAddress)) ?? null;
}

/** True iff a stored record exists for the given address (encrypted or
 *  legacy). Lets a UI decide whether to prompt for a passphrase or send
 *  the user to the setup flow. */
export function hasStealthKeysStored(mainAddress: Address | string): boolean {
  return readRaw(mainAddress) !== null;
}

export async function saveStealthKeysAsync(
  mainAddress: Address | string,
  record: StealthKeyRecord,
  passphrase: string,
): Promise<boolean> {
  if (!mainAddress) return false;
  const derived = metaAddressFromPrivKeys({
    spendingPrivateKey: record.spendingPrivateKey,
    viewingPrivateKey: record.viewingPrivateKey,
  });
  if (derived.metaAddress !== record.metaAddress) {
    throw new Error(
      "Stealth keystore: metaAddress doesn't match the privkey-derived meta-address",
    );
  }
  const env = await encryptRecord(passphrase, record);
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.stealthKeys(mainAddress),
      JSON.stringify(env),
    );
  } catch {
    return false;
  }
  sessionCache.set(lc(mainAddress), record);
  return true;
}

export function clearStealthKeys(mainAddress: Address | string): void {
  if (!mainAddress) return;
  window.localStorage.removeItem(STORAGE_KEYS.stealthKeys(mainAddress));
  sessionCache.delete(lc(mainAddress));
}

export function pubKeysFromRecord(record: StealthKeyRecord): {
  spendingPubKey: `0x${string}`;
  viewingPubKey: `0x${string}`;
} {
  return parseMetaAddress(record.metaAddress);
}
