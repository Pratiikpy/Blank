// Display an address with its primary ENS / Basenames name when available.
//
// Reverse lookup via mainnet — same client used for forward resolution. If no
// primary name is set or the lookup fails, falls back to the explicit
// `fallback` prop (useful for showing a contact nickname) and finally to the
// truncated 0x… form. Cached for 5 min via React Query so re-rendering lists
// doesn't re-hit RPC.

import { isAddress, type Address } from "viem";
import { useLookupName } from "@/hooks/useAddressResolver";
import { truncateAddress } from "@/lib/address";
import { cn } from "@/lib/cn";

interface AddressLabelProps {
  address: string | undefined | null;
  /** Shown when no ENS name resolves (e.g. local contact nickname). */
  fallback?: string;
  /** Render in monospace when no name is available. */
  mono?: boolean;
  className?: string;
}

export function AddressLabel({ address, fallback, mono = true, className }: AddressLabelProps) {
  const isValid = !!address && isAddress(address);
  const lookup = useLookupName(isValid ? (address as Address) : null);

  if (!address) return <span className={className}>—</span>;

  const ensName = lookup.data;
  if (ensName) {
    return <span className={className}>{ensName}</span>;
  }

  if (fallback) {
    return <span className={className}>{fallback}</span>;
  }

  return (
    <span className={cn(mono && "font-mono", className)}>
      {isValid ? truncateAddress(address) : address}
    </span>
  );
}
