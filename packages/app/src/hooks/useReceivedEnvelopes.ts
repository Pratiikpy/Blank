import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { GiftMoneyAbi } from "@/lib/abis";
import type { ActivityRow } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { log } from "@/lib/log";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REFRESH_INTERVAL_MS = 30_000;

/** getEnvelope() return tuple, in declaration order. */
type EnvelopeTuple = readonly [
  sender: `0x${string}`,
  vault: `0x${string}`,
  recipientCount: bigint,
  claimedCount: bigint,
  note: string,
  timestamp: bigint,
  active: boolean,
  expiryTimestamp: bigint,
];

/**
 * Envelopes addressed to the current user, read straight from GiftMoney.
 *
 * The Gifts screen builds its "Received" list from the activity feed, which is
 * served by the indexer. That made claiming a gift impossible whenever the
 * indexer had not caught up or was unreachable: the recipient saw an empty
 * screen, and the per-row manual claim input only renders inside a row, so
 * there was no row to type into either. The money was on chain and reachable
 * the whole time.
 *
 * GiftMoney already tracks recipients (`getReceivedEnvelopes`), so the receive
 * side needs no backend at all. Rows are shaped like ActivityRow so the screen
 * can merge them into the feed without a second render path.
 */
export function useReceivedEnvelopes() {
  const { activeChainId, contracts } = useChain();
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [tick, setTick] = useState(0);

  const giftMoney = contracts.GiftMoney as `0x${string}` | undefined;

  const addresses = useMemo(() => {
    const set = new Set<string>();
    for (const a of [effectiveAddress, eoa]) {
      if (a && a.toLowerCase() !== ZERO_ADDRESS) set.add(a.toLowerCase());
    }
    return Array.from(set) as `0x${string}`[];
  }, [effectiveAddress, eoa]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Track the serialized result so a poll that changes nothing does not
  // re-render every consumer of the Gifts list.
  const lastSerialized = useRef("");

  useEffect(() => {
    if (!publicClient || !giftMoney || giftMoney === ZERO_ADDRESS || addresses.length === 0) {
      setRows([]);
      lastSerialized.current = "";
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const idLists = await Promise.allSettled(
          addresses.map(async (addr) =>
            publicClient.readContract({
              address: giftMoney,
              abi: GiftMoneyAbi,
              functionName: "getReceivedEnvelopes",
              args: [addr],
            }),
          ),
        );

        // Every read failing means the RPC is down, not that the user has no
        // gifts. Say so, rather than rendering "no gifts received yet" over a
        // wallet that has some.
        if (idLists.every((r) => r.status === "rejected")) {
          const first = idLists[0];
          throw first && first.status === "rejected"
            ? first.reason
            : new Error("getReceivedEnvelopes failed for every address");
        }

        // One envelope can list both the smart account and the EOA. Keep the
        // first address that saw it so the claim button targets that identity.
        const owners = new Map<number, `0x${string}`>();
        idLists.forEach((result, i) => {
          if (result.status !== "fulfilled") return;
          for (const id of result.value as readonly bigint[]) {
            const n = Number(id);
            if (!owners.has(n)) owners.set(n, addresses[i]);
          }
        });
        if (owners.size === 0) {
          if (!cancelled && lastSerialized.current !== "") {
            lastSerialized.current = "";
            setRows([]);
          }
          return;
        }

        const ids = Array.from(owners.keys());
        const details = await Promise.allSettled(
          ids.map((id) =>
            publicClient.readContract({
              address: giftMoney,
              abi: GiftMoneyAbi,
              functionName: "getEnvelope",
              args: [BigInt(id)],
            }),
          ),
        );

        const next: ActivityRow[] = [];
        details.forEach((result, i) => {
          if (result.status !== "fulfilled") return;
          const t = result.value as EnvelopeTuple;
          const id = ids[i];
          const to = owners.get(id) as `0x${string}`;
          const createdAtMs = Number(t[5] ?? 0n) * 1000;
          next.push({
            // Deterministic id so React keys stay stable across polls, and so
            // a row that also arrives from the indexer can be de-duplicated.
            id: `onchain-envelope-${activeChainId}-${id}`,
            tx_hash: `onchain-envelope-${id}`,
            user_from: (t[0] ?? ZERO_ADDRESS).toLowerCase(),
            user_to: to,
            activity_type: ACTIVITY_TYPES.GIFT_CREATED,
            contract_address: giftMoney.toLowerCase(),
            note: `[envelope:${id}] ${t[4] || "Gift envelope"}`,
            token_address: (t[1] ?? ZERO_ADDRESS).toLowerCase(),
            block_number: 0,
            chain_id: activeChainId,
            created_at: new Date(createdAtMs || Date.now()).toISOString(),
          });
        });

        next.sort((a, b) => b.created_at.localeCompare(a.created_at));
        const serialized = JSON.stringify(next);
        if (cancelled || serialized === lastSerialized.current) return;
        lastSerialized.current = serialized;
        setRows(next);
      } catch (err) {
        // A read failure is not fatal — the indexer-backed list still renders.
        log.warn(
          "useReceivedEnvelopes.readFailed",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, giftMoney, addresses, activeChainId, tick]);

  // Poll on the same cadence as the activity feed so a gift claimed or
  // received in another tab shows up without a reload.
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { rows, refresh };
}
