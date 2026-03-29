import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  ArrowLeft,
  SlidersHorizontal,
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Shield,
  Lock,
  Ghost,
  Clock,
} from "lucide-react";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import type { ActivityRow } from "@/lib/supabase";

// ═══════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const FILTER_TABS = [
  { key: "all", label: "All" },
  { key: "receive", label: "Received" },
  { key: "send", label: "Sent" },
  { key: "swap", label: "Swap" },
  { key: "stealth", label: "Stealth" },
] as const;

type FilterKey = (typeof FILTER_TABS)[number]["key"];

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function activityLabel(type: string): string {
  const map: Record<string, string> = {
    shield: "Shielded",
    unshield: "Unshielded",
    send: "Sent",
    receive: "Received",
    swap: "Swapped",
    gift: "Gift sent",
    tip: "Tipped",
    group_split: "Group split",
    request_fulfilled: "Request paid",
    stealth_send: "Stealth sent",
    stealth_claim: "Stealth claimed",
  };
  return map[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function activityDescription(activity: ActivityRow, currentAddress: string): string {
  if (activity.note) return activity.note;
  const isSender = activity.user_from.toLowerCase() === currentAddress.toLowerCase();
  const peer = isSender ? activity.user_to : activity.user_from;
  if (activity.activity_type === "shield") return "Deposited to vault";
  if (activity.activity_type === "unshield") return "Withdrew from vault";
  if (activity.activity_type === "swap") return "Token exchange";
  return `${isSender ? "To" : "From"} ${shortenAddress(peer)}`;
}

function isReceivedType(type: string): boolean {
  return type === "receive" || type === "request_fulfilled" || type === "stealth_claim";
}

function getStatusLabel(activity: ActivityRow): { label: string; className: string } {
  if (activity.block_number > 0) {
    return { label: "Confirmed", className: "mobile-badge-status mobile-badge-confirmed" };
  }
  return { label: "Pending", className: "mobile-badge-status mobile-badge-pending" };
}

function matchesFilter(activity: ActivityRow, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "receive") return isReceivedType(activity.activity_type);
  if (filter === "send") return activity.activity_type === "send" || activity.activity_type === "tip" || activity.activity_type === "gift";
  if (filter === "swap") return activity.activity_type === "swap";
  if (filter === "stealth") return activity.activity_type === "stealth_send" || activity.activity_type === "stealth_claim";
  return true;
}

// ═══════════════════════════════════════════════════════════════════
//  ICON COMPONENT
// ═══════════════════════════════════════════════════════════════════

function ActivityTypeIcon({ type }: { type: string }) {
  const size = 18;
  if (type === "send" || type === "tip" || type === "gift")
    return <ArrowUpRight size={size} />;
  if (isReceivedType(type))
    return <ArrowDownRight size={size} />;
  if (type === "shield") return <Shield size={size} />;
  if (type === "unshield") return <Lock size={size} />;
  if (type === "stealth_send" || type === "stealth_claim")
    return <Ghost size={size} />;
  return <ArrowLeftRight size={size} />;
}

function iconClassName(type: string): string {
  if (type === "send" || type === "tip" || type === "gift")
    return "mobile-tx-icon mobile-tx-icon-send";
  if (isReceivedType(type))
    return "mobile-tx-icon mobile-tx-icon-receive";
  if (type === "shield" || type === "unshield")
    return "mobile-tx-icon mobile-tx-icon-shield";
  return "mobile-tx-icon mobile-tx-icon-swap";
}

// ═══════════════════════════════════════════════════════════════════
//  TRANSACTION LIST ITEM
// ═══════════════════════════════════════════════════════════════════

function TransactionItem({
  activity,
  currentAddress,
}: {
  activity: ActivityRow;
  currentAddress: string;
}) {
  const received = isReceivedType(activity.activity_type);
  const status = getStatusLabel(activity);

  return (
    <div className="mobile-tx-item" role="listitem">
      <div className={iconClassName(activity.activity_type)}>
        <ActivityTypeIcon type={activity.activity_type} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                display: "block",
              }}
            >
              {activityLabel(activity.activity_type)}
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                display: "block",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activityDescription(activity, currentAddress)}
            </span>
          </div>

          <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
            <span
              className="mobile-mono"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: received ? "var(--success-dark)" : "var(--text-primary)",
                display: "block",
              }}
            >
              {received ? "+" : "-"}${ENCRYPTED_PLACEHOLDER}
            </span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
              <span className={status.className}>{status.label}</span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                {formatDate(activity.created_at)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════

export function MobileHistory() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const { activities, isLoading } = useActivityFeed();
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  const filtered = useMemo(
    () => activities.filter((a) => matchesFilter(a, activeFilter)),
    [activities, activeFilter],
  );

  const handleBack = useCallback(() => {
    navigate("/m");
  }, [navigate]);

  return (
    <div style={{ padding: "0 16px", minHeight: "100dvh" }}>
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 0 12px",
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
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Activity
          </h1>
        </div>
        <button
          className="mobile-header-back"
          aria-label="Filter options"
          style={{ opacity: 0.6 }}
        >
          <SlidersHorizontal size={18} strokeWidth={2} color="var(--text-secondary)" />
        </button>
      </header>

      {/* ─── Filter Tabs ────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          paddingBottom: 16,
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
      >
        {FILTER_TABS.map((tab) => {
          const isActive = activeFilter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveFilter(tab.key)}
              style={{
                padding: "8px 18px",
                borderRadius: 20,
                border: "none",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                transition: "all 200ms ease",
                background: isActive ? "var(--primary)" : "transparent",
                color: isActive ? "#FFFFFF" : "var(--text-tertiary)",
                WebkitTapHighlightColor: "transparent",
              }}
              aria-pressed={isActive}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ─── Transaction List ───────────────────────────────────────── */}
      <div className="mobile-card" style={{ padding: "4px 16px" }}>
        {isLoading && activities.length === 0 ? (
          <div style={{ padding: "12px 0" }} role="status" aria-label="Loading transactions">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 0",
                  borderBottom: i < 5 ? "1px solid rgba(0,0,0,0.04)" : "none",
                }}
              >
                <div
                  className="mobile-shimmer"
                  style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div className="mobile-shimmer" style={{ width: "55%", height: 14, marginBottom: 8 }} />
                  <div className="mobile-shimmer" style={{ width: "35%", height: 10 }} />
                </div>
                <div>
                  <div className="mobile-shimmer" style={{ width: 70, height: 14, marginBottom: 8, marginLeft: "auto" }} />
                  <div className="mobile-shimmer" style={{ width: 50, height: 10, marginLeft: "auto" }} />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: "var(--primary-ghost)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 14px",
              }}
            >
              <Clock size={26} color="var(--primary)" />
            </div>
            <p
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
                margin: "0 0 6px",
              }}
            >
              No transactions yet
            </p>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-tertiary)",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {activeFilter === "all"
                ? "Send or shield tokens to get started"
                : `No ${FILTER_TABS.find((t) => t.key === activeFilter)?.label.toLowerCase()} transactions`}
            </p>
          </div>
        ) : (
          <div role="list" aria-label="Transaction history">
            {filtered.map((activity) => (
              <TransactionItem
                key={activity.id}
                activity={activity}
                currentAddress={address ?? ""}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom spacer for scroll clearance */}
      <div style={{ height: 24 }} />
    </div>
  );
}

export default MobileHistory;
