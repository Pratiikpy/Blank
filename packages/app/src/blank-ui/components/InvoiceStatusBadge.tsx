// Invoice status pill — single source of truth for the on-chain
// InvoiceStatus enum's visual representation. Used on InvoicePage and
// (later) anywhere else we render an invoice in the activity feed.
//
// Mirrors `enum InvoiceStatus { Pending, Paid, Cancelled, PaymentPending, Disputed }`
// from BusinessHub.sol. Cancelled covers both vendor-cancelled invoices
// and the escrow-mismatch refund path (PR-C step 2).
import { CheckCircle2, Circle, Clock, XCircle, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type InvoiceStatus = 0 | 1 | 2 | 3 | 4;

interface BadgeStyle {
  label: string;
  icon: LucideIcon;
  className: string;
}

const STYLES: Record<InvoiceStatus, BadgeStyle> = {
  0: { label: "Awaiting payment", icon: Circle, className: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20" },
  1: { label: "Paid", icon: CheckCircle2, className: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20" },
  2: { label: "Cancelled / refunded", icon: XCircle, className: "bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/20" },
  3: { label: "Funded — awaiting finalize", icon: Clock, className: "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20" },
  4: { label: "Disputed — refund pending", icon: AlertTriangle, className: "bg-orange-50 text-orange-700 border-orange-100 dark:bg-orange-500/10 dark:text-orange-300 dark:border-orange-500/20" },
};

export function InvoiceStatusBadge({ status }: { status: number }) {
  const s = STYLES[status as InvoiceStatus] ?? STYLES[0];
  const Icon = s.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium ${s.className}`}
      data-testid="invoice-status-badge"
      data-status={status}
    >
      <Icon size={12} />
      {s.label}
    </span>
  );
}
