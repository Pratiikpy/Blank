import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { GroupManagerAbi } from "@/lib/abis";
import type { GroupMembershipRow } from "@/lib/supabase";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { log } from "@/lib/log";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** getGroup() return tuple, in declaration order. */
type GroupTuple = readonly [
  name: string,
  members: readonly `0x${string}`[],
  expenseCount: bigint,
  active: boolean,
];

/**
 * Groups this user is a member of, read straight from GroupManager.
 *
 * Groups is a shared surface: one person creates the group and adds an
 * expense, everyone else settles their share. The screen loaded membership
 * from Supabase alone, so the other members only saw the group once the
 * indexer had written their row. Until then — or if the indexer was
 * unreachable — they had no group to open and no debt to settle, while the
 * on-chain membership had been theirs the whole time.
 *
 * Inactive (archived) groups are dropped, matching what a member expects to
 * see. Rows are shaped like the Supabase ones so the screen merges rather
 * than branches; `is_admin` is indexer-only and defaults to false, so a
 * chain-sourced row never grants admin controls it cannot back up.
 */
export function useOnChainGroups() {
  const { activeChainId, contracts } = useChain();
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [groups, setGroups] = useState<GroupMembershipRow[]>([]);
  // getGroup returns the full member list. The membership row shape has no
  // room for it, and the card was rendering an avatar stack containing only
  // the viewer's own address, so keep it alongside.
  const [members, setMembers] = useState<Record<number, string[]>>({});
  const [tick, setTick] = useState(0);

  const manager = contracts.GroupManager as `0x${string}` | undefined;

  const addresses = useMemo(() => {
    const set = new Set<string>();
    for (const a of [effectiveAddress, eoa]) {
      if (a && a.toLowerCase() !== ZERO_ADDRESS) set.add(a.toLowerCase());
    }
    return Array.from(set) as `0x${string}`[];
  }, [effectiveAddress, eoa]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const lastSerialized = useRef("");

  useEffect(() => {
    if (!publicClient || !manager || manager === ZERO_ADDRESS || addresses.length === 0) {
      setGroups([]);
      setMembers({});
      lastSerialized.current = "";
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const settled = await Promise.allSettled(
          addresses.map((addr) =>
            publicClient.readContract({
              address: manager,
              abi: GroupManagerAbi,
              functionName: "getUserGroups",
              args: [addr],
            }),
          ),
        );
        if (settled.every((r) => r.status === "rejected")) {
          const first = settled[0];
          throw first && first.status === "rejected"
            ? first.reason
            : new Error("getUserGroups failed for every address");
        }

        // Keep the address the membership was found under: the settle and
        // expense calls must be signed by that identity.
        const owners = new Map<number, `0x${string}`>();
        settled.forEach((r, i) => {
          if (r.status !== "fulfilled") return;
          for (const id of r.value as readonly bigint[]) {
            const n = Number(id);
            if (!owners.has(n)) owners.set(n, addresses[i]);
          }
        });

        const ids = Array.from(owners.keys());
        const details = await Promise.allSettled(
          ids.map((id) =>
            publicClient.readContract({
              address: manager,
              abi: GroupManagerAbi,
              functionName: "getGroup",
              args: [BigInt(id)],
            }),
          ),
        );
        if (cancelled) return;

        const next: GroupMembershipRow[] = [];
        const nextMembers: Record<number, string[]> = {};
        details.forEach((r, i) => {
          if (r.status !== "fulfilled") return;
          const t = r.value as GroupTuple;
          if (!t[3]) return; // archived
          const id = ids[i];
          nextMembers[id] = t[1].map((m) => m.toLowerCase());
          next.push({
            id: `onchain-group-${activeChainId}-${id}`,
            group_id: id,
            group_name: t[0] || `Group #${id}`,
            member_address: owners.get(id) as string,
            // Admin is an indexer-side concept; never assume it from the chain.
            is_admin: false,
            chain_id: activeChainId,
            created_at: "",
          });
        });

        next.sort((a, b) => b.group_id - a.group_id);
        const serialized = JSON.stringify([next, nextMembers]);
        if (serialized === lastSerialized.current) return;
        lastSerialized.current = serialized;
        setGroups(next);
        setMembers(nextMembers);
      } catch (err) {
        log.warn(
          "useOnChainGroups.readFailed",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, manager, addresses, activeChainId, tick]);

  return { groups, members, refresh };
}
