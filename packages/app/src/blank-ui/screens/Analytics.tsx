import { useMemo } from "react";
import {
  Send,
  ArrowDownRight,
  ArrowLeftRight,
  TrendingUp,
  EyeOff,
  Shield,
  Users,
  Gift,
  Ghost,
} from "lucide-react";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { ACTIVITY_TYPES } from "@/lib/activity-types";

// ---------------------------------------------------------------
//  STAT COMPUTATION
// ---------------------------------------------------------------

interface ActivityStats {
  sentCount: number;
  receivedCount: number;
  swapCount: number;
  groupSplitCount: number;
  stealthCount: number;
  giftCount: number;
}

// Direction is determined by address position (matches History.tsx semantics).
// Activity rows have user_from + user_to; the row lands in your feed when either matches you.
type StatActivity = {
  activity_type: string;
  user_from?: string | null;
  user_to?: string | null;
};

const SWAP_TYPES = new Set<string>([
  ACTIVITY_TYPES.OFFER_CREATED,
  ACTIVITY_TYPES.OFFER_FILLED,
  ACTIVITY_TYPES.SWAP_INITIATED,
  ACTIVITY_TYPES.SWAP_SETTLED,
  ACTIVITY_TYPES.EXCHANGE_VERIFIED,
]);

const STEALTH_TYPES = new Set<string>([
  ACTIVITY_TYPES.STEALTH_SENT,
  ACTIVITY_TYPES.STEALTH_CLAIM_STARTED,
  ACTIVITY_TYPES.STEALTH_CLAIMED,
]);

const GROUP_SPLIT_TYPES = new Set<string>([
  ACTIVITY_TYPES.GROUP_EXPENSE,
  ACTIVITY_TYPES.GROUP_SETTLEMENT,
  ACTIVITY_TYPES.DEBT_SETTLED,
]);

const GIFT_TYPES = new Set<string>([
  ACTIVITY_TYPES.GIFT_CREATED,
  ACTIVITY_TYPES.GIFT_CLAIMED,
]);

function computeStats(activities: StatActivity[], myAddress: string | undefined): ActivityStats {
  let sentCount = 0;
  let receivedCount = 0;
  let swapCount = 0;
  let groupSplitCount = 0;
  let stealthCount = 0;
  let giftCount = 0;

  const me = myAddress?.toLowerCase();

  for (const a of activities) {
    const type = a.activity_type;
    const isSent = me ? a.user_from?.toLowerCase() === me : false;
    const isReceived = me ? a.user_to?.toLowerCase() === me : false;

    // Direction-based sent/received counts (works for all types)
    if (isSent) sentCount++;
    else if (isReceived) receivedCount++;

    // Category buckets independent of direction
    if (SWAP_TYPES.has(type)) swapCount++;
    if (STEALTH_TYPES.has(type)) stealthCount++;
    if (GROUP_SPLIT_TYPES.has(type)) groupSplitCount++;
    if (GIFT_TYPES.has(type)) giftCount++;
  }

  return { sentCount, receivedCount, swapCount, groupSplitCount, stealthCount, giftCount };
}

// ---------------------------------------------------------------
//  STAT CARD
// ---------------------------------------------------------------

function StatCard({
  label,
  count,
  icon: Icon,
  iconBg,
  iconColor,
}: {
  label: string;
  count: number;
  icon: typeof Send;
  iconBg: string;
  iconColor: string;
}) {
  return (
    <div className="rounded-[2rem] glass-card p-6 hover:-translate-y-1 transition-all duration-300">
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
        style={{ background: iconBg }}
      >
        <Icon size={22} color={iconColor} strokeWidth={2} />
      </div>
      <p
        className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-1"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        {count}
      </p>
      <p className="text-sm text-[var(--text-primary)]/50">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------
//  MONTHLY BAR CHART
// ---------------------------------------------------------------

function MonthlyChart({
  activities,
  myAddress,
}: {
  activities: { created_at: string; activity_type: string; user_from?: string | null; user_to?: string | null }[];
  myAddress: string | undefined;
}) {
  const monthlyData = useMemo(() => {
    const now = new Date();
    const sentByMonth: Record<string, number> = {};
    const receivedByMonth: Record<string, number> = {};
    const me = myAddress?.toLowerCase();

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      sentByMonth[key] = 0;
      receivedByMonth[key] = 0;
    }

    for (const a of activities) {
      const d = new Date(a.created_at);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      if (!(key in sentByMonth)) continue;
      // Direction by address position — same semantics as History.tsx
      // (an activity with user_from === me is outgoing, user_to === me is incoming).
      if (me && a.user_from?.toLowerCase() === me) {
        sentByMonth[key]++;
      } else if (me && a.user_to?.toLowerCase() === me) {
        receivedByMonth[key]++;
      }
    }

    const months = Object.keys(sentByMonth);
    const maxVal = Math.max(
      ...months.map((m) => sentByMonth[m] + receivedByMonth[m]),
      1,
    );

    return months.map((month) => ({
      month,
      sent: sentByMonth[month],
      received: receivedByMonth[month],
      sentPct: Math.max((sentByMonth[month] / maxVal) * 100, 3),
      receivedPct: Math.max((receivedByMonth[month] / maxVal) * 100, 3),
    }));
  }, [activities]);

  return (
    <div className="rounded-[2rem] glass-card p-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
          Monthly Activity
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-[#007AFF]" />
            <span className="text-xs text-[var(--text-primary)]/50 font-medium">
              Sent
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-emerald-500" />
            <span className="text-xs text-[var(--text-primary)]/50 font-medium">
              Received
            </span>
          </div>
        </div>
      </div>

      {monthlyData.every((b) => b.sent === 0 && b.received === 0) ? (
        <div className="flex items-center justify-center" style={{ height: 160 }}>
          <p className="text-sm text-[var(--text-primary)]/40 italic text-center">
            No activity in the last 6 months yet. Sent and received counts
            will plot here as you transact.
          </p>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-3" style={{ height: 160 }}>
          {monthlyData.map((bar) => (
            <div key={bar.month} className="flex-1 flex flex-col items-center gap-2">
              <div
                className="w-full flex flex-col items-center gap-1"
                style={{ height: 130, justifyContent: "flex-end" }}
              >
                {bar.received > 0 && (
                  <div
                    className="w-full max-w-[28px] rounded-t-lg transition-all duration-300"
                    style={{
                      height: `${bar.receivedPct}%`,
                      minHeight: 4,
                      background: "#10B981",
                    }}
                  />
                )}
                {bar.sent > 0 && (
                  <div
                    className="w-full max-w-[28px] rounded-b-lg transition-all duration-300"
                    style={{
                      height: `${bar.sentPct}%`,
                      minHeight: 4,
                      background: "#007AFF",
                    }}
                  />
                )}
                {bar.sent === 0 && bar.received === 0 && (
                  <div
                    className="w-full max-w-[28px] rounded-lg"
                    style={{ height: 4, background: "rgba(0,0,0,0.04)" }}
                  />
                )}
              </div>
              <span className="text-xs text-[var(--text-primary)]/50 font-medium">
                {bar.month}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-[var(--text-primary)]/40 text-center mt-4 italic">
        Amounts encrypted via FHE. Only counts shown
      </p>
    </div>
  );
}

// ---------------------------------------------------------------
//  BREAKDOWN BAR
// ---------------------------------------------------------------

function BreakdownItem({
  label,
  count,
  maxCount,
  color,
  icon: Icon,
}: {
  label: string;
  count: number;
  maxCount: number;
  color: string;
  icon: typeof Send;
}) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

  return (
    <div className="flex items-center gap-4 py-3">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${color}15` }}
      >
        <Icon size={18} style={{ color }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {label}
          </span>
          <span
            className="text-sm font-semibold text-[var(--text-primary)]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {count}
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-black/5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              minWidth: count > 0 ? 4 : 0,
              background: color,
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Analytics() {
  // Use effectiveAddress so passkey-only users get a valid sender/receiver
  // identity. Wagmi's useAccount() returns undefined in that mode, which
  // silently zero'd the monthly bars while category totals still rendered.
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activities, isLoading } = useActivityFeed();

  const stats = useMemo(() => computeStats(activities, address), [activities, address]);

  const totalActivities = activities.length;
  const maxBreakdown = Math.max(
    stats.sentCount,
    stats.receivedCount,
    stats.groupSplitCount,
    stats.stealthCount,
    stats.swapCount,
    stats.giftCount,
    1,
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
              Private Analytics
            </h1>
            <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
              Only visible to you -- all amounts encrypted
            </p>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-50 border border-purple-100">
            <EyeOff size={16} className="text-purple-600" />
            <span className="text-sm font-medium text-purple-600">
              Private
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        {isLoading && activities.length === 0 ? (
          <div className="grid grid-cols-2 gap-4 mb-6">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-[2rem] glass-card p-6"
                style={{ minHeight: 130 }}
              >
                <div className="shimmer w-12 h-12 rounded-xl mb-4" />
                <div className="shimmer w-3/4 h-6 rounded mb-2" />
                <div className="shimmer w-1/2 h-4 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <StatCard
              label="Sent"
              count={stats.sentCount}
              icon={Send}
              iconBg="rgba(0, 122, 255, 0.08)"
              iconColor="#007AFF"
            />
            <StatCard
              label="Received"
              count={stats.receivedCount}
              icon={ArrowDownRight}
              iconBg="rgba(16, 185, 129, 0.08)"
              iconColor="#10B981"
            />
            <StatCard
              label="Swaps"
              count={stats.swapCount}
              icon={ArrowLeftRight}
              iconBg="rgba(245, 158, 11, 0.08)"
              iconColor="#F59E0B"
            />
            <StatCard
              label="Total"
              count={totalActivities}
              icon={TrendingUp}
              iconBg="rgba(139, 92, 246, 0.08)"
              iconColor="#8B5CF6"
            />
          </div>
        )}

        {/* Monthly Chart */}
        <div className="mb-6">
          <MonthlyChart activities={activities} myAddress={address} />
        </div>

        {/* Activity Breakdown */}
        <div className="rounded-[2rem] glass-card p-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
              Activity Breakdown
            </h3>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-50 border border-gray-100">
              <span
                className="text-sm font-medium text-[var(--text-primary)]/60"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {totalActivities} total
              </span>
            </div>
          </div>

          <div className="divide-y divide-black/5">
            <BreakdownItem
              label="Transactions sent"
              count={stats.sentCount}
              maxCount={maxBreakdown}
              color="#007AFF"
              icon={Send}
            />
            <BreakdownItem
              label="Received"
              count={stats.receivedCount}
              maxCount={maxBreakdown}
              color="#10B981"
              icon={ArrowDownRight}
            />
            <BreakdownItem
              label="Group splits"
              count={stats.groupSplitCount}
              maxCount={maxBreakdown}
              color="#8B5CF6"
              icon={Users}
            />
            <BreakdownItem
              label="Stealth payments"
              count={stats.stealthCount}
              maxCount={maxBreakdown}
              color="#1D1D1F"
              icon={Ghost}
            />
            <BreakdownItem
              label="Gifts"
              count={stats.giftCount}
              maxCount={maxBreakdown}
              color="#EC4899"
              icon={Gift}
            />
            <BreakdownItem
              label="Swaps"
              count={stats.swapCount}
              maxCount={maxBreakdown}
              color="#F59E0B"
              icon={ArrowLeftRight}
            />
          </div>
        </div>

        {/* Privacy Notice */}
        <div className="mt-6 p-4 rounded-2xl bg-emerald-50 border border-emerald-100">
          <div className="flex items-start gap-3">
            <Shield size={20} className="text-emerald-600 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-emerald-900">
                FHE Protected Analytics
              </p>
              <p className="text-xs text-emerald-700 mt-1">
                All financial amounts are encrypted with Fully Homomorphic
                Encryption. Transaction counts are derived from on-chain events
                only you can see.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
