import { useState, useEffect, useCallback, useRef } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyToClipboard } from "@/lib/clipboard";
import type { ActivityRow } from "@/lib/supabase";

// ─── Props ──────────────────────────────────────────────────────────

interface PaginatedActivityTableProps {
  activities: ActivityRow[];
  currentUser: string;
  isLoading?: boolean;
  pageSize?: number;
}

// ─── Status dot colors ──────────────────────────────────────────────

const DOT_COLORS: Record<string, string> = {
  payment: "#34d399",
  request: "#60a5fa",
  tip: "#f472b6",
  invoice_created: "#a78bfa",
  invoice_paid: "#a78bfa",
  group_expense: "#fb923c",
  group_settle: "#fb923c",
  shield: "#8b5cf6",
  unshield: "#8b5cf6",
  mint: "#34d399",
  faucet: "#34d399",
  escrow_created: "#a78bfa",
  escrow_released: "#a78bfa",
  escrow_expired: "#a78bfa",
  escrow_resolved: "#a78bfa",
};

const DEFAULT_DOT_COLOR = "#525252";

function getDotColor(activityType: string): string {
  return DOT_COLORS[activityType] ?? DEFAULT_DOT_COLOR;
}

// ─── Label mapping ──────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  payment: "Payment",
  request: "Request",
  request_fulfilled: "Request Paid",
  request_cancelled: "Cancelled",
  tip: "Tip",
  invoice_created: "Invoice",
  invoice_paid: "Invoice Paid",
  group_expense: "Group Expense",
  group_settle: "Group Settle",
  shield: "Shield",
  unshield: "Unshield",
  mint: "Mint",
  faucet: "Faucet",
  escrow_created: "Escrow",
  escrow_released: "Escrow Released",
  escrow_expired: "Escrow Expired",
  escrow_resolved: "Escrow Resolved",
  exchange_filled: "Exchange",
  payroll: "Payroll",
};

function getTypeLabel(activityType: string): string {
  return TYPE_LABELS[activityType] ?? activityType;
}

// ─── Helpers ────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}\u2026${hash.slice(-4)}`;
}

function relativeTime(dateStr: string): string {
  return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false })
    .replace(" seconds", "s")
    .replace(" second", "s")
    .replace(" minutes", "m")
    .replace(" minute", "m")
    .replace(" hours", "h")
    .replace(" hour", "h")
    .replace(" days", "d")
    .replace(" day", "d")
    .replace(" months", "mo")
    .replace(" month", "mo")
    .replace(" years", "y")
    .replace(" year", "y")
    .concat(" ago");
}

function addressDisplay(addr: string, currentUser: string): string {
  if (addr.toLowerCase() === currentUser.toLowerCase()) return "You";
  return truncateAddress(addr);
}

// ─── Pagination helpers ─────────────────────────────────────────────

function computePageNumbers(
  currentPage: number,
  totalPages: number,
  maxVisible: number
): (number | "ellipsis-start" | "ellipsis-end")[] {
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | "ellipsis-start" | "ellipsis-end")[] = [];
  const half = Math.floor(maxVisible / 2);

  let start = currentPage - half;
  let end = currentPage + half;

  if (start < 1) {
    start = 1;
    end = maxVisible;
  }
  if (end > totalPages) {
    end = totalPages;
    start = totalPages - maxVisible + 1;
  }

  if (start > 1) {
    pages.push(1);
    if (start > 2) pages.push("ellipsis-start");
  }

  for (let i = Math.max(start, start > 1 ? start + (start > 2 ? 1 : 0) : start); i <= end; i++) {
    if (!pages.includes(i)) pages.push(i);
  }

  if (end < totalPages) {
    if (end < totalPages - 1) pages.push("ellipsis-end");
    if (!pages.includes(totalPages)) pages.push(totalPages);
  }

  return pages;
}

// ─── Shimmer row ────────────────────────────────────────────────────

function ShimmerRow() {
  return (
    <tr className="border-b border-white/[0.03]">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-white/[0.06] animate-pulse" />
          <div className="h-3 w-14 rounded bg-white/[0.06] animate-pulse" />
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-24 rounded bg-white/[0.06] animate-pulse" />
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-20 rounded bg-white/[0.06] animate-pulse" />
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-12 rounded bg-white/[0.06] animate-pulse" />
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-16 rounded bg-white/[0.06] animate-pulse" />
      </td>
      <td className="px-3 py-3">
        <div className="h-3 w-5 rounded bg-white/[0.06] animate-pulse" />
      </td>
    </tr>
  );
}

// ─── Copy button ────────────────────────────────────────────────────

function CopyHashButton({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(hash);
    if (ok) {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }
  }, [hash]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "opacity-0 group-hover/row:opacity-100 transition-opacity duration-150",
        "flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300",
        "cursor-pointer select-none"
      )}
      aria-label={copied ? "Copied transaction hash" : "Copy transaction hash"}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-emerald-400" />
          <span className="text-emerald-400">Copied!</span>
        </>
      ) : (
        <Copy className="w-3 h-3" />
      )}
    </button>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export function PaginatedActivityTable({
  activities,
  currentUser,
  isLoading = false,
  pageSize = 10,
}: PaginatedActivityTableProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [showShimmer, setShowShimmer] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingStartedRef = useRef<number | null>(null);

  // ── Grace period shimmer logic ──────────────────────────────────
  // When isLoading becomes true, show shimmer immediately.
  // When isLoading becomes false, keep shimmer visible until at least
  // 3 seconds have elapsed since it started (prevents layout jank).

  useEffect(() => {
    if (isLoading) {
      setShowShimmer(true);
      loadingStartedRef.current = Date.now();
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    } else if (loadingStartedRef.current !== null) {
      const elapsed = Date.now() - loadingStartedRef.current;
      const remaining = Math.max(0, 3000 - elapsed);

      if (remaining === 0) {
        setShowShimmer(false);
        loadingStartedRef.current = null;
      } else {
        graceTimerRef.current = setTimeout(() => {
          setShowShimmer(false);
          loadingStartedRef.current = null;
          graceTimerRef.current = null;
        }, remaining);
      }
    } else {
      // isLoading was never true this cycle
      setShowShimmer(false);
    }

    return () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    };
  }, [isLoading]);

  // ── Pagination calculations ─────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(activities.length / pageSize));

  // Clamp current page when activities change
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const startIdx = (currentPage - 1) * pageSize;
  const pageActivities = activities.slice(startIdx, startIdx + pageSize);
  const pageNumbers = computePageNumbers(currentPage, totalPages, 5);

  const goToPage = useCallback(
    (page: number) => {
      if (page >= 1 && page <= totalPages) setCurrentPage(page);
    },
    [totalPages]
  );

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="w-full">
      {/* Responsive scroll wrapper */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Type
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                From / To
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Note
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Time
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Tx Hash
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {showShimmer
              ? Array.from({ length: 5 }).map((_, i) => <ShimmerRow key={`shimmer-${i}`} />)
              : pageActivities.length === 0
                ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-10 text-center text-xs text-neutral-600"
                    >
                      No activity yet
                    </td>
                  </tr>
                )
                : pageActivities.map((activity) => {
                    const dotColor = getDotColor(activity.activity_type);
                    const isSender =
                      activity.user_from.toLowerCase() === currentUser.toLowerCase();
                    const counterparty = isSender ? activity.user_to : activity.user_from;
                    const directionLabel = isSender ? "to" : "from";

                    return (
                      <tr
                        key={activity.id}
                        className="group/row border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors duration-150"
                      >
                        {/* Type */}
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                              style={{
                                backgroundColor: dotColor,
                                boxShadow: `0 0 6px ${dotColor}`,
                              }}
                            />
                            <span className="text-xs text-neutral-300 whitespace-nowrap">
                              {getTypeLabel(activity.activity_type)}
                            </span>
                          </div>
                        </td>

                        {/* From / To */}
                        <td className="px-3 py-3">
                          <span className="text-xs text-neutral-500">
                            {directionLabel}{" "}
                          </span>
                          <span className="font-mono text-xs text-neutral-400">
                            {addressDisplay(counterparty, currentUser)}
                          </span>
                        </td>

                        {/* Note */}
                        <td className="px-3 py-3">
                          <span className="text-xs text-neutral-500 max-w-[150px] truncate block">
                            {activity.note || "\u2014"}
                          </span>
                        </td>

                        {/* Time */}
                        <td className="px-3 py-3">
                          <span className="text-xs text-neutral-500 whitespace-nowrap">
                            {relativeTime(activity.created_at)}
                          </span>
                        </td>

                        {/* Tx Hash */}
                        <td className="px-3 py-3">
                          <span className="font-mono text-[10px] text-neutral-700">
                            {truncateHash(activity.tx_hash)}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-3">
                          <CopyHashButton hash={activity.tx_hash} />
                        </td>
                      </tr>
                    );
                  })}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {!showShimmer && totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-4">
          {/* Previous */}
          <button
            type="button"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 1}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-150",
              currentPage === 1
                ? "text-neutral-800 cursor-not-allowed"
                : "text-neutral-600 hover:text-neutral-400 cursor-pointer"
            )}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Page numbers */}
          {pageNumbers.map((item) => {
            if (item === "ellipsis-start" || item === "ellipsis-end") {
              return (
                <span
                  key={item}
                  className="w-8 h-8 flex items-center justify-center text-neutral-700 text-xs select-none"
                >
                  ...
                </span>
              );
            }

            const isActive = item === currentPage;
            return (
              <button
                type="button"
                key={item}
                onClick={() => goToPage(item)}
                className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center text-xs transition-colors duration-150 cursor-pointer",
                  isActive
                    ? "bg-white/[0.06] text-white font-medium"
                    : "text-neutral-600 hover:text-neutral-400"
                )}
                aria-label={`Page ${item}`}
                aria-current={isActive ? "page" : undefined}
              >
                {item}
              </button>
            );
          })}

          {/* Next */}
          <button
            type="button"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage === totalPages}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-150",
              currentPage === totalPages
                ? "text-neutral-800 cursor-not-allowed"
                : "text-neutral-600 hover:text-neutral-400 cursor-pointer"
            )}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
