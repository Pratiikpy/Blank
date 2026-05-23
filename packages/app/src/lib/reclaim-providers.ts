// Wave 5 Block 1 — Reclaim Protocol provider catalog.
//
// Provider IDs MUST match the values allowlisted by ReclaimAdapter.sol's
// initializer (RAIL_UPI_PHONEPE = 1, etc.). Real Reclaim Protocol IDs
// are 32-byte hashes set by Reclaim's dashboard; v1 ships with the
// hardcoded constants below + the MockReclaimVerifier fallback so the
// build is operational on testnet even before Reclaim sandbox onboarding.
//
// Reclaim dashboard registration is tracked as the Block 0.5 spike;
// after the spike, replace these placeholders with the real provider
// hashes Reclaim emits.

export const RAIL_UPI_PHONEPE = 1;
export const RAIL_UPI_GPAY    = 2;
export const RAIL_UPI_PAYTM   = 3;
export const RAIL_WISE        = 4;
export const RAIL_VENMO       = 5;
export const RAIL_PAYPAL      = 6;

export type RailId =
  | typeof RAIL_UPI_PHONEPE
  | typeof RAIL_UPI_GPAY
  | typeof RAIL_UPI_PAYTM
  | typeof RAIL_WISE
  | typeof RAIL_VENMO
  | typeof RAIL_PAYPAL;

export interface RailDescriptor {
  id: RailId;
  /** Short, user-facing label. */
  label: string;
  /** Family for color-grouping in UI. */
  family: "UPI" | "Wise" | "Venmo" | "PayPal";
  /** Placeholder format hint for the maker handle input. */
  handlePlaceholder: string;
  /** Validation regex for the handle. Loose to allow real-world variety. */
  handlePattern: RegExp;
  /** Tailwind class tokens for the rail badge (matches WAVE5_PLAN.md §2). */
  badgeClass: string;
}

export const RAILS: Record<RailId, RailDescriptor> = {
  [RAIL_UPI_PHONEPE]: {
    id: RAIL_UPI_PHONEPE,
    label: "PhonePe UPI",
    family: "UPI",
    handlePlaceholder: "you@upi or 98xxxxxxxx@ybl",
    handlePattern: /^[\w.\-]+@[\w.\-]+$/i,
    badgeClass: "bg-orange-500/10 text-orange-600",
  },
  [RAIL_UPI_GPAY]: {
    id: RAIL_UPI_GPAY,
    label: "Google Pay UPI",
    family: "UPI",
    handlePlaceholder: "you@oksbi or you@okhdfcbank",
    handlePattern: /^[\w.\-]+@[\w.\-]+$/i,
    badgeClass: "bg-orange-500/10 text-orange-600",
  },
  [RAIL_UPI_PAYTM]: {
    id: RAIL_UPI_PAYTM,
    label: "Paytm UPI",
    family: "UPI",
    handlePlaceholder: "98xxxxxxxx@paytm",
    handlePattern: /^[\w.\-]+@[\w.\-]+$/i,
    badgeClass: "bg-orange-500/10 text-orange-600",
  },
  [RAIL_WISE]: {
    id: RAIL_WISE,
    label: "Wise",
    family: "Wise",
    handlePlaceholder: "you@example.com (Wise email)",
    handlePattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    badgeClass: "bg-blue-500/10 text-blue-600",
  },
  [RAIL_VENMO]: {
    id: RAIL_VENMO,
    label: "Venmo",
    family: "Venmo",
    handlePlaceholder: "@your-venmo-handle",
    handlePattern: /^@?[\w.\-]{3,}$/,
    badgeClass: "bg-sky-500/10 text-sky-600",
  },
  [RAIL_PAYPAL]: {
    id: RAIL_PAYPAL,
    label: "PayPal",
    family: "PayPal",
    handlePlaceholder: "you@example.com (PayPal email)",
    handlePattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    badgeClass: "bg-indigo-500/10 text-indigo-600",
  },
};

export function railById(id: number): RailDescriptor | undefined {
  return (RAILS as Record<number, RailDescriptor>)[id];
}

export const ALL_RAILS: RailDescriptor[] = Object.values(RAILS);
