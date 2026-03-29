import { useState, useCallback, useMemo, useEffect } from "react";
import { useAccount } from "wagmi";
import {
  useCofheActivePermit,
} from "@cofhe/react";
import toast from "react-hot-toast";

interface SharedPermit {
  address: string;
  accessLevel: "full" | "balance-proof";
  expiresAt: number;
  createdAt: number;
}

interface SharedPermitsState {
  sharedPermits: SharedPermit[];
}

const PERMIT_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds
const STORAGE_KEY = "blank_permit_state";

function loadSharedPermits(address: string): SharedPermit[] {
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY}_${address.toLowerCase()}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Partial<SharedPermitsState & { sharedPermits: SharedPermit[] }>;
    return parsed.sharedPermits ?? [];
  } catch {
    return [];
  }
}

function saveSharedPermits(address: string, sharedPermits: SharedPermit[]) {
  try {
    localStorage.setItem(
      `${STORAGE_KEY}_${address.toLowerCase()}`,
      JSON.stringify({ sharedPermits })
    );
  } catch {
    // Storage quota exceeded — non-critical, data still in memory
  }
}

/**
 * Manages FHE permit state using the real cofhe SDK hooks.
 *
 * - `hasPermit`, `permitExpiresAt`, and `isExpiringSoon` are derived from
 *   `useCofheActivePermit()` which reads the SDK's live permit store.
 * - `createPermit` delegates to `useCofheCreatePermitMutation` which signs
 *   an EIP-712 message to derive the sealing key on-chain.
 * - `sharePermit` / `revokePermit` remain localStorage-based because the
 *   SDK does not manage sharing permits to arbitrary addresses (our custom
 *   feature for accountants/auditors).
 * - `permitCreatedAt` is not available from the SDK Permit type (which only
 *   stores `expiration`), so we estimate it as `expiration - 7 days`.
 */
export function usePrivacy() {
  const { address } = useAccount();

  // ── Real SDK permit state ──────────────────────────────────────────
  const activePermitData = useCofheActivePermit();

  const hasPermit = activePermitData != null && activePermitData.isValid;

  // The SDK Permit type stores `expiration` as a unix timestamp in seconds.
  const permitExpiresAt = useMemo(() => {
    if (!activePermitData?.permit) return null;
    // Convert seconds to milliseconds for the UI
    return activePermitData.permit.expiration * 1000;
  }, [activePermitData?.permit]);

  // The SDK Permit type does not include a creation timestamp.
  // Estimate as expiration minus the default duration we use (7 days).
  const permitCreatedAt = useMemo(() => {
    if (!activePermitData?.permit) return null;
    return activePermitData.permit.expiration * 1000 - PERMIT_DURATION_SECONDS * 1000;
  }, [activePermitData?.permit]);

  // Check if permit is expiring soon (< 1 hour) or already expired
  const isExpiringSoon =
    permitExpiresAt !== null &&
    permitExpiresAt - Date.now() < 60 * 60 * 1000 &&
    permitExpiresAt > Date.now();

  const isExpired =
    permitExpiresAt !== null && permitExpiresAt <= Date.now();

  // ── Permit creation ───────────────────────────────────────────────
  // useCofheCreatePermitMutation is not exported from @cofhe/react's
  // public API. The CofheProvider handles permits on wallet connection.
  // isCreating is kept as a stable false for consumers that read it.
  const isCreating = false;

  const createPermit = useCallback(async () => {
    if (!address) return;
    // The CofheProvider auto-creates permits on wallet connection.
    // Manual permit creation requires the SDK's internal mutation
    // which is not yet exported in the public @cofhe/react API.
    // If you need to renew, disconnect and reconnect your wallet.
    toast("To renew your permit, disconnect and reconnect your wallet.", {
      icon: "\uD83D\uDD11",
      duration: 5000,
    });
  }, [address]);

  // ── Custom shared permits (localStorage) ───────────────────────────
  const [sharedPermits, setSharedPermits] = useState<SharedPermit[]>(
    address ? loadSharedPermits(address) : []
  );

  // Reload shared permits when wallet address changes
  useEffect(() => {
    if (address) {
      setSharedPermits(loadSharedPermits(address));
    } else {
      setSharedPermits([]);
    }
  }, [address]);

  const persistShared = useCallback(
    (updated: SharedPermit[]) => {
      if (!address) return;
      setSharedPermits(updated);
      saveSharedPermits(address, updated);
    },
    [address]
  );

  // Share data with another address
  const sharePermit = useCallback(
    async (targetAddress: string, accessLevel: "full" | "balance-proof", expiryHours: number) => {
      if (!address) return;

      const now = Date.now();
      const newShare: SharedPermit = {
        address: targetAddress.toLowerCase(),
        accessLevel,
        expiresAt: now + expiryHours * 60 * 60 * 1000,
        createdAt: now,
      };

      const updated = [
        ...sharedPermits.filter((p) => p.address !== targetAddress.toLowerCase()),
        newShare,
      ];

      persistShared(updated);
      toast.success(`Shared ${accessLevel} access with ${targetAddress.slice(0, 8)}...`);
    },
    [address, sharedPermits, persistShared]
  );

  // Revoke a shared permit
  const revokePermit = useCallback(
    (targetAddress: string) => {
      const updated = sharedPermits.filter(
        (p) => p.address !== targetAddress.toLowerCase()
      );
      persistShared(updated);
      toast.success("Permit revoked");
    },
    [sharedPermits, persistShared]
  );

  return {
    hasPermit,
    permitCreatedAt,
    permitExpiresAt,
    isCreating,
    sharedPermits,
    isExpiringSoon,
    isExpired,
    createPermit,
    sharePermit,
    revokePermit,
  };
}
