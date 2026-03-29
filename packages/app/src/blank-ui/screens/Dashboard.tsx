import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  Send,
  ArrowDownLeft,
  ArrowLeftRight,
  MoreHorizontal,
  Eye,
  EyeOff,
  Shield,
  Lock,
  Database,
  TrendingUp,
  CheckCircle,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { useShield } from "@/hooks/useShield";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const activityTypeIcons: Record<string, { icon: React.ReactNode; bg: string }> = {
  payment: { icon: <Send size={18} />, bg: "bg-[#1D1D1F] dark:bg-white" },
  receive: { icon: <ArrowDownLeft size={18} />, bg: "bg-emerald-500" },
  shield: { icon: <Lock size={18} />, bg: "bg-amber-500" },
  swap: { icon: <ArrowLeftRight size={18} />, bg: "bg-emerald-500" },
  stealth: { icon: <EyeOff size={18} />, bg: "bg-gray-900 dark:bg-gray-100" },
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const { activities, isLoading: feedLoading } = useActivityFeed();
  const balance = useEncryptedBalance();
  const { mintTestTokens, shield, publicBalance, isMinting } = useShield();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [privacyMode, setPrivacyMode] = useState(true);
  const [shieldAmount, setShieldAmount] = useState("");

  const handleMint = async () => {
    await mintTestTokens();
  };

  const greeting = useMemo(() => getGreeting(), []);
  const displayAddress = address ? truncateAddress(address) : "";
  const recentActivities = activities.slice(0, 5);

  const quickActions = [
    {
      label: "Send Money",
      icon: <Send size={20} strokeWidth={2.2} />,
      variant: "primary" as const,
      route: "/send",
    },
    {
      label: "Receive",
      icon: <ArrowDownLeft size={20} strokeWidth={2.2} />,
      variant: "secondary" as const,
      route: "/receive",
    },
    {
      label: "Swap Tokens",
      icon: <ArrowLeftRight size={20} strokeWidth={2.2} />,
      variant: "secondary" as const,
      route: "/swap",
    },
    {
      label: "More...",
      icon: <MoreHorizontal size={20} strokeWidth={2.2} />,
      variant: "ghost" as const,
      route: "/explore",
    },
  ];

  // ─── Mobile layout ────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="max-w-7xl mx-auto space-y-6 px-5">
          {/* Header */}
          <div>
            <h1
              className="text-4xl font-semibold tracking-tight text-[var(--text-primary)] mb-2"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              {greeting}, {displayAddress || "there"}
            </h1>
            <p className="text-base text-[var(--text-secondary)] leading-relaxed">
              Your financial privacy is protected with Fully Homomorphic Encryption
            </p>
          </div>

          {/* Balance Card */}
          <BalanceCard
            balance={balance}
            privacyMode={privacyMode}
            onTogglePrivacy={() => setPrivacyMode((p) => !p)}
            activityCount={activities.length}
          />

          {/* Shield Section */}
          <div className="glass-card-static rounded-[2rem] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">DEPOSIT TO VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Shield USDC to enable encrypted payments</p>
              </div>
              <button onClick={handleMint} disabled={isMinting} className="h-10 px-4 rounded-full bg-emerald-50 text-emerald-600 font-medium text-sm hover:bg-emerald-100 transition-colors disabled:opacity-50">
                {isMinting ? "Minting..." : "Get Test USDC"}
              </button>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={shieldAmount}
                  onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setShieldAmount(v); }}
                  placeholder="0.00"
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums"
                />
              </div>
              <button
                onClick={async () => { if (shieldAmount) { await shield(shieldAmount); setShieldAmount(""); } }}
                disabled={!shieldAmount || parseFloat(shieldAmount) <= 0}
                className="h-14 px-8 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Shield
              </button>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Public USDC Balance:</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{publicBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC</span>
            </div>
          </div>

          {/* Unshield Section (mobile) */}
          <div className="glass-card-static rounded-[2rem] p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">WITHDRAW FROM VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Unshield encrypted USDC back to public balance</p>
              </div>
            </div>
            <p className="text-xs text-[var(--text-tertiary)] mt-3">
              Unshield requires async FHE decryption. Request unshield &rarr; wait for decryption &rarr; claim tokens.
              This feature requires CoFHE to be connected.
            </p>
          </div>

          {/* Quick Actions */}
          <div className="glass-card-static rounded-[2rem] p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Quick Actions
            </h3>
            <div className="flex flex-col gap-3">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  onClick={() => navigate(action.route)}
                  className={cn(
                    "h-14 px-6 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-3",
                    action.variant === "primary"
                      ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-[#000000] dark:hover:bg-gray-100"
                      : action.variant === "secondary"
                        ? "bg-black/5 dark:bg-white/10 text-[var(--text-primary)] hover:bg-black/10 dark:hover:bg-white/20"
                        : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5",
                  )}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <ActivityList
            activities={recentActivities}
            isLoading={feedLoading}
            address={address}
            privacyMode={privacyMode}
            onViewAll={() => navigate("/history")}
          />
        </div>
      </div>
    );
  }

  // ─── Desktop layout (bento grid, 12 columns) ─────────────────────
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1
            className="text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
            style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
          >
            {greeting}, {displayAddress || "there"}
          </h1>
          <p className="text-base text-[var(--text-secondary)] leading-relaxed">
            Your financial privacy is protected with Fully Homomorphic Encryption
          </p>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Balance Card - Hero (col-span-8, row-span-2) */}
          <div className="col-span-full md:col-span-8 row-span-2">
            <BalanceCard
              balance={balance}
              privacyMode={privacyMode}
              onTogglePrivacy={() => setPrivacyMode((p) => !p)}
              activityCount={activities.length}
              large
            />
          </div>

          {/* Quick Actions (col-span-4, row-span-2) */}
          <div className="col-span-full md:col-span-4 row-span-2 rounded-[2rem] glass-card-static p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Quick Actions
            </h3>
            <div className="flex flex-col gap-3">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  onClick={() => navigate(action.route)}
                  className={cn(
                    "h-14 px-6 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-3",
                    action.variant === "primary"
                      ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-[#000000] dark:hover:bg-gray-100"
                      : action.variant === "secondary"
                        ? "bg-black/5 dark:bg-white/10 text-[var(--text-primary)] hover:bg-black/10 dark:hover:bg-white/20"
                        : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5",
                  )}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Shield Section (col-span-full) */}
          <div className="col-span-full rounded-[2rem] glass-card-static p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">DEPOSIT TO VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Shield USDC to enable encrypted payments</p>
              </div>
              <button onClick={handleMint} disabled={isMinting} className="h-10 px-4 rounded-full bg-emerald-50 text-emerald-600 font-medium text-sm hover:bg-emerald-100 transition-colors disabled:opacity-50">
                {isMinting ? "Minting..." : "Get Test USDC"}
              </button>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={shieldAmount}
                  onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setShieldAmount(v); }}
                  placeholder="0.00"
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums"
                />
              </div>
              <button
                onClick={async () => { if (shieldAmount) { await shield(shieldAmount); setShieldAmount(""); } }}
                disabled={!shieldAmount || parseFloat(shieldAmount) <= 0}
                className="h-14 px-8 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Shield
              </button>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Public USDC Balance:</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{publicBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC</span>
            </div>
          </div>

          {/* Unshield Section */}
          <div className="col-span-full rounded-[2rem] glass-card-static p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">WITHDRAW FROM VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Unshield encrypted USDC back to public balance</p>
              </div>
            </div>
            <p className="text-xs text-[var(--text-tertiary)] mt-3">
              Unshield requires async FHE decryption. Request unshield &rarr; wait for decryption &rarr; claim tokens.
              This feature requires CoFHE to be connected.
            </p>
          </div>

          {/* Recent Activity (col-span-7) */}
          <div className="col-span-full md:col-span-7 rounded-[2rem] glass-card-static p-8">
            <ActivityList
              activities={recentActivities}
              isLoading={feedLoading}
              address={address}
              privacyMode={privacyMode}
              onViewAll={() => navigate("/history")}
            />
          </div>

          {/* Encryption Status (col-span-5) */}
          <div className="col-span-full md:col-span-5 rounded-[2rem] glass-card-static p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Encryption Status
            </h3>
            <div className="space-y-4">
              {/* FHE Active */}
              <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center">
                    <Shield size={20} className="text-white" />
                  </div>
                  <div>
                    <p className="font-medium text-emerald-900 dark:text-emerald-300">
                      FHE Active
                    </p>
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                      All amounts encrypted
                    </p>
                  </div>
                </div>
                <CheckCircle size={24} className="text-emerald-600 dark:text-emerald-400" />
              </div>

              {/* Async Decryption */}
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <Clock size={20} className="text-blue-600 dark:text-blue-400" strokeWidth={2.2} />
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)]">
                      Decryption
                    </p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      ~2s async
                    </p>
                  </div>
                </div>
              </div>

              {/* Vault Status */}
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                    <Database size={20} className="text-amber-600 dark:text-amber-400" strokeWidth={2.2} />
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)]">
                      Vault Status
                    </p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {balance.isInitialized ? "Synced" : "Not initialized"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Balance Card Sub-Component
// ═══════════════════════════════════════════════════════════════════════

interface BalanceCardProps {
  balance: ReturnType<typeof useEncryptedBalance>;
  privacyMode: boolean;
  onTogglePrivacy: () => void;
  large?: boolean;
  activityCount?: number;
}

function BalanceCard({ balance, privacyMode, onTogglePrivacy, large, activityCount = 0 }: BalanceCardProps) {
  const formattedBalance = useMemo(() => {
    if (balance.raw === null || balance.raw === undefined) return null;
    const num = Number(balance.raw) / 1e6;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  }, [balance.raw]);

  const displayAmount = privacyMode && !balance.isRevealed;

  return (
    <div className="rounded-[2rem] glass-card-static p-8 relative overflow-hidden h-full">
      {/* Glass reflection effect */}
      <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-white/40 dark:from-white/5 dark:to-white/10 pointer-events-none" />

      <div className="relative z-10 h-full flex flex-col justify-between">
        {/* Top section */}
        <div>
          <div className="flex items-center justify-between mb-12">
            <div>
              <p className="text-sm text-[var(--text-secondary)] font-medium tracking-wide uppercase mb-2">
                Total Balance
              </p>
              <div className="flex items-baseline gap-2">
                <span className="text-lg text-[var(--text-secondary)]">$</span>
                <h2
                  className={cn(
                    "font-medium",
                    large ? "text-6xl" : "text-5xl",
                    displayAmount
                      ? "encrypted-text text-[var(--text-tertiary)]"
                      : "decrypted-text text-[var(--text-primary)]",
                  )}
                  style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
                >
                  {displayAmount
                    ? "\u2588\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"
                    : formattedBalance || "0.00"}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Shield size={16} className="text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                FHE Protected
              </span>
            </div>
          </div>

          {/* Subtitle + eye toggle */}
          <div className="flex items-center gap-3 mb-8">
            <span className="text-sm text-[var(--text-secondary)]">
              USDC &middot; Base Sepolia
            </span>
            <button
              onClick={() => {
                balance.toggleReveal();
                onTogglePrivacy();
              }}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              aria-label={displayAmount ? "Reveal balance" : "Hide balance"}
            >
              {displayAmount ? (
                <Eye size={18} className="text-[var(--text-tertiary)]" />
              ) : (
                <EyeOff size={18} className="text-[var(--text-tertiary)]" />
              )}
            </button>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 p-6">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp size={20} className="text-emerald-600 dark:text-emerald-400" strokeWidth={2.2} />
                <p className="text-sm text-[var(--text-secondary)] font-medium">
                  This Month
                </p>
              </div>
              <p
                className={cn(
                  "text-2xl font-medium",
                  displayAmount
                    ? "encrypted-text text-[var(--text-tertiary)]"
                    : "decrypted-text text-[var(--text-primary)]",
                )}
                style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
              >
                {displayAmount ? "\u2588\u2588\u2588\u2588\u2588\u2588" : activityCount > 0 ? `${activityCount} txns` : "—"}
              </p>
            </div>
            <div className="rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 p-6">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle size={20} className="text-blue-500" strokeWidth={2.2} />
                <p className="text-sm text-[var(--text-secondary)] font-medium">
                  Transactions
                </p>
              </div>
              <p
                className="text-2xl font-medium text-[var(--text-primary)]"
                style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
              >
                {activityCount}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Activity List Sub-Component
// ═══════════════════════════════════════════════════════════════════════

interface ActivityListProps {
  activities: ReturnType<typeof useActivityFeed>["activities"];
  isLoading: boolean;
  address: string | undefined;
  privacyMode: boolean;
  onViewAll: () => void;
}

function ActivityList({ activities, isLoading, address, privacyMode, onViewAll }: ActivityListProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3
          className="text-xl font-medium text-[var(--text-primary)]"
          style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
        >
          Recent Activity
        </h3>
        <button
          onClick={onViewAll}
          className="text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          View All
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10"
            >
              <div className="flex items-center gap-4">
                <div className="shimmer w-12 h-12 rounded-full" />
                <div className="space-y-2">
                  <div className="shimmer h-4 w-32 rounded" />
                  <div className="shimmer h-3 w-20 rounded" />
                </div>
              </div>
              <div className="shimmer h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      ) : activities.length === 0 ? (
        <div className="p-8 text-center rounded-2xl bg-black/[0.02] dark:bg-white/[0.02]">
          <p className="text-[var(--text-tertiary)]">
            No activity yet. Send or receive to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {activities.map((activity) => {
            const isIncoming =
              activity.user_to.toLowerCase() === address?.toLowerCase();
            const typeInfo = activityTypeIcons[activity.activity_type] || {
              icon: <Send size={18} />,
              bg: "bg-gray-400",
            };
            const otherAddress = isIncoming
              ? activity.user_from
              : activity.user_to;

            return (
              <div
                key={activity.id}
                className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/70 dark:hover:bg-white/10 transition-all"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={cn(
                      "w-12 h-12 rounded-full flex items-center justify-center text-white dark:text-black",
                      typeInfo.bg,
                    )}
                  >
                    {typeInfo.icon}
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)]">
                      {activity.note || truncateAddress(otherAddress)}
                    </p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {activity.activity_type.charAt(0).toUpperCase() +
                        activity.activity_type.slice(1)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      "font-medium",
                      privacyMode ? "encrypted-text" : "decrypted-text",
                      isIncoming
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-[var(--text-primary)]",
                    )}
                  >
                    {isIncoming ? "+" : "-"}${privacyMode ? "\u2588\u2588\u2588\u2588.\u2588\u2588" : "*****"}
                  </p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {isIncoming ? "Received" : "Sent"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
