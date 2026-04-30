/**
 * Phase 9 — local stealth meta-address keystore.
 *
 * Thin localStorage wrapper for the user's spending+viewing privkeys
 * and the canonical meta-address derived from them. Used by:
 *   • Phase 9.4 inbox  — needs viewing + spending pubs to scan events
 *   • Phase 9.5 sweep  — needs spending privkey to derive the stealth
 *                         private key for sweeping
 *   • Phase 9.6 setup  — writes the keys here after generation
 *
 * SECURITY: stored as plaintext today. Phase 9.6 will migrate to
 * AES-GCM-at-rest with the key derived from a per-device passkey
 * signature. Until then, this is testnet-only — anyone with browser
 * access can sweep the funds.
 */
import { type Address } from "viem";
import { getStoredJson, setStoredJson, removeStored, STORAGE_KEYS } from "./storage";
import {
  metaAddressFromPrivKeys,
  parseMetaAddress,
  type StealthMetaAddress,
} from "./stealth";

export interface StealthKeyRecord {
  spendingPrivateKey: `0x${string}`;
  viewingPrivateKey: `0x${string}`;
  metaAddress: StealthMetaAddress;
  /** Unix-seconds timestamp when the registry tx confirmed. Empty until
   *  the user publishes via ERC-6538 — UI can show "Generated, not
   *  published yet" before this is set. */
  publishedAt?: number;
  /** Tx hash of the publish — surfaced in the Setup UI as a link. */
  publishTxHash?: `0x${string}`;
}

export function loadStealthKeys(mainAddress: Address | string): StealthKeyRecord | null {
  if (!mainAddress) return null;
  const key = STORAGE_KEYS.stealthKeys(mainAddress);
  return getStoredJson<StealthKeyRecord | null>(key, null);
}

export function saveStealthKeys(
  mainAddress: Address | string,
  record: StealthKeyRecord,
): boolean {
  if (!mainAddress) return false;
  // Defensive: re-derive the meta-address from the privkeys to ensure
  // consistency. If the caller hand-built the record with a stale or
  // mismatched meta-address, we'd silently store a record where
  // checkStealthAddress can never match — this guard catches it at
  // write-time.
  const derived = metaAddressFromPrivKeys({
    spendingPrivateKey: record.spendingPrivateKey,
    viewingPrivateKey: record.viewingPrivateKey,
  });
  if (derived.metaAddress !== record.metaAddress) {
    throw new Error(
      "Stealth keystore: metaAddress doesn't match the privkey-derived meta-address",
    );
  }
  return setStoredJson(STORAGE_KEYS.stealthKeys(mainAddress), record);
}

export function clearStealthKeys(mainAddress: Address | string): void {
  if (!mainAddress) return;
  removeStored(STORAGE_KEYS.stealthKeys(mainAddress));
}

/** Convenience: returns the recipient's spending pubkey + viewing pubkey
 *  as parsed from a stored record. Used by the inbox scan to filter
 *  Announcement events without needing to re-parse on every event. */
export function pubKeysFromRecord(record: StealthKeyRecord): {
  spendingPubKey: `0x${string}`;
  viewingPubKey: `0x${string}`;
} {
  return parseMetaAddress(record.metaAddress);
}
