// React-Query wrappers around ENS forward/reverse resolution.
//
// Forward resolution is the hot path on the Send screen — every keystroke can
// trigger a lookup. We cache aggressively (5 min stale) so retyping the same
// name doesn't re-hit the RPC, and the queryFn is only enabled when the input
// actually looks like a name.

import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address } from "viem";
import { resolveName, lookupName, looksLikeEnsName } from "@/lib/address-resolver";

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Resolve a name input (e.g. `pratik.eth`) to an address. Returns
 * `{ data, isLoading, error }` — `data` is `null` once we know the name does
 * not resolve, `undefined` while loading or when the input isn't name-shaped.
 */
export function useResolveName(input: string | null | undefined) {
  const name = input?.trim() ?? "";
  const enabled = looksLikeEnsName(name);
  return useQuery({
    queryKey: ["ens-resolve", name.toLowerCase()],
    queryFn: () => resolveName(name),
    enabled,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
    retry: 1,
  });
}

/**
 * Reverse-lookup the primary ENS name for an address. Used to render
 * `pratik.eth` instead of `0x123…abc` in history, receipts, etc.
 */
export function useLookupName(address: Address | null | undefined) {
  const enabled = !!address && isAddress(address);
  return useQuery({
    queryKey: ["ens-lookup", address?.toLowerCase()],
    queryFn: () => lookupName(address as Address),
    enabled,
    staleTime: FIVE_MINUTES,
    gcTime: FIVE_MINUTES,
    retry: 1,
  });
}
