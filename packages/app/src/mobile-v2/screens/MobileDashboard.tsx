import { useState, useCallback, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  Eye,
  EyeOff,
  Bell,
  Settings,
  Send,
  ArrowDownLeft,
  ArrowLeftRight,
  Ghost,
  Users,
  Gift,
  BarChart3,
  Shield,
  Lock,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  ChevronRight,
  Key,
  Clock,
} from "lucide-react";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { useShield } from "@/hooks/useShield";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import type { ActivityRow } from "@/lib/supabase";

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000,
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Map activity_type to a display-friendly label. */
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
  };
  return map[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** Resolve icon styling classes by activity type. */
function activityIconClass(type: string): string {
  if (type === "send" || type === "tip") return "mobile-tx-icon mobile-tx-icon-send";
  if (type === "receive" || type === "request_fulfilled") return "mobile-tx-icon mobile-tx-icon-receive";
  if (type === "shield" || type === "unshield") return "mobile-tx-icon mobile-tx-icon-shield";
  return "mobile-tx-icon mobile-tx-icon-swap";
}

/** Pick the correct Lucide icon for an activity type. */
function ActivityIcon({ type }: { type: string }) {
  const size = 18;
  if (type === "send" || type === "tip") return <ArrowUpRight size={size} />;
  if (type === "receive" || type === "request_fulfilled")
    return <ArrowDownRight size={size} />;
  if (type === "shield") return <Shield size={size} />;
  if (type === "unshield") return <Lock size={size} />;
  return <ArrowLeftRight size={size} />;
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENTS
// ═══════════════════════════════════════════════════════════════════

/** Balance shimmer placeholder during loading. */
function BalanceSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="mobile-shimmer" style={{ width: 140, height: 36 }} />
      <div className="mobile-shimmer" style={{ width: 90, height: 14 }} />
    </div>
  );
}

/** Single activity list item. */
function ActivityItem({
  activity,
  currentAddress,
}: {
  activity: ActivityRow;
  currentAddress: string;
}) {
  const isSender =
    activity.user_from.toLowerCase() === currentAddress.toLowerCase();
  const peerAddress = isSender ? activity.user_to : activity.user_from;

  return (
    <div className="mobile-tx-item" role="listitem">
      {/* Icon */}
      <div className={activityIconClass(activity.activity_type)}>
        <ActivityIcon type={activity.activity_type} />
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span
            className="text-sm font-semibold truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {activityLabel(activity.activity_type)}
          </span>
          <span
            className="mobile-mono text-sm font-semibold"
            style={{
              color:
                activity.activity_type === "receive" ||
                activity.activity_type === "request_fulfilled"
                  ? "var(--success-dark)"
                  : "var(--text-primary)",
            }}
          >
            {/* All amounts are encrypted -- show masked placeholder */}
            {activity.activity_type === "receive" ||
            activity.activity_type === "request_fulfilled"
              ? "+"
              : "-"}
            ${ENCRYPTED_PLACEHOLDER}
          </span>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span
            className="text-xs truncate"
            style={{ color: "var(--text-tertiary)" }}
          >
            {activity.note || shortenAddress(peerAddress)}
          </span>
          <span
            className="text-xs flex-shrink-0 ml-2"
            style={{ color: "var(--text-tertiary)" }}
          >
            {timeAgo(activity.created_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════

export function MobileDashboard() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const {
    formatted: encryptedFormatted,
    isLoading: balanceLoading,
    isRevealed,
    isDecrypted,
    toggleReveal,
    refetch: refetchBalance,
    totalDeposited,
  } = useEncryptedBalance();

  const { publicBalance } = useShield();
  const {
    activities,
    isLoading: activitiesLoading,
    refetch: refetchActivities,
  } = useActivityFeed();

  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([refetchBalance(), refetchActivities()]);
    // Small delay so the spinner is visible for feedback
    setTimeout(() => setIsRefreshing(false), 600);
  }, [refetchBalance, refetchActivities]);

  // Recent activities (show max 5 on the dashboard)
  const recentActivities = useMemo(
    () => activities.slice(0, 5),
    [activities],
  );

  // ─── Greeting ────────────────────────────────────────────────────
  const greeting = useMemo(() => getGreeting(), []);
  const displayName = address ? shortenAddress(address) : "Friend";

  // ─── Quick Actions ───────────────────────────────────────────────
  const primaryActions = [
    { icon: Send, label: "Send", path: "/m/send" },
    { icon: ArrowDownLeft, label: "Receive", path: "/m/receive" },
    { icon: ArrowLeftRight, label: "Swap", path: "/swap" },
    { icon: Ghost, label: "Stealth", path: "/stealth" },
  ];

  const secondaryActions = [
    { icon: Users, label: "Groups", path: "/groups" },
    { icon: Gift, label: "Gifts", path: "/gifts" },
    { icon: BarChart3, label: "Analytics", path: "/m/profile" },
  ];

  return (
    <div
      style={{ padding: "0 16px" }}
    >
      {/* ─── Header: Avatar + Greeting + Bell + Settings ─────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 0 8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Avatar circle */}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background:
                "linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontWeight: 700,
              fontSize: 16,
            }}
            aria-hidden="true"
          >
            {address ? address.slice(2, 4).toUpperCase() : "?"}
          </div>
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                margin: 0,
              }}
            >
              {greeting}
            </p>
            <p
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "var(--text-primary)",
                margin: 0,
                lineHeight: 1.3,
              }}
            >
              {displayName}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="mobile-header-back"
            onClick={() => navigate("/m/history")}
            aria-label="Notifications"
          >
            <Bell size={18} strokeWidth={2} color="var(--text-secondary)" />
          </button>
          <button
            className="mobile-header-back"
            onClick={() => navigate("/settings")}
            aria-label="Settings"
          >
            <Settings size={18} strokeWidth={2} color="var(--text-secondary)" />
          </button>
        </div>
      </header>

      {/* ─── Balance Card ────────────────────────────────────────── */}
      <div
        className="mobile-card-lg"
        style={{ marginTop: 12, position: "relative", overflow: "hidden" }}
      >
        {/* Decorative gradient orb */}
        <div
          style={{
            position: "absolute",
            top: -40,
            right: -40,
            width: 120,
            height: 120,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(108,99,255,0.08) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        />

        {/* Top row: label + FHE badge + refresh */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-tertiary)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Total Balance
            </span>
            <span className="mobile-badge-fhe">
              <Lock size={10} />
              FHE
            </span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-label="Refresh balance"
          >
            <RefreshCw
              size={16}
              color="var(--text-tertiary)"
              style={{
                transition: "transform 0.6s ease",
                transform: isRefreshing ? "rotate(360deg)" : "none",
              }}
            />
          </button>
        </div>

        {/* Balance amount */}
        <div style={{ textAlign: "center", padding: "8px 0 12px" }}>
          {balanceLoading ? (
            <BalanceSkeleton />
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                <span
                  className="mobile-mono"
                  style={{
                    fontSize: 36,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    lineHeight: 1.1,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {isRevealed && isDecrypted && encryptedFormatted
                    ? `$${encryptedFormatted}`
                    : `$${ENCRYPTED_PLACEHOLDER}`}
                </span>
                <button
                  onClick={toggleReveal}
                  style={{
                    background: "var(--primary-ghost)",
                    border: "none",
                    borderRadius: "50%",
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  aria-label={isRevealed ? "Hide balance" : "Reveal balance"}
                >
                  {isRevealed ? (
                    <EyeOff size={16} color="var(--primary)" />
                  ) : (
                    <Eye size={16} color="var(--primary)" />
                  )}
                </button>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  marginTop: 6,
                }}
              >
                {isRevealed
                  ? "Auto-hides in 10s"
                  : "Tap eye to reveal"}
              </p>
            </>
          )}
        </div>

        {/* Sync status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingTop: 8,
            borderTop: "1px solid rgba(0,0,0,0.04)",
          }}
        >
          <span className="mobile-sync-dot" />
          <span
            style={{
              fontSize: 11,
              color: "var(--success-dark)",
              fontWeight: 500,
            }}
          >
            FHE coprocessor synced
          </span>
        </div>
      </div>

      {/* ─── Public Balance Summary ──────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 12,
        }}
      >
        <div
          className="mobile-card"
          style={{ flex: 1, textAlign: "center", padding: "12px 8px" }}
        >
          <p
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              margin: 0,
              textTransform: "uppercase",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Public USDC
          </p>
          <p
            className="mobile-mono"
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: "4px 0 0",
            }}
          >
            ${publicBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div
          className="mobile-card"
          style={{ flex: 1, textAlign: "center", padding: "12px 8px" }}
        >
          <p
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              margin: 0,
              textTransform: "uppercase",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Vault TVL
          </p>
          <p
            className="mobile-mono"
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: "4px 0 0",
            }}
          >
            ${totalDeposited.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* ─── Quick Actions Row 1 (Primary) ───────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-around",
          marginTop: 20,
          paddingBottom: 4,
        }}
      >
        {primaryActions.map((action) => (
          <button
            key={action.label}
            onClick={() => navigate(action.path)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              background: "none",
              border: "none",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label={action.label}
          >
            <div className="mobile-action-circle">
              <action.icon size={22} strokeWidth={2} />
            </div>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              {action.label}
            </span>
          </button>
        ))}
      </div>

      {/* ─── Quick Actions Row 2 (Secondary) ─────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 32,
          marginTop: 14,
        }}
      >
        {secondaryActions.map((action) => (
          <button
            key={action.label}
            onClick={() => navigate(action.path)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 5,
              background: "none",
              border: "none",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label={action.label}
          >
            <div className="mobile-action-circle-sm">
              <action.icon size={18} strokeWidth={2} />
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--text-tertiary)",
              }}
            >
              {action.label}
            </span>
          </button>
        ))}
      </div>

      {/* ─── Recent Activity ─────────────────────────────────────── */}
      <div style={{ marginTop: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <span className="mobile-section-title">Recent Activity</span>
          <Link to="/m/history" className="mobile-section-link">
            View all
            <ChevronRight
              size={14}
              style={{
                display: "inline",
                verticalAlign: "middle",
                marginLeft: 2,
              }}
            />
          </Link>
        </div>

        <div className="mobile-card" style={{ padding: "4px 16px" }}>
          {activitiesLoading && recentActivities.length === 0 ? (
            /* Loading skeleton */
            <div style={{ padding: "12px 0" }} role="status" aria-label="Loading activities">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 0",
                  }}
                >
                  <div
                    className="mobile-shimmer"
                    style={{ width: 40, height: 40, borderRadius: "50%" }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="mobile-shimmer"
                      style={{ width: "60%", height: 14, marginBottom: 6 }}
                    />
                    <div
                      className="mobile-shimmer"
                      style={{ width: "40%", height: 10 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : recentActivities.length === 0 ? (
            /* Empty state */
            <div
              style={{
                textAlign: "center",
                padding: "24px 0",
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "var(--primary-ghost)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 10px",
                }}
              >
                <Clock size={22} color="var(--primary)" />
              </div>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  margin: "0 0 4px",
                }}
              >
                No activity yet
              </p>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  margin: 0,
                }}
              >
                Send or shield tokens to get started
              </p>
            </div>
          ) : (
            /* Activity list */
            <div role="list" aria-label="Recent transactions">
              {recentActivities.map((activity) => (
                <ActivityItem
                  key={activity.id}
                  activity={activity}
                  currentAddress={address ?? ""}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Wallet & Keys Link ──────────────────────────────────── */}
      <button
        onClick={() => navigate("/privacy")}
        className="mobile-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          marginTop: 16,
          marginBottom: 24,
          cursor: "pointer",
          border: "none",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--primary-ghost)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Key size={18} color="var(--primary)" />
          </div>
          <div>
            <p
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              Wallet &amp; Keys
            </p>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                margin: 0,
              }}
            >
              Manage permits and privacy settings
            </p>
          </div>
        </div>
        <ChevronRight size={18} color="var(--text-tertiary)" />
      </button>
    </div>
  );
}

// Required for lazy() default import
export default MobileDashboard;
