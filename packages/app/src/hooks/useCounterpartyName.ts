// Wave 4 task #246 — resolve a counterparty address into a readable name.
//
// Resolution order:
//   1. Saved contact nickname (localStorage + Supabase via useContacts)
//   2. ENS reverse lookup (mainnet client; cached 5 min)
//   3. Truncated hex (0x1234…abcd)
//
// Returns the best label currently known, plus the source so callers can
// style it differently (e.g., italicize ENS, monospace truncated hex).

import { useMemo } from "react";
import type { Address } from "viem";

import { useContacts } from "./useContacts";
import { useLookupName } from "./useAddressResolver";
import { truncateAddress } from "@/lib/address";

export type NameSource = "contact" | "ens" | "hex";

interface ResolvedName {
  label: string;
  source: NameSource;
}

/** Resolve a single counterparty address. Synchronous fast-path falls back
 *  to "0x…" while ENS lookup is in flight. */
export function useCounterpartyName(address: string | null | undefined): ResolvedName {
  const { contacts } = useContacts();
  const ensQuery = useLookupName(address as Address | null | undefined);

  return useMemo(() => {
    if (!address) return { label: "", source: "hex" };
    const lower = address.toLowerCase();
    const contact = contacts.find((c) => c.address.toLowerCase() === lower);
    if (contact?.nickname) return { label: contact.nickname, source: "contact" };
    if (ensQuery.data) return { label: ensQuery.data, source: "ens" };
    return { label: truncateAddress(address), source: "hex" };
  }, [address, contacts, ensQuery.data]);
}
