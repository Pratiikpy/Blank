// Address ↔ ENS / Basenames resolution.
//
// Forward (name → address): viem's `getEnsAddress` against mainnet handles
// `pratik.eth` natively and `pratik.base.eth` via CCIP-Read (the mainnet
// Universal Resolver delegates to Base's L2 resolver and viem follows the
// EIP-3668 hop transparently).
//
// Reverse (address → name): `getEnsName` against mainnet. Sepolia reverse
// resolution has gaps so we never use it.

import { isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { ensClient } from "./ens-client";

/** Heuristic: does this string look like an ENS / Basenames input? */
export function looksLikeEnsName(input: string): boolean {
  if (!input) return false;
  const trimmed = input.trim();
  if (trimmed.startsWith("0x")) return false;
  if (/\s/.test(trimmed)) return false;
  // Must contain a dot with non-empty labels on either side. Per ENSIP-15
  // the label charset includes Unicode (emoji domains, international
  // names) so we use a denylist instead of a [a-z0-9-] whitelist — the
  // old whitelist rejected valid names like `josé.eth` or `🦄.eth`.
  // Final validation is delegated to viem's `normalize` (EIP-137 +
  // ENSIP-15) in resolveName.
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return false;
  if (trimmed.includes("..")) return false;
  // Reject characters that are definitionally invalid in DNS-style labels.
  if (/[\/@_,:;<>(){}\[\]?*"'`!#$%^&=+|\\]/.test(trimmed)) return false;
  return trimmed.includes(".");
}

/**
 * Resolve a name like `pratik.eth` or `pratik.base.eth` to an address.
 * Returns null if the name doesn't resolve or if the input isn't name-shaped.
 */
export async function resolveName(name: string): Promise<Address | null> {
  if (!looksLikeEnsName(name)) return null;
  let normalized: string;
  try {
    normalized = normalize(name.trim());
  } catch {
    return null;
  }
  try {
    const addr = await ensClient.getEnsAddress({ name: normalized });
    return addr ?? null;
  } catch {
    return null;
  }
}

/**
 * Reverse-resolve an address to its primary ENS name. Returns null if no
 * primary name is set or the lookup fails.
 */
export async function lookupName(address: Address): Promise<string | null> {
  if (!isAddress(address)) return null;
  try {
    const name = await ensClient.getEnsName({ address });
    return name ?? null;
  } catch {
    return null;
  }
}
