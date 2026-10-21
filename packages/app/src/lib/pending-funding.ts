// Bookkeeping for the second step of a funding-gate action (see funding-gate.ts).
//
// The user's own transaction leaves an item Pending on-chain. If the tab closes,
// or the Threshold Network is slow, before confirmFunding lands, the item stays
// Pending and anyone can still confirm it. This module remembers which items this
// browser still owes a confirmation for, so a hook can finish them on the next
// visit, and it reads the id of a freshly created Pending item out of a receipt.

import { FundingGateTimeout } from "./funding-gate";

export type PendingKind = "tip" | "purchase" | "fill";

export interface PendingFundingScope {
  kind: PendingKind;
  chainId: number;
  contract: string;
  account: string;
}

export interface PendingFunding extends PendingFundingScope {
  /** On-chain id, decimal string. */
  id: string;
  createdAt: number;
  /** What the hook needs to finish the post-success work after confirmation. */
  data: Record<string, string>;
}

const STORAGE_KEY = "blank:pending-funding:v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

function normalize(scope: PendingFundingScope): PendingFundingScope {
  return {
    kind: scope.kind,
    chainId: scope.chainId,
    contract: scope.contract.toLowerCase(),
    account: scope.account.toLowerCase(),
  };
}

function sameScope(a: PendingFundingScope, b: PendingFundingScope): boolean {
  return a.kind === b.kind && a.chainId === b.chainId && a.contract === b.contract && a.account === b.account;
}

function isEntry(v: unknown): v is PendingFunding {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    (e.kind === "tip" || e.kind === "purchase" || e.kind === "fill") &&
    typeof e.chainId === "number" &&
    typeof e.contract === "string" &&
    typeof e.account === "string" &&
    typeof e.id === "string" &&
    typeof e.createdAt === "number" &&
    !!e.data && typeof e.data === "object"
  );
}

function readAll(): PendingFunding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter(isEntry).filter((e) => e.createdAt >= cutoff);
  } catch {
    return [];
  }
}

function writeAll(entries: PendingFunding[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Storage can be unavailable (private mode, quota). The item is still
    // Pending on-chain and anyone can confirm it; only the automatic retry is lost.
  }
}

export function listPendingFundings(scope: PendingFundingScope): PendingFunding[] {
  const s = normalize(scope);
  return readAll().filter((e) => sameScope(e, s));
}

export function addPendingFunding(
  scope: PendingFundingScope,
  id: bigint | string,
  data: Record<string, string> = {},
): void {
  const s = normalize(scope);
  const key = id.toString();
  const rest = readAll().filter((e) => !(sameScope(e, s) && e.id === key));
  rest.push({ ...s, id: key, createdAt: Date.now(), data });
  writeAll(rest);
}

export function removePendingFunding(scope: PendingFundingScope, id: bigint | string): void {
  const s = normalize(scope);
  const key = id.toString();
  writeAll(readAll().filter((e) => !(sameScope(e, s) && e.id === key)));
}

/**
 * Topic0 of each Pending event, taken from the compiled ABIs:
 * TipPending(uint256,address,address,address,bytes32),
 * FillPending(uint64,uint64,address,bytes32),
 * PurchasePending(uint256,uint256,address,bytes32).
 * The id is always the first indexed argument (topics[1]).
 */
export const PENDING_EVENT_TOPIC = {
  tip: "0x10f341b7609b511362c5fe8196b57d5145c74e97952704a5c2ac112eff600dcd",
  fill: "0x473044c87dbddb3feb845318d031b953df432960ecc9b2ecbf7481979e6b5c2b",
  purchase: "0x2606a8927a990ef332f6e1eb1a9e95420014bb5c0809cf86aefd448240b0e874",
} as const satisfies Record<PendingKind, string>;

/** The id of the Pending item a transaction created, or null when its receipt carries no such event. */
export function findPendingId(
  logs: readonly { address: string; topics: readonly string[] }[] | undefined,
  contract: string,
  kind: PendingKind,
): bigint | null {
  if (!logs) return null;
  const topic0 = PENDING_EVENT_TOPIC[kind];
  for (const log of logs) {
    if (
      log.address.toLowerCase() === contract.toLowerCase() &&
      log.topics.length >= 2 &&
      log.topics[0]?.toLowerCase() === topic0
    ) {
      try {
        return BigInt(log.topics[1]);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * A ciphertext handle as the bigint decryptForTx wants. The funding-gate view
 * functions are declared bytes32 in the ABI (viem returns a hex string), while
 * the older hand-written ABIs declare uint256 (viem returns a bigint). Both
 * forms of an unset handle become 0n.
 */
export function asHandle(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && value.startsWith("0x")) return BigInt(value);
  throw new Error("Unexpected ciphertext handle from the contract");
}

/**
 * Toast copy for a second step that did not finish. `pendingNote` says what is
 * true while the item waits. A timeout and a failed confirm are different
 * problems, so the real reason is kept when there is one.
 */
export function describeGateFailure(err: unknown, pendingNote: string): string {
  if (err instanceof FundingGateTimeout) {
    return `The funding check is not ready yet. ${pendingNote}`;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  return `The funding check could not finish (${reason}). ${pendingNote}`;
}
