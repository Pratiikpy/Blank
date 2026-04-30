// Phase 6.1 MVP — burner wallet registry, receive-only.
//
// One passkey can control N smart accounts: same factory, same (pubX, pubY,
// recovery) tuple, different `salt` → different deterministic AA address.
// This hook manages the user's local list of burners (label + salt),
// re-derives each address against the active chain's factory, and exposes
// helpers to create / rename / delete entries.
//
// Receive-only scope: this hook computes addresses for SHARING. Sweeping
// funds back from a burner to the main AA requires signing with the same
// passkey under a different salt context, which means the larger
// `useSmartAccount` hook needs salt awareness. That refactor is its own
// piece of work — Phase 6.1 (sweep) follow-up. For testnet today, users
// can manually move funds via the existing Send flow if they pre-import
// the burner address as the recipient.
//
// Storage:
//   localStorage key: STORAGE_KEYS.burners(mainAddress) — JSON array of
//   { id, salt, label, createdAt }. Salt is a uint256 stored as a decimal
//   string for JSON safety (BigInt doesn't survive JSON.stringify).
//
// Address derivation:
//   factory.getAddress(pubX, pubY, ZERO_ADDRESS, BigInt(salt)) — pure read,
//   no on-chain side effects. We cache results in a useState map keyed by
//   `${chainId}:${salt}` so chain switches re-derive cleanly.

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address } from "viem";
import { usePublicClient } from "wagmi";
import { useSmartAccount } from "./useSmartAccount";
import { useChain } from "@/providers/ChainProvider";
import { BlankAccountFactoryAbi } from "@/lib/abis";
import {
  STORAGE_KEYS,
  getStoredJson,
  setStoredJson,
} from "@/lib/storage";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Persisted record. `salt` is a stringified uint256 to survive JSON. */
export interface BurnerRecord {
  /** Stable id for React keys — randomly generated at create time. */
  id: string;
  /** uint256 stringified — pass `BigInt(record.salt)` to factory.getAddress. */
  salt: string;
  /** User-facing label. Free text, max 64 chars. */
  label: string;
  /** Unix ms. */
  createdAt: number;
}

/** Burner with its derived address for the active chain. */
export interface BurnerWithAddress extends BurnerRecord {
  address: Address | null;
  isLoading: boolean;
}

const MAX_LABEL_LEN = 64;
const MAX_BURNERS_PER_MAIN = 50;

/** Generate a random uint256 salt that's astronomically unlikely to collide
 *  with another user's salt OR with the user's own previous salts. We avoid
 *  sequential salts (0, 1, 2…) because they leak ordering on-chain — anyone
 *  inspecting two of your burner addresses could re-derive the rest. */
function randomSalt(): string {
  // 32 bytes of CSPRNG. Hex-decode then stringify as decimal for JSON safety.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString();
}

/** Generate a stable id for the React list. Doesn't need to be cryptographic. */
function randomId(): string {
  return crypto.randomUUID();
}

export interface UseBurnerAccountsReturn {
  /** Full list with addresses derived for the active chain. */
  burners: BurnerWithAddress[];
  /** True until the first round of address derivation completes. */
  isLoading: boolean;
  /** Last derivation error, if any (RPC failure / no factory on chain). */
  error: string | null;
  /** Create a new burner with a random salt + label. Returns the new record. */
  createBurner: (label: string) => Promise<BurnerRecord>;
  /** Rename an existing burner. */
  renameBurner: (id: string, newLabel: string) => void;
  /** Remove a burner from local registry. Address itself is deterministic
   *  and forever-recoverable from the salt — this only erases the label
   *  mapping. */
  deleteBurner: (id: string) => void;
  /** Phase 6.2 — import N pre-existing burner records (e.g. recovered
   *  from BurnerRegistry events). Preserves caller-supplied salt + id;
   *  dedupes by id so re-running recovery doesn't duplicate entries.
   *  Returns the count of records actually added (excluding duplicates). */
  importBurners: (records: BurnerRecord[]) => number;
}

export function useBurnerAccounts(): UseBurnerAccountsReturn {
  const { account } = useSmartAccount();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });

  const mainAddress = account?.address ?? null;
  const pubX = account?.pubX ?? null;
  const pubY = account?.pubY ?? null;

  // ── Persisted records ──────────────────────────────────────────────────
  const [records, setRecords] = useState<BurnerRecord[]>([]);
  useEffect(() => {
    if (!mainAddress) {
      setRecords([]);
      return;
    }
    const key = STORAGE_KEYS.burners(mainAddress);
    setRecords(getStoredJson<BurnerRecord[]>(key, []));
  }, [mainAddress]);

  // Use a functional updater so concurrent create/rename/delete can't lose
  // each other's writes via stale-closure baselines (audit fix). The
  // localStorage write happens INSIDE the updater so it always persists
  // the version we're handing to React.
  const persist = useCallback(
    (mutate: (prev: BurnerRecord[]) => BurnerRecord[]) => {
      if (!mainAddress) return;
      setRecords((prev) => {
        const next = mutate(prev);
        setStoredJson(STORAGE_KEYS.burners(mainAddress), next);
        return next;
      });
    },
    [mainAddress],
  );

  // ── Address derivation per chain ───────────────────────────────────────
  // CRITICAL: writes use functional updaters so a chain switch or a parallel
  // create-burner doesn't lose state via stale-closure overwrites. Pending-
  // key cleanup runs in `finally` so a mid-flight cancellation never leaks
  // an "is loading forever" entry (audit fix 2026-04-27).
  const [addressByKey, setAddressByKey] = useState<Map<string, Address>>(
    () => new Map(),
  );
  const [pendingByKey, setPendingByKey] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicClient || !pubX || !pubY) return;
    if (records.length === 0) return;

    // Derive only the salts we don't already have for this chain. We read
    // the latest map directly via setAddressByKey's updater dispatched
    // below, but the initial todo-list filter is best-effort: we tolerate
    // a redundant derive on the rare race because addressByKey writes
    // are idempotent (same salt → same address).
    const todo = records.filter((r) => !addressByKey.has(`${activeChainId}:${r.salt}`));
    if (todo.length === 0) return;

    let cancelled = false;
    const todoKeys = todo.map((r) => `${activeChainId}:${r.salt}`);
    setPendingByKey((prev) => {
      const next = new Set(prev);
      todoKeys.forEach((k) => next.add(k));
      return next;
    });
    setError(null);

    (async () => {
      try {
        for (const r of todo) {
          if (cancelled) return;
          try {
            const addr = (await publicClient.readContract({
              address: contracts.BlankAccountFactory,
              abi: BlankAccountFactoryAbi,
              functionName: "getAddress",
              args: [BigInt(pubX), BigInt(pubY), ZERO_ADDRESS, BigInt(r.salt)],
            })) as Address;
            if (cancelled) return;
            const k = `${activeChainId}:${r.salt}`;
            // Functional update — never overwrites a parallel run's writes.
            setAddressByKey((prev) => {
              const next = new Map(prev);
              next.set(k, addr);
              return next;
            });
          } catch (err) {
            // Surface but don't halt — other burners may still derive.
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[useBurnerAccounts] derive failed for salt ${r.salt}:`, msg);
            if (!cancelled) setError(msg.slice(0, 280));
          }
        }
      } finally {
        // Always clear the pending keys we owned, even on cancel — otherwise
        // those rows show "Deriving" forever until next chain switch.
        setPendingByKey((prev) => {
          const next = new Set(prev);
          todoKeys.forEach((k) => next.delete(k));
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, pubX, pubY, activeChainId, records, contracts.BlankAccountFactory]);

  // ── Public surface ─────────────────────────────────────────────────────

  const burners = useMemo<BurnerWithAddress[]>(
    () =>
      records.map((r) => {
        const k = `${activeChainId}:${r.salt}`;
        return {
          ...r,
          address: addressByKey.get(k) ?? null,
          isLoading: pendingByKey.has(k),
        };
      }),
    [records, addressByKey, pendingByKey, activeChainId],
  );

  const isLoading = burners.some((b) => b.isLoading);

  const createBurner = useCallback(
    async (label: string): Promise<BurnerRecord> => {
      if (!mainAddress) throw new Error("No smart account ready yet");
      const trimmed = label.trim().slice(0, MAX_LABEL_LEN) || "Untitled burner";
      const record: BurnerRecord = {
        id: randomId(),
        salt: randomSalt(),
        label: trimmed,
        createdAt: Date.now(),
      };
      // Functional updater — concurrent creates can't overwrite each other.
      // Cap is enforced inside the updater against the latest baseline so
      // racing creates against an already-full registry are caught.
      let capError: Error | null = null;
      persist((prev) => {
        if (prev.length >= MAX_BURNERS_PER_MAIN) {
          capError = new Error(
            `Maximum ${MAX_BURNERS_PER_MAIN} burners per account — delete some first`,
          );
          return prev;
        }
        return [...prev, record];
      });
      if (capError) throw capError;
      return record;
    },
    [mainAddress, persist],
  );

  const renameBurner = useCallback(
    (id: string, newLabel: string) => {
      const trimmed = newLabel.trim().slice(0, MAX_LABEL_LEN) || "Untitled burner";
      persist((prev) => prev.map((r) => (r.id === id ? { ...r, label: trimmed } : r)));
    },
    [persist],
  );

  const deleteBurner = useCallback(
    (id: string) => {
      persist((prev) => prev.filter((r) => r.id !== id));
    },
    [persist],
  );

  // Phase 6.2 — bulk import for recovery. Functional updater so a parallel
  // create/delete during recovery doesn't lose state. Cap-aware: silently
  // truncates if the merged list would exceed MAX_BURNERS_PER_MAIN.
  const importBurners = useCallback(
    (incoming: BurnerRecord[]): number => {
      let added = 0;
      persist((prev) => {
        const knownIds = new Set(prev.map((r) => r.id));
        const knownSalts = new Set(prev.map((r) => r.salt));
        const fresh = incoming.filter(
          (r) => !knownIds.has(r.id) && !knownSalts.has(r.salt),
        );
        const remaining = Math.max(0, MAX_BURNERS_PER_MAIN - prev.length);
        const toAdd = fresh.slice(0, remaining);
        added = toAdd.length;
        if (toAdd.length === 0) return prev;
        return [...prev, ...toAdd];
      });
      return added;
    },
    [persist],
  );

  return {
    burners,
    isLoading,
    error,
    createBurner,
    renameBurner,
    deleteBurner,
    importBurners,
  };
}
