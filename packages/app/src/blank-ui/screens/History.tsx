import { useState, useMemo } from "react";
import { useAccount } from "wagmi";
import {
  Send,
  ArrowDownLeft,
  ArrowLeftRight,
  Ghost,
  KeyRound,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useActivityFeed } from "@/hooks/useActivityFeed";

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

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

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

export default function History() {
  const { address } = useAccount();
  const { activities, isLoading } = useActivityFeed();
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");

  const filtered = useMemo(() => {
    if (activeFilter === "all") return activities;
    return activities.filter((a) => {
      const isIncoming =
        a.user_to.toLowerCase() === address?.toLowerCase();
      if (activeFilter === "received") return isIncoming;
      if (activeFilter === "sent")
        return !isIncoming && a.activity_type === "payment";
      if (activeFilter === "swap") return a.activity_type === "swap";
      if (activeFilter === "stealth") return a.activity_type === "stealth";
      return true;
    });
  }, [activities, activeFilter, address]);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Activity
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Your encrypted transaction history
          </p>
        </div>

        {/* Filter Pills */}
        <div className="flex gap-3 mb-6">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
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
        ) : filtered.length === 0 ? (
          <div className="rounded-[2rem] glass-card p-16 flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4">
              <Inbox size={32} className="text-gray-400" />
            </div>
            <p className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">
              No activity yet
            </p>
            <p className="text-sm text-[var(--text-primary)]/50">
              {activeFilter === "all"
                ? "Your transactions will appear here"
                : `No ${activeFilter} transactions found`}
            </p>
          </div>
        ) : (
          <div className="rounded-[2rem] glass-card p-8">
            <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
              Recent Transactions
            </h3>
            <div className="space-y-3">
              {filtered.map((activity) => {
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
                    className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
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
                          {activity.activity_type.charAt(0).toUpperCase() +
                            activity.activity_type.slice(1)}{" "}
                          &middot; {formatRelativeTime(activity.created_at)}
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
                          <span className="encrypted-text">
                            {"█████.██"}
                          </span>
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
        )}
      </div>
    </div>
  );
}
