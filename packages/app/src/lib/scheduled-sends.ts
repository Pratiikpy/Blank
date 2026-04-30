// Phase 4.1 — ScheduledSends client lib. Wraps the SessionKeyValidator
// contract surface (setScope / revokeScope / getScope) and reconstructs
// the user's active scopes by streaming `ScopeSet` / `ScopeRevoked`
// events. Same event-sourced pattern as BurnerRegistry — works on a
// fresh device without server state.
//
// The lib does NOT generate session-key private keys client-side. Per
// Plan §4.1, the keypair lives server-side (held by Vercel cron + KMS)
// so the cron can sign UserOps on schedule without the user being
// online. The frontend only learns the public key via
// `/api/scheduled-sends/create`.
//
// Off-chain "label" / "frequency" / "expiry" are NOT stored on-chain by
// the validator (the contract is amount-and-recipient-only). For UI
// purposes we mirror them in localStorage keyed by sessionKey address —
// recoverable via the backend record IDs even after a localStorage
// clear (out of scope for this MVP; flagged as a follow-up).

import {
  type Address,
  type PublicClient,
  parseAbiItem,
} from "viem";

const SESSION_KEY_VALIDATOR_ABI = [
  // setScope(address sessionKey, Scope scope)
  {
    type: "function",
    name: "setScope",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionKey", type: "address" },
      {
        name: "scope",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "spendToken", type: "address" },
          { name: "maxAmountPerCall", type: "uint128" },
          { name: "periodSeconds", type: "uint48" },
          { name: "validUntil", type: "uint48" },
          { name: "lastFiredAt", type: "uint48" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeScope",
    stateMutability: "nonpayable",
    inputs: [{ name: "sessionKey", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getScope",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "sessionKey", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "spendToken", type: "address" },
          { name: "maxAmountPerCall", type: "uint128" },
          { name: "periodSeconds", type: "uint48" },
          { name: "validUntil", type: "uint48" },
          { name: "lastFiredAt", type: "uint48" },
        ],
      },
    ],
  },
] as const;

const SCOPE_SET_EVENT = parseAbiItem(
  "event ScopeSet(address indexed account, address indexed sessionKey, address indexed recipient, address spendToken, uint128 maxAmountPerCall, uint48 periodSeconds, uint48 validUntil)",
);
const SCOPE_REVOKED_EVENT = parseAbiItem(
  "event ScopeRevoked(address indexed account, address indexed sessionKey)",
);

export const SessionKeyValidatorAbi = SESSION_KEY_VALIDATOR_ABI;

export interface Scope {
  recipient: Address;
  spendToken: Address;
  maxAmountPerCall: bigint;
  periodSeconds: number;
  validUntil: number;
  lastFiredAt: number;
}

export interface ActiveScope extends Scope {
  /** The session key address this scope is tied to. */
  sessionKey: Address;
  /** Block where the latest setScope event landed. Useful for sorting
   *  and for UI "created N hours ago" labels. */
  blockNumber: bigint;
  /** True when `validUntil` is in the past (per client clock with 1h
   *  skew tolerance). UI badges these as expired but KEEPS the row so
   *  the user can still revoke — hiding the row would leave them with
   *  no path to clean up the slot, since the chain still has the entry. */
  isExpired: boolean;
}

/** Stream the validator's ScopeSet / ScopeRevoked events for the given
 *  account, then dedupe to the live set. Latest write wins per session
 *  key; revoke beats set when newer. */
export async function fetchActiveScopes(args: {
  publicClient: PublicClient;
  validatorAddress: Address;
  accountAddress: Address;
  fromBlock?: bigint | "earliest";
  toBlock?: bigint | "latest";
}): Promise<ActiveScope[]> {
  if (args.validatorAddress === "0x0000000000000000000000000000000000000000") {
    return [];
  }

  // Per-sessionKey latest write tracker. Key by lowercased address; tie-
  // break on (blockNumber, logIndex) — same pattern as BurnerRegistry
  // recovery to handle paymaster-batched writes in one block.
  type Latest =
    | {
        kind: "set";
        scope: Scope;
        blockNumber: bigint;
        logIndex: number;
      }
    | { kind: "revoked"; blockNumber: bigint; logIndex: number };
  const latestByKey = new Map<string, Latest>();

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
    address: args.validatorAddress,
    event: SCOPE_SET_EVENT,
    args: { account: args.accountAddress },
    fromBlock: args.fromBlock ?? "earliest",
    toBlock: args.toBlock ?? "latest",
  });
  for (const log of setLogs) {
    const sessionKey = log.args.sessionKey;
    if (!sessionKey) continue;
    const blockNumber = log.blockNumber ?? 0n;
    const logIndex = log.logIndex ?? 0;
    const lower = sessionKey.toLowerCase();
    if (isLater(latestByKey.get(lower), blockNumber, logIndex)) {
      latestByKey.set(lower, {
        kind: "set",
        scope: {
          recipient: log.args.recipient as Address,
          spendToken: log.args.spendToken as Address,
          maxAmountPerCall: (log.args.maxAmountPerCall ?? 0n) as bigint,
          periodSeconds: Number(log.args.periodSeconds ?? 0n),
          validUntil: Number(log.args.validUntil ?? 0n),
          lastFiredAt: 0, // event doesn't include — read via getScope if needed
        },
        blockNumber,
        logIndex,
      });
    }
  }

  const revokedLogs = await args.publicClient.getLogs({
    address: args.validatorAddress,
    event: SCOPE_REVOKED_EVENT,
    args: { account: args.accountAddress },
    fromBlock: args.fromBlock ?? "earliest",
    toBlock: args.toBlock ?? "latest",
  });
  for (const log of revokedLogs) {
    const sessionKey = log.args.sessionKey;
    if (!sessionKey) continue;
    const blockNumber = log.blockNumber ?? 0n;
    const logIndex = log.logIndex ?? 0;
    const lower = sessionKey.toLowerCase();
    if (isLater(latestByKey.get(lower), blockNumber, logIndex)) {
      latestByKey.set(lower, { kind: "revoked", blockNumber, logIndex });
    }
  }

  // Convert to ActiveScope[]. Only "set" entries (a revoked scope has no
  // row). We DO surface expired scopes — badged as expired in the UI —
  // so users can still revoke them. Hiding expired rows would leave the
  // chain entry orphaned with no UI path to clean up.
  // 1h skew tolerance prevents a slightly-fast client clock from
  // ghost-expiring still-valid scopes.
  const SKEW_TOLERANCE_SEC = 60 * 60;
  const nowSeconds = Math.floor(Date.now() / 1000) - SKEW_TOLERANCE_SEC;
  const out: ActiveScope[] = [];
  for (const [lower, entry] of latestByKey) {
    if (entry.kind !== "set") continue;
    const isExpired =
      entry.scope.validUntil > 0 && entry.scope.validUntil <= nowSeconds;
    out.push({
      ...entry.scope,
      sessionKey: lower as Address,
      blockNumber: entry.blockNumber,
      isExpired,
    });
  }
  // Most-recent first by blockNumber, falling back to validUntil ordering.
  out.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  return out;
}

/** Common period presets for the create-scope form. Caller picks one and
 *  the form submits `periodSeconds` directly. */
export const PERIOD_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "Daily", seconds: 24 * 60 * 60 },
  { label: "Weekly", seconds: 7 * 24 * 60 * 60 },
  { label: "Bi-weekly", seconds: 14 * 24 * 60 * 60 },
  { label: "Monthly (30d)", seconds: 30 * 24 * 60 * 60 },
];

/** Compute the next allowed fire time given a stored `lastFiredAt` and
 *  `periodSeconds`. Returns 0 when the scope has never fired (allowed
 *  immediately, EntryPoint validAfter=0 path). */
export function computeNextFireSeconds(scope: Pick<Scope, "lastFiredAt" | "periodSeconds">): number {
  if (scope.lastFiredAt === 0) return 0;
  return scope.lastFiredAt + scope.periodSeconds;
}

/** Format seconds-until-next-fire as a friendly string. Negative → "Now". */
export function formatTimeUntil(seconds: number): string {
  if (seconds <= 0) return "Now";
  if (seconds < 60) return `in ${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.ceil(seconds / 3600)}h`;
  return `in ${Math.ceil(seconds / 86400)}d`;
}
