// Phase 6.2 frontend — encrypt/decrypt burner metadata + publish to /
// recover from BurnerRegistry on-chain. Closes the durable-backup loop
// that Phase 6.1's localStorage-only MVP couldn't provide on its own.
//
// Encryption design (testnet-grade):
//
//   • AES-256-GCM with random 12-byte nonce per encryption.
//   • Key = PBKDF2-SHA256(passphrase, randomSalt, 200_000 iters, 32 bytes).
//   • Random 32-byte salt per encryption — stored in the ciphertext envelope
//     so re-encrypting the same blob never reuses the same key/nonce pair.
//   • Envelope layout: salt(32) || nonce(12) || ciphertext || tag(16)
//
// Why passphrase, not passkey-derived: WebAuthn signatures are
// non-deterministic (counter + signature randomness in some implementations)
// so we can't reliably re-derive the same key on a fresh device just from
// the passkey. Asking the user for a passphrase to wrap the backup is the
// honest, deterministic alternative — same passphrase + new device =
// recoverable. The trade-off: users have one more secret to remember; if
// they forget it, the backup is unrecoverable (but the on-chain ciphertext
// stays useless). Localized in a single modal, surfaced once per session.
//
// Recovery flow (fresh device):
//   1. User enters passphrase (same one they used at backup time).
//   2. Filter `MetadataSet` events by their main address → list of
//      (burner, ciphertext) pairs across history. The contract events
//      include the FULL ciphertext as event data, so we never re-read
//      storage during recovery.
//   3. For each event, decrypt the ciphertext envelope to recover
//      { label, salt, notes, createdAt }.
//   4. Reconstruct the local burners[] list. Most-recent event wins for
//      each burner (handles re-set / clear-then-reset cycles).
//   5. Apply MetadataCleared events to remove burners cleared since.

import { type Address, type PublicClient, parseAbiItem } from "viem";

// Inline event types for viem's getLogs typing — `getLogs({ event: ... })`
// only narrows args correctly when the event is a literal AbiItem.
const METADATA_SET_EVENT = parseAbiItem(
  "event MetadataSet(address indexed owner, address indexed burner, bytes encryptedBlob, uint256 timestamp)",
);
const METADATA_CLEARED_EVENT = parseAbiItem(
  "event MetadataCleared(address indexed owner, address indexed burner, uint256 timestamp)",
);

/** Stored format of a burner record on-chain (after decrypt). Mirrors the
 *  client-side `BurnerRecord` shape from `useBurnerAccounts`, but JSON-safe
 *  (BigInt salt → string). */
export interface BurnerBackupPayload {
  /** Stable ID matching the localStorage record. */
  id: string;
  /** uint256 stringified — pass `BigInt(salt)` to factory.getAddress. */
  salt: string;
  /** User-facing label. */
  label: string;
  /** Unix ms. */
  createdAt: number;
  /** Optional free-form notes — reserved for future UI. */
  notes?: string;
}

const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PBKDF2_ITERATIONS = 200_000;
const KEY_BITS = 256;
const ENC_VERSION = 0x01;

/** BurnerRegistry minimal ABI surface — just what the lib calls. */
export const BurnerRegistryAbi = [
  {
    type: "function",
    name: "setMetadata",
    stateMutability: "nonpayable",
    inputs: [
      { name: "burner", type: "address" },
      { name: "encryptedBlob", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "clearMetadata",
    stateMutability: "nonpayable",
    inputs: [{ name: "burner", type: "address" }],
    outputs: [],
  },
  {
    type: "event",
    name: "MetadataSet",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "burner", type: "address", indexed: true },
      { name: "encryptedBlob", type: "bytes", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MetadataCleared",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "burner", type: "address", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// ─── Crypto primitives ───────────────────────────────────────────────────

function getCrypto(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Web Crypto API unavailable. Browser too old or non-secure context.");
  }
  return crypto.subtle;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = getCrypto();
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return ("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

function fromHex(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Public surface ──────────────────────────────────────────────────────

/** Encrypt a backup payload. Returns a hex string suitable for passing
 *  directly to BurnerRegistry.setMetadata. Each call generates a fresh
 *  salt + nonce, so re-encrypting the same payload produces a different
 *  ciphertext and never collides with prior writes. */
export async function encryptBlob(
  payload: BurnerBackupPayload,
  passphrase: string,
): Promise<`0x${string}`> {
  // 12-char minimum aligns with OWASP modern guidance. The previous
  // 6-char floor left realistic human-chosen passphrases (~12-20 bits
  // entropy) feasible to crack with GPU-accelerated PBKDF2 in hours even
  // at 200k iterations. Forward-only — existing ciphertexts in
  // BurnerRegistry stay decryptable with whatever passphrase encrypted
  // them; only new writes have to meet the higher bar.
  if (!passphrase || passphrase.length < 12) {
    throw new Error("Passphrase must be at least 12 characters");
  }
  const subtle = getCrypto();
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, plaintext as BufferSource),
  );
  // ciphertext from AES-GCM already includes the 16-byte tag at the tail,
  // so the on-disk envelope is: version(1) || salt(32) || nonce(12) || ct
  const envelope = concat(new Uint8Array([ENC_VERSION]), salt, nonce, ciphertext);
  return toHex(envelope);
}

/** Decrypt an envelope produced by encryptBlob. Returns the parsed
 *  payload. Throws on tampered ciphertext, wrong passphrase, or
 *  unsupported version byte. */
export async function decryptBlob(
  envelopeHex: string,
  passphrase: string,
): Promise<BurnerBackupPayload> {
  const subtle = getCrypto();
  const bytes = fromHex(envelopeHex);
  if (bytes.length < 1 + SALT_BYTES + NONCE_BYTES + TAG_BYTES + 1) {
    throw new Error("Ciphertext truncated");
  }
  if (bytes[0] !== ENC_VERSION) {
    throw new Error(`Unknown ciphertext version 0x${bytes[0].toString(16)}`);
  }
  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const nonce = bytes.slice(1 + SALT_BYTES, 1 + SALT_BYTES + NONCE_BYTES);
  const ciphertext = bytes.slice(1 + SALT_BYTES + NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // Wrong passphrase or tampered ciphertext — AES-GCM auth tag mismatch.
    throw new Error("Decryption failed. Wrong passphrase or corrupted backup.");
  }
  const dec = new TextDecoder();
  const json = dec.decode(plaintext);
  const parsed = JSON.parse(json) as BurnerBackupPayload;
  // Light shape check — protects against a corrupted-but-decrypted payload
  // (would only happen if an attacker had the key and substituted JSON).
  if (
    typeof parsed !== "object" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.label !== "string" ||
    typeof parsed.id !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    throw new Error("Decrypted payload has unexpected shape");
  }
  return parsed;
}

/** Recover all burner records for `mainAddress` by scanning the registry's
 *  event log. Decrypts each blob with the supplied passphrase. Records
 *  whose decryption fails are SKIPPED (not thrown) so a single corrupted
 *  blob doesn't kill the whole recovery — the caller gets a partial list
 *  plus a `failedCount` to surface to the user. */
export interface RecoverResult {
  records: BurnerBackupPayload[];
  failedCount: number;
}

export async function recoverBurnersFromEvents(args: {
  publicClient: PublicClient;
  registryAddress: Address;
  mainAddress: Address;
  passphrase: string;
  /** Block range — defaults to all history. Frontend can narrow with
   *  user-pinned starting block for huge histories. */
  fromBlock?: bigint | "earliest";
  toBlock?: bigint | "latest";
}): Promise<RecoverResult> {
  if (args.registryAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("BurnerRegistry not deployed on this chain yet");
  }

  // Latest-write-wins keyed by burner address. We track both blockNumber
  // and logIndex so that two events in the SAME block (e.g. a paymaster
  // batch that re-set the same burner twice) order by log position the
  // way the chain itself orders them — strict > on blockNumber alone
  // would silently drop the later event in the same block.
  const latestByBurner = new Map<
    string,
    | { kind: "set"; ciphertext: `0x${string}`; blockNumber: bigint; logIndex: number }
    | { kind: "cleared"; blockNumber: bigint; logIndex: number }
  >();
  // Tie-break helper: returns true iff (newBlock, newLog) is strictly
  // later than (priorBlock, priorLog). Same block → compare logIndex.
  const isLater = (
    prior: { blockNumber: bigint; logIndex: number } | undefined,
    newBlock: bigint,
    newLog: number,
  ): boolean => {
    if (!prior) return true;
    if (prior.blockNumber !== newBlock) return prior.blockNumber < newBlock;
    return prior.logIndex < newLog;
  };

  const setLogs = await args.publicClient.getLogs({
    address: args.registryAddress,
    event: METADATA_SET_EVENT,
    args: { owner: args.mainAddress },
    fromBlock: args.fromBlock ?? "earliest",
    toBlock: args.toBlock ?? "latest",
  });
  for (const log of setLogs) {
    const burnerRaw = log.args.burner;
    const blob = log.args.encryptedBlob;
    if (!burnerRaw || !blob) continue;
    const burner = burnerRaw.toLowerCase();
    const blockNumber = log.blockNumber ?? 0n;
    const logIndex = log.logIndex ?? 0;
    if (isLater(latestByBurner.get(burner), blockNumber, logIndex)) {
      latestByBurner.set(burner, { kind: "set", ciphertext: blob, blockNumber, logIndex });
    }
  }

  const clearLogs = await args.publicClient.getLogs({
    address: args.registryAddress,
    event: METADATA_CLEARED_EVENT,
    args: { owner: args.mainAddress },
    fromBlock: args.fromBlock ?? "earliest",
    toBlock: args.toBlock ?? "latest",
  });
  for (const log of clearLogs) {
    const burnerRaw = log.args.burner;
    if (!burnerRaw) continue;
    const burner = burnerRaw.toLowerCase();
    const blockNumber = log.blockNumber ?? 0n;
    const logIndex = log.logIndex ?? 0;
    if (isLater(latestByBurner.get(burner), blockNumber, logIndex)) {
      latestByBurner.set(burner, { kind: "cleared", blockNumber, logIndex });
    }
  }

  const records: BurnerBackupPayload[] = [];
  let failedCount = 0;
  for (const entry of latestByBurner.values()) {
    if (entry.kind === "cleared") continue;
    try {
      const payload = await decryptBlob(entry.ciphertext, args.passphrase);
      records.push(payload);
    } catch {
      failedCount++;
    }
  }
  // Most-recent first (by createdAt).
  records.sort((a, b) => b.createdAt - a.createdAt);
  return { records, failedCount };
}

