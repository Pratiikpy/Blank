import { cn } from "@/lib/cn";

type Status = "confirmed" | "pending" | "unclaimed" | "claimed" | "active";

const statusStyles: Record<Status, string> = {
  confirmed: "badge-confirmed",
  pending: "badge-pending",
  unclaimed: "badge-unclaimed",
  claimed: "badge-claimed",
  active: "badge-active",
};

const statusLabels: Record<Status, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
  unclaimed: "Unclaimed",
  claimed: "Claimed",
  active: "Active",
};

export function StatusBadge({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  return (
    <span className={cn("badge-status", statusStyles[status], className)}>
      {statusLabels[status]}
    </span>
  );
}
