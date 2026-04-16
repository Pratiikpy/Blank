import { useEffect, useMemo, useState, useCallback } from "react";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { useRealtime } from "@/providers/RealtimeProvider";
import {
  fetchActivities,
  fetchUserGroups,
  fetchUserEscrows,
  fetchIncomingRequests,
  fetchClientInvoices,
} from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";

/**
 * Surface every "role" the connected user has been assigned to, pulled in a
 * single mount-time fetch. This is Phase 2's generic root fix for #222
 * (arbiter role not fetched on mount), #224 (privacy permit propagation),
 * #250 (heir role refresh) and complements #182.
 *
 * Roles span activities, escrows, invoices, payment requests and group
 * memberships — a proactive "Roles assigned to you" sweep so users discover
 * every designation without having to visit each individual screen.
 */

export type MyRole =
  | {
      kind: "arbiter";
      escrowId: number;
      depositor: string;
      description: string;
      createdAt: string;
    }
  | {
      kind: "heir";
      principal: string;
      createdAt: string;
    }
  | {
      kind: "group_member";
      groupId: number;
      groupName: string;
      createdAt: string;
    }
  | {
      kind: "invoice_pending";
      invoiceId: number;
      vendor: string;
      description: string;
      createdAt: string;
    }
  | {
      kind: "request_pending";
      requestId: number;
      requester: string;
      note: string;
      createdAt: string;
    }
  | {
      kind: "escrow_beneficiary";
      escrowId: number;
      depositor: string;
      description: string;
      createdAt: string;
    };

interface UseMyRolesResult {
  roles: MyRole[];
  unreadCount: number;
  loading: boolean;
  markAllSeen: () => void;
  markSeen: (role: MyRole) => void;
  refetch: () => Promise<void>;
}

export function roleKey(r: MyRole): string {
  switch (r.kind) {
    case "arbiter":
      return `arb:${r.escrowId}`;
    case "escrow_beneficiary":
      return `ben:${r.escrowId}`;
    case "heir":
      return `heir:${r.principal.toLowerCase()}`;
    case "group_member":
      return `grp:${r.groupId}`;
    case "invoice_pending":
      return `inv:${r.invoiceId}`;
    case "request_pending":
      return `req:${r.requestId}`;
  }
}

export function useMyRoles(): UseMyRolesResult {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const { subscribe } = useRealtime();
  const [roles, setRoles] = useState<MyRole[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // Bump on markAllSeen() so useMemo re-reads localStorage.
  const [seenVersion, setSeenVersion] = useState(0);

  const refetch = useCallback(async () => {
    if (!address) {
      setRoles([]);
      return;
    }
    setLoading(true);
    try {
      const addr = address.toLowerCase();
      const next: MyRole[] = [];

      // Kick all fetches off in parallel — one mount-time sweep.
      const [heirActs, escrows, groups, invoices, reqs] = await Promise.all([
        fetchActivities(addr, 50),
        fetchUserEscrows(addr),
        fetchUserGroups(addr),
        fetchClientInvoices(addr),
        fetchIncomingRequests(addr),
      ]);

      // 1. Heir designations (activity feed — principal named me as heir)
      const heirRows = heirActs.filter(
        (a) =>
          a.activity_type === ACTIVITY_TYPES.INHERITANCE_HEIR_SET &&
          a.user_to.toLowerCase() === addr,
      );
      for (const r of heirRows) {
        next.push({
          kind: "heir",
          principal: r.user_from,
          createdAt: r.created_at,
        });
      }

      // 2. Arbiter assignments — I'm the named arbiter on an active escrow.
      const arbiterEscrows = escrows.filter(
        (e) =>
          e.arbiter_address?.toLowerCase() === addr && e.status === "active",
      );
      for (const e of arbiterEscrows) {
        next.push({
          kind: "arbiter",
          escrowId: e.escrow_id,
          depositor: e.depositor_address,
          description: e.description,
          createdAt: e.created_at,
        });
      }

      // 3. Group memberships (all — users get a passive note of each group).
      for (const g of groups) {
        next.push({
          kind: "group_member",
          groupId: g.group_id,
          groupName: g.group_name,
          createdAt: g.created_at,
        });
      }

      // 4. Pending invoices where I'm the client.
      // fetchClientInvoices already filters status=pending server-side.
      for (const i of invoices) {
        if (i.status === "pending") {
          next.push({
            kind: "invoice_pending",
            invoiceId: i.invoice_id,
            vendor: i.vendor_address,
            description: i.description,
            createdAt: i.created_at,
          });
        }
      }

      // 5. Pending payment requests where I'm payer.
      // fetchIncomingRequests already filters status=pending server-side.
      for (const r of reqs) {
        if (r.status === "pending") {
          next.push({
            kind: "request_pending",
            requestId: r.request_id,
            requester: r.to_address,
            note: r.note,
            createdAt: r.created_at,
          });
        }
      }

      // 6. Escrow beneficiary (I'm receiving — nudge me to mark delivered).
      const beneEscrows = escrows.filter(
        (e) =>
          e.beneficiary_address?.toLowerCase() === addr &&
          e.status === "active",
      );
      for (const e of beneEscrows) {
        next.push({
          kind: "escrow_beneficiary",
          escrowId: e.escrow_id,
          depositor: e.depositor_address,
          description: e.description,
          createdAt: e.created_at,
        });
      }

      // Newest first.
      next.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setRoles(next);
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Initial fetch (and refetch on address/chain switch).
  useEffect(() => {
    void refetch();
  }, [refetch, activeChainId]);

  // Live updates: any change to a table that can mint a role triggers refetch.
  useEffect(() => {
    if (!address) return;
    const lower = address.toLowerCase();
    const refresh = () => {
      void refetch();
    };
    const unsubs: Array<() => void> = [
      subscribe(
        "escrows",
        { event: "INSERT", filter: { column: "arbiter_address", value: lower } },
        refresh,
      ),
      subscribe(
        "escrows",
        {
          event: "INSERT",
          filter: { column: "beneficiary_address", value: lower },
        },
        refresh,
      ),
      subscribe(
        "escrows",
        { event: "UPDATE", filter: { column: "arbiter_address", value: lower } },
        refresh,
      ),
      subscribe(
        "invoices",
        { event: "INSERT", filter: { column: "client_address", value: lower } },
        refresh,
      ),
      subscribe(
        "invoices",
        { event: "UPDATE", filter: { column: "client_address", value: lower } },
        refresh,
      ),
      subscribe(
        "payment_requests",
        { event: "INSERT", filter: { column: "from_address", value: lower } },
        refresh,
      ),
      subscribe(
        "payment_requests",
        { event: "UPDATE", filter: { column: "from_address", value: lower } },
        refresh,
      ),
      subscribe(
        "group_memberships",
        {
          event: "INSERT",
          filter: { column: "member_address", value: lower },
        },
        refresh,
      ),
      subscribe(
        "activities",
        { event: "INSERT", filter: { column: "user_to", value: lower } },
        refresh,
      ),
    ];
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [address, subscribe, refetch]);

  // Seen-set lives in localStorage, keyed per (address, chainId).
  const seenSet = useMemo(() => {
    if (!address) return new Set<string>();
    const key = STORAGE_KEYS.myRolesSeen(address, activeChainId);
    return new Set(getStoredJson<string[]>(key, []));
    // roles.length intentionally included — after refetch we want unread counts
    // to recompute, and the seenSet snapshot is cheap to rebuild.
    // seenVersion included so markAllSeen / markSeen triggers an update.
  }, [address, activeChainId, roles.length, seenVersion]);

  const unreadCount = useMemo(
    () => roles.filter((r) => !seenSet.has(roleKey(r))).length,
    [roles, seenSet],
  );

  const markAllSeen = useCallback(() => {
    if (!address) return;
    const key = STORAGE_KEYS.myRolesSeen(address, activeChainId);
    const allIds = roles.map(roleKey);
    setStoredJson(key, allIds);
    setSeenVersion((v) => v + 1);
  }, [address, activeChainId, roles]);

  const markSeen = useCallback(
    (role: MyRole) => {
      if (!address) return;
      const key = STORAGE_KEYS.myRolesSeen(address, activeChainId);
      const existing = new Set(getStoredJson<string[]>(key, []));
      existing.add(roleKey(role));
      setStoredJson(key, Array.from(existing));
      setSeenVersion((v) => v + 1);
    },
    [address, activeChainId],
  );

  return { roles, unreadCount, loading, markAllSeen, markSeen, refetch };
}
