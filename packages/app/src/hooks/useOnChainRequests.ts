import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { PaymentHubAbi } from "@/lib/abis";
import type { PaymentRequestRow } from "@/lib/supabase";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { log } from "@/lib/log";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** PaymentHub.RequestStatus, in declaration order. */
const REQUEST_STATUS: PaymentRequestRow["status"][] = ["pending", "fulfilled", "cancelled"];

type RequestTuple = readonly [
  from: `0x${string}`,
  to: `0x${string}`,
  vault: `0x${string}`,
  amount: bigint,
  note: string,
  status: number,
  createdAt: bigint,
];

/**
 * Payment requests addressed to this user, read straight from PaymentHub.
 *
 * Requests are the other half of a two-party flow: someone asks you for money
 * and you decide whether to pay. The Requests screen loaded them from Supabase
 * alone, so a request that existed on chain but had no indexer row was
 * invisible — the payer saw an empty inbox and the requester waited on a
 * payment that could never be made from the UI.
 *
 * PaymentHub.getIncomingRequests has always been there. Rows are shaped like
 * the Supabase ones so the screen merges rather than branches. Payer email is
 * genuinely indexer-only and stays null.
 */
export function useOnChainRequests() {
  const { activeChainId, contracts } = useChain();
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [incoming, setIncoming] = useState<PaymentRequestRow[]>([]);
  const [tick, setTick] = useState(0);

  const hub = contracts.PaymentHub as `0x${string}` | undefined;

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
    if (!publicClient || !hub || hub === ZERO_ADDRESS || addresses.length === 0) {
      setIncoming([]);
      lastSerialized.current = "";
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const settled = await Promise.allSettled(
          addresses.map((addr) =>
            publicClient.readContract({
              address: hub,
              abi: PaymentHubAbi,
              functionName: "getIncomingRequests",
              args: [addr],
            }),
          ),
        );
        if (settled.every((r) => r.status === "rejected")) {
          const first = settled[0];
          throw first && first.status === "rejected"
            ? first.reason
            : new Error("getIncomingRequests failed for every address");
        }

        const ids = new Set<number>();
        for (const r of settled) {
          if (r.status !== "fulfilled") continue;
          for (const id of r.value as readonly bigint[]) ids.add(Number(id));
        }

        const idList = Array.from(ids);
        const details = await Promise.allSettled(
          idList.map((id) =>
            publicClient.readContract({
              address: hub,
              abi: PaymentHubAbi,
              functionName: "getRequest",
              args: [BigInt(id)],
            }),
          ),
        );
        if (cancelled) return;

        const next: PaymentRequestRow[] = [];
        details.forEach((r, i) => {
          if (r.status !== "fulfilled") return;
          const t = r.value as RequestTuple;
          const status = REQUEST_STATUS[t[5]] ?? "pending";
          // The screen's inbox is the actionable list. A fulfilled or
          // cancelled request has nothing left to do, and the indexer-backed
          // query filters to pending for the same reason.
          if (status !== "pending") return;
          const createdMs = Number(t[6] ?? 0n) * 1000;
          next.push({
            id: `onchain-request-${activeChainId}-${idList[i]}`,
            request_id: idList[i],
            from_address: t[0].toLowerCase(),
            to_address: t[1].toLowerCase(),
            token_address: t[2].toLowerCase(),
            note: t[4] || "",
            status,
            tx_hash: `onchain-request-${idList[i]}`,
            chain_id: activeChainId,
            payer_email: null,
            created_at: new Date(createdMs || Date.now()).toISOString(),
            updated_at: new Date(createdMs || Date.now()).toISOString(),
          });
        });

        next.sort((a, b) => b.request_id - a.request_id);
        const serialized = JSON.stringify(next);
        if (serialized === lastSerialized.current) return;
        lastSerialized.current = serialized;
        setIncoming(next);
      } catch (err) {
        log.warn(
          "useOnChainRequests.readFailed",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, hub, addresses, activeChainId, tick]);

  return { incoming, refresh };
}
