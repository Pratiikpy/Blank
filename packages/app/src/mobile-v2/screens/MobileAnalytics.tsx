import { useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  EyeOff,
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  TrendingUp,
  Send,
} from "lucide-react";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";

// ═══════════════════════════════════════════════════════════════════
//  STAT COMPUTATION
// ═══════════════════════════════════════════════════════════════════

interface ActivityStats {
  totalSent: number;
  totalReceived: number;
  totalSwapped: number;
  sentCount: number;
  receivedCount: number;
  swapCount: number;
  groupSplitCount: number;
  stealthCount: number;
}

function computeStats(activities: { activity_type: string }[]): ActivityStats {
  let sentCount = 0;
  let receivedCount = 0;
  let swapCount = 0;
  let groupSplitCount = 0;
  let stealthCount = 0;

  for (const a of activities) {
    switch (a.activity_type) {
      case "send":
      case "tip":
      case "gift":
        sentCount++;
        break;
      case "receive":
      case "request_fulfilled":
        receivedCount++;
        break;
      case "swap":
        swapCount++;
        break;
      case "group_split":
        groupSplitCount++;
        break;
      case "stealth_send":
      case "stealth_claim":
        stealthCount++;
        break;
    }
  }

  return {
    totalSent: sentCount,
    totalReceived: receivedCount,
    totalSwapped: swapCount,
    sentCount,
    receivedCount,
    swapCount,
    groupSplitCount,
    stealthCount,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  MONTHLY BAR CHART (styled divs)
// ═══════════════════════════════════════════════════════════════════

function MonthlyChart({ activities }: { activities: { created_at: string }[] }) {
  const monthlyData = useMemo(() => {
    const months: Record<string, number> = {};
    const now = new Date();

    // Initialize last 6 months
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      months[key] = 0;
    }

    // Count activities per month
    for (const a of activities) {
      const d = new Date(a.created_at);
      const key = d.toLocaleDateString("en-US", { month: "short" });
      if (key in months) {
        months[key]++;
      }
    }

    const entries = Object.entries(months);
    const maxVal = Math.max(...entries.map(([, v]) => v), 1);
    return entries.map(([month, count]) => ({
      month,
      count,
      height: Math.max((count / maxVal) * 100, 4), // min 4% so empty months are visible
    }));
  }, [activities]);

  return (
    <div className="mobile-card" style={{ marginTop: 16, padding: 16 }}>
      <span className="mobile-section-title" style={{ display: "block", marginBottom: 16 }}>
        Monthly Activity
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 8,
          height: 120,
          padding: "0 4px",
        }}
      >
        {monthlyData.map((bar) => (
          <div
            key={bar.month}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              flex: 1,
            }}
          >
            {/* Bar */}
            <div
              style={{
                width: "100%",
                maxWidth: 32,
                height: `${bar.height}%`,
                minHeight: 4,
                borderRadius: 6,
                background:
                  bar.count > 0
                    ? "linear-gradient(180deg, var(--primary) 0%, var(--primary-light) 100%)"
                    : "rgba(0,0,0,0.04)",
                transition: "height 300ms ease",
              }}
              aria-label={`${bar.month}: ${bar.count} transactions`}
            />
            {/* Count */}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: bar.count > 0 ? "var(--primary)" : "var(--text-tertiary)",
              }}
            >
              {bar.count}
            </span>
            {/* Label */}
            <span
              style={{
                fontSize: 10,
                color: "var(--text-tertiary)",
                fontWeight: 500,
              }}
            >
              {bar.month}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  BREAKDOWN PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════

function BreakdownItem({
  label,
  count,
  maxCount,
  color,
}: {
  label: string;
  count: number;
  maxCount: number;
  color: string;
}) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

  return (
    <div style={{ padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text-primary)",
          }}
        >
          {label}
        </span>
        <span
          className="mobile-mono"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {count}
        </span>
      </div>
      <div
        style={{
          width: "100%",
          height: 6,
          borderRadius: 3,
          background: "rgba(0,0,0,0.04)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            background: color,
            transition: "width 300ms ease",
            minWidth: count > 0 ? 4 : 0,
          }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  STAT CARD
// ═══════════════════════════════════════════════════════════════════

function StatCard({
  label,
  icon: Icon,
  iconBg,
  iconColor,
}: {
  label: string;
  icon: typeof ArrowUpRight;
  iconBg: string;
  iconColor: string;
}) {
  return (
    <div
      className="mobile-card"
      style={{
        padding: "14px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={18} color={iconColor} strokeWidth={2} />
      </div>
      <div>
        <span
          className="mobile-mono"
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "var(--text-primary)",
            display: "block",
          }}
        >
          ${ENCRYPTED_PLACEHOLDER}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            fontWeight: 500,
            display: "block",
            marginTop: 2,
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════

export function MobileAnalytics() {
  const navigate = useNavigate();
  const { activities, isLoading } = useActivityFeed();

  const stats = useMemo(() => computeStats(activities), [activities]);

  const totalActivities = activities.length;
  const maxBreakdown = Math.max(
    stats.sentCount,
    stats.receivedCount,
    stats.groupSplitCount,
    stats.stealthCount,
    stats.swapCount,
    1,
  );

  const handleBack = useCallback(() => {
    navigate("/m/explore");
  }, [navigate]);

  return (
    <div style={{ padding: "0 16px", minHeight: "100dvh" }}>
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 0 4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="mobile-header-back"
            onClick={handleBack}
            aria-label="Go back"
          >
            <ArrowLeft size={18} strokeWidth={2} color="var(--text-secondary)" />
          </button>
          <div>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              Private Analytics
            </h1>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                margin: "2px 0 0",
              }}
            >
              Only visible to you
            </p>
          </div>
        </div>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(107, 114, 128, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <EyeOff size={18} color="var(--text-tertiary)" />
        </div>
      </header>

      {/* ─── Stats Grid (2x2) ───────────────────────────────────────── */}
      {isLoading && activities.length === 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 16,
          }}
        >
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="mobile-card"
              style={{ padding: "14px 12px", minHeight: 100 }}
            >
              <div className="mobile-shimmer" style={{ width: 36, height: 36, borderRadius: 10, marginBottom: 10 }} />
              <div className="mobile-shimmer" style={{ width: "70%", height: 18, marginBottom: 6 }} />
              <div className="mobile-shimmer" style={{ width: "50%", height: 12 }} />
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 16,
          }}
        >
          <StatCard
            label="Total Sent"
            icon={Send}
            iconBg="rgba(248, 113, 113, 0.1)"
            iconColor="#DC2626"
          />
          <StatCard
            label="Total Received"
            icon={ArrowDownRight}
            iconBg="rgba(52, 211, 153, 0.1)"
            iconColor="#059669"
          />
          <StatCard
            label="Swapped"
            icon={ArrowLeftRight}
            iconBg="rgba(251, 191, 36, 0.1)"
            iconColor="#D97706"
          />
          <StatCard
            label="Net Flow"
            icon={TrendingUp}
            iconBg="rgba(108, 99, 255, 0.1)"
            iconColor="#6C63FF"
          />
        </div>
      )}

      {/* ─── Monthly Chart ──────────────────────────────────────────── */}
      <MonthlyChart activities={activities} />

      {/* ─── Activity Breakdown ─────────────────────────────────────── */}
      <div className="mobile-card" style={{ marginTop: 16, padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span className="mobile-section-title">Activity Breakdown</span>
          <span
            className="mobile-mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-tertiary)",
            }}
          >
            {totalActivities} total
          </span>
        </div>

        <BreakdownItem
          label="Transactions sent"
          count={stats.sentCount}
          maxCount={maxBreakdown}
          color="#DC2626"
        />
        <BreakdownItem
          label="Received"
          count={stats.receivedCount}
          maxCount={maxBreakdown}
          color="#059669"
        />
        <BreakdownItem
          label="Group splits"
          count={stats.groupSplitCount}
          maxCount={maxBreakdown}
          color="#6C63FF"
        />
        <BreakdownItem
          label="Stealth payments"
          count={stats.stealthCount}
          maxCount={maxBreakdown}
          color="#1A1A2E"
        />
        <BreakdownItem
          label="Swaps"
          count={stats.swapCount}
          maxCount={maxBreakdown}
          color="#D97706"
        />
      </div>

      {/* Bottom spacer */}
      <div style={{ height: 24 }} />
    </div>
  );
}

export default MobileAnalytics;
