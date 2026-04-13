import { useState, useMemo, useCallback, useEffect } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import {
  Send,
  ArrowDownLeft,
  ArrowLeftRight,
  Ghost,
  KeyRound,
  Inbox,
  Download,
  UserPlus,
  X,
  ExternalLink,
  Search,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ACTIVE_CHAIN } from "@/lib/constants";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useContacts } from "@/hooks/useContacts";

const PAGE_SIZE = 20;

type FilterTab = "all" | "received" | "sent" | "swap" | "stealth";

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "received", label: "Received" },
  { key: "sent", label: "Sent" },
  { key: "swap", label: "Swap" },
  { key: "stealth", label: "Stealth" },
];

const typeIconMap: Record<
  string,
  { icon: React.ReactNode; bg: string }
> = {
  payment: {
    icon: <Send size={20} />,
    bg: "bg-[#007AFF]/10 text-[#007AFF]",
  },
  receive: {
    icon: <ArrowDownLeft size={20} />,
    bg: "bg-emerald-50 text-emerald-600",
  },
  shield: {
    icon: <KeyRound size={20} />,
    bg: "bg-amber-50 text-amber-600",
  },
  swap: {
    icon: <ArrowLeftRight size={20} />,
    bg: "bg-purple-50 text-purple-600",
  },
  stealth: {
    icon: <Ghost size={20} />,
    bg: "bg-gray-100 text-gray-600",
  },
};

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
  const { activities, isLoading } = useActivityFeed();
  const { addContact } = useContacts();
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [selectedTx, setSelectedTx] = useState<(typeof activities)[number] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

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

  // Reset visible count when filter or search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeFilter, searchQuery]);

  const visibleActivities = useMemo(
    () => searchedActivities.slice(0, visibleCount),
    [searchedActivities, visibleCount],
  );

  const groupedActivities = useMemo(() => {
    const groups: { label: string; items: typeof visibleActivities }[] = [];
    let currentGroup = "";
    for (const a of visibleActivities) {
      const group = getDateGroup(a.created_at);
      if (group !== currentGroup) {
        groups.push({ label: group, items: [] });
        currentGroup = group;
      }
      groups[groups.length - 1].items.push(a);
    }
    return groups;
  }, [visibleActivities]);

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
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
              Activity
            </h1>
            <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
              Your encrypted transaction history
            </p>
          </div>
          {filtered.length > 0 && (
            <button
              onClick={handleExport}
              className="h-10 px-4 rounded-full bg-gray-100 text-[var(--text-secondary)] text-sm font-medium hover:bg-gray-200 transition-colors flex items-center gap-2"
              aria-label="Export transactions as CSV"
            >
              <Download size={14} />
              Export CSV
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
        <div className="flex gap-3 mb-6" role="tablist" aria-label="Transaction filters">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeFilter === tab.key}
              aria-label={`Filter by ${tab.label.toLowerCase()}`}
              onClick={() => setActiveFilter(tab.key)}
              className={cn(
                "h-12 px-6 rounded-full font-medium transition-all whitespace-nowrap",
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
          <div className="rounded-[2rem] glass-card p-16 flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4">
              <Inbox size={32} className="text-gray-400" />
            </div>
            <p className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">
              {searchQuery ? "No matching transactions" : "No activity yet"}
            </p>
            <p className="text-sm text-[var(--text-primary)]/50">
              {searchQuery
                ? "Try a different search term"
                : activeFilter === "all"
                  ? "Your transactions will appear here"
                  : `No ${activeFilter} transactions found`}
            </p>
          </div>
        ) : (
          <div className="rounded-[2rem] glass-card p-8">
            {groupedActivities.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                <p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide px-2 py-3">
                  {group.label}
                </p>
                <div className="space-y-3">
                  {group.items.map((activity) => {
                const isIncoming =
                  activity.user_to.toLowerCase() === address?.toLowerCase();
                const typeInfo = typeIconMap[activity.activity_type] || {
                  icon: <Send size={20} />,
                  bg: "bg-gray-50 text-gray-400",
                };
                const otherAddress = isIncoming
                  ? activity.user_from
                  : activity.user_to;
                const isPending =
                  activity.id.startsWith("local_") ||
                  activity.block_number === 0;

                return (
                  <div
                    key={activity.id}
                    onClick={() => navigate(`/tx/${activity.id}`)}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate(`/tx/${activity.id}`); }}
                    className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={cn(
                          "w-12 h-12 rounded-xl flex items-center justify-center",
                          typeInfo.bg,
                        )}
                      >
                        {typeInfo.icon}
                      </div>
                      <div>
                        <p className="font-medium text-[var(--text-primary)]">
                          {activity.note || truncateAddress(otherAddress)}
                        </p>
                        <p className="text-sm text-[var(--text-primary)]/50">
                          <span className="text-xs text-[var(--text-tertiary)]">
                            {activity.user_from.toLowerCase() === address?.toLowerCase() ? "\u2191 Sent" : "\u2193 Received"} &middot; {formatRelativeTime(activity.created_at)}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p
                          className={cn(
                            "text-lg font-heading font-medium font-mono",
                            isIncoming
                              ? "text-emerald-600"
                              : "text-[var(--text-primary)]",
                          )}
                        >
                          {isIncoming ? "+" : "-"}$
                          <span aria-hidden="true" className="encrypted-text">
                            {"\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
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
                })}
                </div>
              </div>
            ))}
            {visibleCount < searchedActivities.length && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3"
              >
                Load more ({searchedActivities.length - visibleCount} remaining)
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
              className="relative w-full max-w-lg mx-4 mb-4 sm:mb-0 glass-card-static rounded-[2rem] p-6 space-y-4 animate-in slide-in-from-bottom-4 duration-300"
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
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">From</span>
                  <span className="text-sm font-mono">{selectedTx.user_from.slice(0, 10)}...{selectedTx.user_from.slice(-6)}</span>
                </div>
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">To</span>
                  <span className="text-sm font-mono">{selectedTx.user_to.slice(0, 10)}...{selectedTx.user_to.slice(-6)}</span>
                </div>
                {selectedTx.note && (
                  <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                    <span className="text-sm text-[var(--text-secondary)]">Note</span>
                    <span className="text-sm">{selectedTx.note}</span>
                  </div>
                )}
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">Amount</span>
                  <span className="text-sm font-mono encrypted-text">{"\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}</span>
                </div>
                <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
                  <span className="text-sm text-[var(--text-secondary)]">Date</span>
                  <span className="text-sm">{new Date(selectedTx.created_at).toLocaleString()}</span>
                </div>
                {selectedTx.tx_hash && !selectedTx.tx_hash.includes("_") && (
                  <a
                    href={`${ACTIVE_CHAIN.explorerUrl}/tx/${selectedTx.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 h-12 rounded-2xl bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors"
                    aria-label="View transaction on Basescan"
                  >
                    View on Basescan
                    <ExternalLink size={16} />
                  </a>
                )}
                <button
                  onClick={() => {
                    const otherAddress = selectedTx.user_from.toLowerCase() === address?.toLowerCase() ? selectedTx.user_to : selectedTx.user_from;
                    const name = prompt("Nickname for this contact:");
                    if (name) addContact(otherAddress, name);
                  }}
                  className="h-12 w-full rounded-2xl bg-gray-100 text-[var(--text-secondary)] font-medium text-sm hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
                  aria-label="Add to contacts"
                >
                  <UserPlus size={16} />
                  Add to Contacts
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
