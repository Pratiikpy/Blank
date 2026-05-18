import { useState, useMemo, useCallback } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import {
  Inbox,
  Download,
  UserPlus,
  X,
  ExternalLink,
  Search,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { getExplorerTxUrl } from "@/lib/constants";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useContacts } from "@/hooks/useContacts";
import { useCounterpartyName } from "@/hooks/useCounterpartyName";
import { getHistoryLabel, getHistoryIcon, hasCounterparty } from "@/lib/history-labels";
import type { ActivityRow } from "@/lib/supabase";
import { EmptyState } from "@/components/common/EmptyState";

type FilterTab = "all" | "received" | "sent" | "swap" | "stealth";

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "received", label: "Received" },
  { key: "sent", label: "Sent" },
  { key: "swap", label: "Swap" },
  { key: "stealth", label: "Stealth" },
];

// Wave 4 #246: typeIconMap moved to lib/history-labels.ts (getHistoryIcon).
// activityLabels kept temporarily for the legacy CSV export + detail panel
// usages — those paths still index it directly. New row rendering uses
// getHistoryLabel from history-labels.ts.
const activityLabels: Record<string, string> = {
  payment: "Sent payment",
  request: "Payment request",
  request_fulfilled: "Request fulfilled",
  request_cancelled: "Request cancelled",
  group_expense: "Group expense",
  group_settle: "Debt settled",
  tip: "Creator tip",
  invoice_created: "Invoice created",
  invoice_paid: "Invoice paid",
  payroll: "Payroll sent",
  escrow_created: "Escrow created",
  escrow_released: "Escrow released",
  exchange_created: "Swap offer",
  exchange_filled: "Swap completed",
  shield: "Deposited to vault",
  unshield: "Withdrawn from vault",
  mint: "Faucet tokens",
  gift_created: "Gift sent",
  gift_claimed: "Gift opened",
  stealth_sent: "Anonymous payment",
  stealth_claim_started: "Claim started",
  stealth_claimed: "Payment claimed",
};

import { truncateAddress } from "@/lib/address";

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMin = Math.floor((now - then) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This Week";
  if (days < 30) return "This Month";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function History() {
  const { address } = useAccount();
  const navigate = useNavigate();
  const {
    activities,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useActivityFeed();
  const { addContact } = useContacts();
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [selectedTx, setSelectedTx] = useState<(typeof activities)[number] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Inline nickname form in the tx detail dialog. Replaces window.prompt()
  // which jumped focus out of the dialog + was unstyled. WAVE4_HALF_BAKED #9.
  const [contactDraftAddr, setContactDraftAddr] = useState<string | null>(null);
  const [contactDraftName, setContactDraftName] = useState("");

  const filtered = useMemo(() => {
    if (activeFilter === "all") return activities;
    return activities.filter((a) => {
      const isIncoming =
        a.user_to.toLowerCase() === address?.toLowerCase();
      if (activeFilter === "received") return isIncoming;
      if (activeFilter === "sent")
        return !isIncoming && a.activity_type === "payment";
      if (activeFilter === "swap") return ["swap","exchange_created","exchange_filled"].includes(a.activity_type);
      if (activeFilter === "stealth") return ["stealth_sent","stealth_claim_started","stealth_claimed"].includes(a.activity_type);
      return true;
    });
  }, [activities, activeFilter, address]);

  const searchedActivities = useMemo(() => {
    if (!searchQuery) return filtered;
    const q = searchQuery.toLowerCase();
    return filtered.filter(
      (a) =>
        (a.note || "").toLowerCase().includes(q) ||
        a.user_from.toLowerCase().includes(q) ||
        a.user_to.toLowerCase().includes(q) ||
        a.activity_type.includes(q),
    );
  }, [filtered, searchQuery]);

  // Pagination is hook-driven now: the hook fetches PAGE_SIZE rows up front
  // and loadMore() fetches the next page from the server using cursor-based
  // pagination. Filter/search only narrow the already-loaded rows; clicking
  // "Load more" fetches more from the server for deeper history.
  const groupedActivities = useMemo(() => {
    const groups: { label: string; items: typeof searchedActivities }[] = [];
    let currentGroup = "";
    for (const a of searchedActivities) {
      const group = getDateGroup(a.created_at);
      if (group !== currentGroup) {
        groups.push({ label: group, items: [] });
        currentGroup = group;
      }
      groups[groups.length - 1].items.push(a);
    }
    return groups;
  }, [searchedActivities]);

  const handleLoadMore = useCallback(async () => {
    const added = await loadMore();
    // If 0 rows came back, the hook has already flipped hasMore=false so
    // the button disappears on the next render.
    return added;
  }, [loadMore]);

  const handleExport = useCallback(() => {
    const headers = "Date,Type,From,To,Note,TxHash\n";
    const rows = filtered.map(a =>
      `${a.created_at},${activityLabels[a.activity_type] || a.activity_type},${a.user_from},${a.user_to},"${(a.note || "").replace(/"/g, '""')}",${a.tx_hash}`
    ).join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `blank-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
              Activity
            </h1>
            <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed">
              Your encrypted transaction history
            </p>
          </div>
          {filtered.length > 0 && (
            <button
              onClick={handleExport}
              className="h-10 px-3 sm:px-4 rounded-full bg-gray-100 text-[var(--text-secondary)] text-xs sm:text-sm font-medium hover:bg-gray-200 transition-colors flex items-center gap-2 shrink-0"
              aria-label="Export transactions as CSV"
            >
              <Download size={14} />
              <span className="hidden sm:inline">Export CSV</span>
              <span className="sm:hidden">CSV</span>
            </button>
          )}
        </div>

        {/* Search Bar */}
        <div className="relative mb-4">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search transactions..."
            aria-label="Search transactions"
            className="h-11 w-full pl-11 pr-4 rounded-full bg-gray-100 border-none outline-none text-sm"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex gap-2 sm:gap-3 mb-6 overflow-x-auto -mx-1 px-1 pb-1" role="tablist" aria-label="Transaction filters">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeFilter === tab.key}
              aria-label={`Filter by ${tab.label.toLowerCase()}`}
              onClick={() => setActiveFilter(tab.key)}
              className={cn(
                "h-10 sm:h-12 px-4 sm:px-6 rounded-full font-medium transition-all whitespace-nowrap text-sm shrink-0",
                activeFilter === tab.key
                  ? "bg-[var(--text-primary)] text-white"
                  : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Transaction List */}
        {isLoading ? (
          <div className="rounded-[2rem] glass-card p-8">
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 p-6 rounded-2xl bg-white/50 border border-black/5"
                >
                  <div className="shimmer w-12 h-12 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="shimmer h-4 w-32 rounded" />
                    <div className="shimmer h-3 w-24 rounded" />
                  </div>
                  <div className="space-y-2 flex flex-col items-end">
                    <div className="shimmer h-5 w-20 rounded" />
                    <div className="shimmer h-5 w-16 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : searchedActivities.length === 0 ? (
          <div className="rounded-[2rem] glass-card">
            {searchQuery ? (
              <EmptyState
                icon={Search}
                tone="neutral"
                title="No matching transactions"
                body="Try a different search term, or clear the filter to see everything."
                cta={{ label: "Clear search", onClick: () => setSearchQuery("") }}
              />
            ) : activeFilter !== "all" ? (
              <EmptyState
                icon={Inbox}
                tone="neutral"
                title={`No ${activeFilter} transactions yet`}
                body="Switch filters or send a payment to start your history."
                cta={{ label: "Show all", onClick: () => setActiveFilter("all") }}
                secondary={{ label: "Send your first payment", onClick: () => navigate("/app/send") }}
              />
            ) : (
              <EmptyState
                icon={Inbox}
                tone="blue"
                title="No activity yet"
                body="Your encrypted payments will show up here. Send a private payment or share a claim link to get started."
                cta={{ label: "Send a payment", onClick: () => navigate("/app/send") }}
                secondary={{ label: "Or create a claim link", onClick: () => navigate("/app/claim-link") }}
              />
            )}
          </div>
        ) : (
          <div className="rounded-[2rem] glass-card p-4 sm:p-8">
            {groupedActivities.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                <p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide px-2 py-3">
                  {group.label}
                </p>
                <div className="space-y-3">
                  {group.items.map((activity) => (
                    <HistoryRow
                      key={activity.id}
                      activity={activity}
                      myAddress={address ?? null}
                      onClick={() => navigate(`/app/tx/${activity.id}`)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && !searchQuery && (
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label="Load more transactions"
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Loading&hellip;
                  </>
                ) : (
                  "Load more"
                )}
              </button>
            )}
          </div>
        )}

        {/* Transaction Detail Overlay */}
        {selectedTx && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
            onClick={() => setSelectedTx(null)}
          >
            <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
            <div
              className="relative w-[calc(100%-1rem)] sm:max-w-lg mx-2 sm:mx-4 mb-4 sm:mb-0 glass-card-static rounded-[2rem] p-6 space-y-4 animate-in slide-in-from-bottom-4 duration-300"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold" style={{ fontFamily: "'Outfit', sans-serif" }}>Transaction Details</h3>
                <button onClick={() => setSelectedTx(null)} className="p-2 rounded-xl hover:bg-black/5" aria-label="Close"><X size={20} /></button>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">Type</span>
                  <span className="text-sm font-medium">{activityLabels[selectedTx.activity_type] || selectedTx.activity_type}</span>
                </div>
                <div className="flex justify-between gap-3 p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)] shrink-0">From</span>
                  <span className="text-sm font-mono truncate">{truncateAddress(selectedTx.user_from)}</span>
                </div>
                <div className="flex justify-between gap-3 p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)] shrink-0">To</span>
                  <span className="text-sm font-mono truncate">{truncateAddress(selectedTx.user_to)}</span>
                </div>
                {selectedTx.note && (
                  <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                    <span className="text-sm text-[var(--text-secondary)]">Note</span>
                    <span className="text-sm">{selectedTx.note}</span>
                  </div>
                )}
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">Amount</span>
                  <span className="text-sm font-mono encrypted-text">{"\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}</span>
                </div>
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">Date</span>
                  <span className="text-sm">{new Date(selectedTx.created_at).toLocaleString()}</span>
                </div>
                {selectedTx.tx_hash && !selectedTx.tx_hash.includes("_") && (
                  <a
                    href={getExplorerTxUrl(selectedTx.tx_hash, selectedTx.chain_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 h-12 rounded-2xl bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors"
                    aria-label="View transaction on block explorer"
                  >
                    View on Explorer
                    <ExternalLink size={16} />
                  </a>
                )}
                {(() => {
                  const otherAddress = selectedTx.user_from.toLowerCase() === address?.toLowerCase() ? selectedTx.user_to : selectedTx.user_from;
                  const isEditing = contactDraftAddr === otherAddress;
                  const submit = () => {
                    const trimmed = contactDraftName.trim();
                    if (trimmed.length === 0) return;
                    addContact(otherAddress, trimmed);
                    setContactDraftAddr(null);
                    setContactDraftName("");
                  };
                  if (!isEditing) {
                    return (
                      <button
                        onClick={() => { setContactDraftAddr(otherAddress); setContactDraftName(""); }}
                        className="h-12 w-full rounded-2xl bg-gray-100 text-[var(--text-secondary)] font-medium text-sm hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
                        aria-label="Add to contacts"
                      >
                        <UserPlus size={16} />
                        Add to Contacts
                      </button>
                    );
                  }
                  return (
                    <div className="flex items-center gap-2" data-testid="contact-nickname-form">
                      <input
                        autoFocus
                        type="text"
                        placeholder="Nickname"
                        value={contactDraftName}
                        onChange={(e) => setContactDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submit();
                          if (e.key === "Escape") { setContactDraftAddr(null); setContactDraftName(""); }
                        }}
                        maxLength={40}
                        className="flex-1 h-12 px-4 rounded-2xl bg-white/70 border border-black/10 text-sm focus:outline-none focus:border-blue-400"
                        aria-label="Nickname for this contact"
                      />
                      <button
                        onClick={submit}
                        disabled={contactDraftName.trim().length === 0}
                        className="h-12 px-4 rounded-2xl bg-[#1D1D1F] text-white font-medium text-sm hover:bg-black transition-colors disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setContactDraftAddr(null); setContactDraftName(""); }}
                        className="h-12 px-3 rounded-2xl bg-gray-100 text-[var(--text-secondary)] text-sm hover:bg-gray-200"
                        aria-label="Cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── HistoryRow ──────────────────────────────────────────────────────
//
// Wave 4 task #246. Renders one activity row with type-aware label,
// counterparty name (contact → ENS → truncated hex), and pending badge.
// Lifted out of the .map() so we can use the useCounterpartyName hook
// per row (hooks rules disallow calling them inside callback bodies).

function HistoryRow({
  activity,
  myAddress,
  onClick,
}: {
  activity: ActivityRow;
  myAddress: string | null;
  onClick: () => void;
}) {
  const isIncoming =
    activity.user_to.toLowerCase() === myAddress?.toLowerCase();
  const isOutgoing =
    activity.user_from.toLowerCase() === myAddress?.toLowerCase();
  const otherAddress = isIncoming ? activity.user_from : activity.user_to;

  const label = getHistoryLabel(activity.activity_type, isIncoming);
  const { icon: Icon, bg: iconBg } = getHistoryIcon(activity.activity_type);
  const showCounterparty = hasCounterparty(activity.activity_type);
  const { label: counterpartyName } = useCounterpartyName(showCounterparty ? otherAddress : null);

  const isPending =
    activity.id.startsWith("local_") || activity.block_number === 0;

  // Subtitle structure: [counterparty? · ] [direction · ] relative-time
  // "alice.eth · sent · 2h ago"   or   "Deposited · 2h ago"
  const directionWord = isOutgoing ? "sent" : isIncoming ? "received" : null;
  const subtitleParts: string[] = [];
  if (showCounterparty && counterpartyName) subtitleParts.push(counterpartyName);
  if (directionWord) subtitleParts.push(directionWord);
  if (activity.note) subtitleParts.push(`"${activity.note}"`);
  subtitleParts.push(formatRelativeTime(activity.created_at));

  return (
    <div
      onClick={onClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className="flex items-center justify-between gap-3 p-4 sm:p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all cursor-pointer"
    >
      <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
        <div
          className={cn(
            "w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0",
            iconBg,
          )}
        >
          <Icon size={20} />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-[var(--text-primary)] truncate">
            {label}
          </p>
          <p className="text-xs text-[var(--text-tertiary)] truncate">
            {subtitleParts.join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div className="text-right">
          <p
            className={cn(
              "text-sm sm:text-lg font-heading font-medium font-mono whitespace-nowrap",
              isIncoming
                ? "text-emerald-600"
                : "text-[var(--text-primary)]",
            )}
          >
            {isIncoming ? "+" : "-"}$
            <span aria-hidden="true" className="encrypted-text">
              {"•••••.••"}
            </span>
            <span className="sr-only">Amount hidden</span>
          </p>
          <div
            className={cn(
              "inline-flex px-2 py-1 rounded-full text-xs font-medium border",
              isPending
                ? "bg-amber-50 text-amber-700 border-amber-100"
                : "bg-emerald-50 text-emerald-700 border-emerald-100",
            )}
          >
            {isPending ? "pending" : "confirmed"}
          </div>
        </div>
      </div>
    </div>
  );
}
