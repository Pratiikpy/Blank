import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import {
  Send,
  ArrowDownLeft,
  MoreHorizontal,
  Eye,
  EyeOff,
  Shield,
  Lock,
  Database,
  TrendingUp,
  CheckCircle,
  Clock,
  Bell,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useCofheConnection, useCofheEncrypt } from "@/lib/cofhe-shim";
import { usePrivacyMode } from "@/providers/PrivacyModeProvider";
import { Encryptable } from "@cofhe/sdk";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { useShield } from "@/hooks/useShield";
import { useChain } from "@/providers/ChainProvider";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

import { truncateAddress } from "@/lib/address";

const activityTypeIcons: Record<string, { icon: React.ReactNode; bg: string }> = {
  payment: { icon: <Send size={18} />, bg: "bg-[#1D1D1F] dark:bg-white" },
  receive: { icon: <ArrowDownLeft size={18} />, bg: "bg-emerald-500" },
  shield: { icon: <Lock size={18} />, bg: "bg-amber-500" },
  swap: { icon: <Shield size={18} />, bg: "bg-emerald-500" },
  stealth: { icon: <EyeOff size={18} />, bg: "bg-gray-900 dark:bg-gray-100" },
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

export default function Dashboard() {
  const navigate = useNavigate();
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activities, isLoading: feedLoading } = useActivityFeed();
  const balance = useEncryptedBalance();
  const {
    mintTestTokens,
    mintTestUSDT,
    shield,
    publicBalance,
    isMinting,
    isMintingUsdt,
    step: shieldStep,
    error: shieldError,
    reset: resetShield,
    unshield,
    unshieldStep,
    unshieldError,
    hasPendingUnshield,
    retryUnshieldClaim,
  } = useShield();
  const { activeChain, contracts } = useChain();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { connected: cofheConnected } = useCofheConnection();
  // Shared global privacy state — set by sidebar toggle, consumed by
  // BalanceCard + ActivityList masks here.
  const { privacyMode, toggle: togglePrivacyMode } = usePrivacyMode();
  const [shieldAmount, setShieldAmount] = useState("");
  const [unshieldAmount, setUnshieldAmount] = useState("");
  const [faucetCooldown, setFaucetCooldown] = useState(0);
  const { encryptInputsAsync } = useCofheEncrypt();

  // Faucet cooldown timer — check localStorage on mount and tick down every
  // second. #259: split into two effects so `isMinting` toggling doesn't
  // tear down and recreate the interval mid-countdown (which caused the
  // visible 1-second jump on mint completion).
  useEffect(() => {
    const FAUCET_COOLDOWN_MS = 60_000;
    const FAUCET_KEY = "blank_last_faucet";
    const computeRemaining = () => {
      const last = parseInt(localStorage.getItem(FAUCET_KEY) || "0");
      const elapsed = Date.now() - last;
      return elapsed < FAUCET_COOLDOWN_MS ? Math.ceil((FAUCET_COOLDOWN_MS - elapsed) / 1000) : 0;
    };
    setFaucetCooldown(computeRemaining());
    const interval = setInterval(() => {
      setFaucetCooldown(computeRemaining());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // When a mint completes (`isMinting` false after being true), eagerly
  // re-read the FAUCET_KEY so the displayed countdown jumps to the new
  // window without waiting up to a second for the interval to tick.
  useEffect(() => {
    if (isMinting) return;
    const FAUCET_COOLDOWN_MS = 60_000;
    const last = parseInt(localStorage.getItem("blank_last_faucet") || "0");
    const elapsed = Date.now() - last;
    setFaucetCooldown(elapsed < FAUCET_COOLDOWN_MS ? Math.ceil((FAUCET_COOLDOWN_MS - elapsed) / 1000) : 0);
  }, [isMinting]);

  const unshieldBusy =
    unshieldStep === "encrypting" ||
    unshieldStep === "requesting" ||
    unshieldStep === "decrypting" ||
    unshieldStep === "claiming";

  const handleUnshield = async () => {
    if (!unshieldAmount || parseFloat(unshieldAmount) <= 0) { toast.error("Enter an amount to unshield"); return; }
    if (!address) return;
    const ok = await unshield(unshieldAmount, encryptInputsAsync, Encryptable);
    if (ok) setUnshieldAmount("");
  };

  const handleRetryUnshieldClaim = async () => {
    await retryUnshieldClaim();
  };

  const handleMint = async () => {
    try {
      await mintTestTokens();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint test tokens");
    }
  };

  const handleMintUsdt = async () => {
    try {
      await mintTestUSDT();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint test USDT");
    }
  };
  // Only chains with a TestUSDT deployment expose the button. ETH Sepolia
  // currently has USDC only; Base Sepolia has both. Gate the UI on config,
  // not hard-coded chain IDs, so adding USDT to another chain just works.
  const hasUsdtFaucet = Boolean(contracts.TestUSDT);

  const greeting = useMemo(() => getGreeting(), []);
  const displayAddress = address ? truncateAddress(address) : "";
  const recentActivities = activities.slice(0, 5);

  // #258: memoize so downstream effects/props that depend on `hasUnread`
  // (header pulse, nav badge) don't see a fresh reference every render.
  // Date.now() is refreshed on each memo-recompute trigger — not per render —
  // which is fine since activities re-poll on their own cadence.
  const hasUnread = useMemo(() => {
    if (activities.length === 0) return false;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const lowerAddress = address?.toLowerCase();
    return activities.some((a) => {
      const created = new Date(a.created_at).getTime();
      return created > fiveMinAgo && a.user_to.toLowerCase() === lowerAddress;
    });
  }, [activities, address]);

  const quickActions = [
    {
      label: "Send Money",
      icon: <Send size={20} strokeWidth={2.2} />,
      variant: "primary" as const,
      route: "/app/send",
    },
    {
      label: "Receive",
      icon: <ArrowDownLeft size={20} strokeWidth={2.2} />,
      variant: "secondary" as const,
      route: "/app/receive",
    },
    {
      label: "Shield Tokens",
      icon: <Shield size={20} strokeWidth={2.2} />,
      variant: "secondary" as const,
      route: "",
      scrollToShield: true,
    },
    {
      label: "More...",
      icon: <MoreHorizontal size={20} strokeWidth={2.2} />,
      variant: "ghost" as const,
      route: "/app/explore",
    },
  ];

  // ─── Mobile layout ────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div data-testid="dashboard-root" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="max-w-7xl mx-auto space-y-6 px-5">
          {/* Header */}
          <div className="flex items-start justify-between">
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
            <button
              onClick={() => navigate("/app/history")}
              className="relative w-10 h-10 rounded-full bg-white/60 border border-black/5 flex items-center justify-center hover:bg-white/80 transition-all shrink-0 mt-1"
              aria-label="Notifications"
            >
              <Bell size={20} className="text-[var(--text-primary)]" />
              {hasUnread && (
                <div className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-white" />
              )}
            </button>
          </div>

          {/* Getting Started Card (new users only) */}
          {activities.length === 0 && publicBalance === 0 && (
            <div className="glass-card-static rounded-[2rem] p-6 space-y-4 border-2 border-emerald-200">
              <h3 className="text-xl font-semibold" style={{ fontFamily: "'Outfit', sans-serif" }}>Getting Started</h3>
              <p className="text-sm text-[var(--text-secondary)]">Complete these 3 steps to start sending private payments</p>
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
                  <div className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm font-bold">1</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Get test USDC</p>
                    <p className="text-xs text-[var(--text-tertiary)]">Tap the faucet button below</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <div className="w-8 h-8 rounded-full bg-gray-300 text-white flex items-center justify-center text-sm font-bold">2</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Shield your USDC</p>
                    <p className="text-xs text-[var(--text-tertiary)]">Deposit tokens into your encrypted vault</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <div className="w-8 h-8 rounded-full bg-gray-300 text-white flex items-center justify-center text-sm font-bold">3</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Send your first private payment</p>
                    <p className="text-xs text-[var(--text-tertiary)]">Experience encrypted transactions</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Balance Card */}
          <BalanceCard
            balance={balance}
            privacyMode={privacyMode}
            onTogglePrivacy={togglePrivacyMode}
            activityCount={activities.length}
            chainName={activeChain.name}
          />

          {/* Shield Section */}
          <div id="shield-section" className="glass-card-static rounded-[2rem] p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-label text-[var(--text-secondary)]">DEPOSIT TO PRIVATE WALLET</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Deposit USDC to enable encrypted payments</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleMint} disabled={isMinting || faucetCooldown > 0} className="h-10 px-4 rounded-full bg-emerald-50 text-emerald-600 font-medium text-sm hover:bg-emerald-100 transition-colors disabled:opacity-50" aria-label="Get test USDC">
                  {isMinting ? "Minting..." : faucetCooldown > 0 ? `Try again in ${faucetCooldown}s` : "Get Test USDC"}
                </button>
                {hasUsdtFaucet && (
                  <button onClick={handleMintUsdt} disabled={isMintingUsdt} className="h-10 px-4 rounded-full bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors disabled:opacity-50" aria-label="Get test USDT">
                    {isMintingUsdt ? "Minting..." : "Get Test USDT"}
                  </button>
                )}
              </div>
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
                  aria-label="Shield amount"
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums"
                />
              </div>
              <button
                onClick={async () => { if (!shieldAmount || parseFloat(shieldAmount) <= 0) { toast.error("Enter an amount to deposit"); return; } await shield(shieldAmount); setShieldAmount(""); }}
                disabled={!shieldAmount || parseFloat(shieldAmount) <= 0}
                className="h-14 px-8 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Deposit to vault"
              >
                Deposit
              </button>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Vault Balance (Encrypted):</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{balance.formatted || "\u2022\u2022\u2022\u2022.\u2022\u2022"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Public USDC Balance:</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{publicBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC</span>
            </div>
            {/* Shield progress states */}
            {shieldStep === "approving" && (
              <div className="flex items-center gap-2 text-sm text-amber-600">
                <Loader2 size={16} className="animate-spin" />
                <span>Approving USDC...</span>
              </div>
            )}
            {shieldStep === "shielding" && (
              <div className="flex items-center gap-2 text-sm text-blue-600">
                <Loader2 size={16} className="animate-spin" />
                <span>Shielding tokens...</span>
              </div>
            )}
            {shieldStep === "success" && (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle size={16} />
                <span>Shielding complete!</span>
              </div>
            )}
            {shieldStep === "error" && (
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-red-600">
                  <AlertCircle size={16} />
                  <span>{shieldError || "Shield failed"}</span>
                </div>
                <button onClick={resetShield} className="text-xs font-medium text-red-600 underline hover:text-red-700" aria-label="Retry shield">Retry</button>
              </div>
            )}
          </div>

          {/* Unshield Section (mobile) */}
          <div className="glass-card-static rounded-[2rem] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">WITHDRAW FROM VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Unshield encrypted USDC back to public balance</p>
              </div>
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
              One-tap: encrypts amount, requests on-chain, waits for the Threshold Network (~10s), and auto-claims your tokens.
            </p>
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={unshieldAmount}
                  onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setUnshieldAmount(v); }}
                  placeholder="0.00"
                  aria-label="Unshield amount"
                  disabled={unshieldBusy}
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums disabled:opacity-50"
                />
              </div>
              <button
                onClick={handleUnshield}
                disabled={!unshieldAmount || parseFloat(unshieldAmount) <= 0 || unshieldBusy}
                className="h-14 px-6 rounded-2xl bg-amber-600 text-white font-medium hover:bg-amber-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Unshield"
              >
                {unshieldStep === "encrypting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Encrypting...</span>
                ) : unshieldStep === "requesting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Requesting...</span>
                ) : unshieldStep === "decrypting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Decrypting...</span>
                ) : unshieldStep === "claiming" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Claiming...</span>
                ) : "Unshield"}
              </button>
            </div>
            {unshieldStep === "decrypting" && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <Loader2 size={14} className="animate-spin" />
                <span>Threshold Network is decrypting your amount (~10s)…</span>
              </div>
            )}
            {unshieldStep === "success" && (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle size={16} />
                <span>Unshielded — public USDC balance updated.</span>
              </div>
            )}
            {unshieldStep === "error" && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle size={16} />
                <span>{unshieldError ?? "Unshield failed. Try again."}</span>
              </div>
            )}
            {hasPendingUnshield && unshieldStep !== "decrypting" && unshieldStep !== "claiming" && (
              <div className="flex items-center justify-between gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm">
                <div className="flex items-center gap-2 text-amber-900">
                  <Clock size={16} />
                  <span>Pending unshield from a previous session</span>
                </div>
                <button
                  onClick={handleRetryUnshieldClaim}
                  className="text-xs font-medium text-amber-900 underline hover:text-amber-950"
                  aria-label="Retry pending unshield claim"
                >
                  Retry claim
                </button>
              </div>
            )}
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
                  onClick={() => {
                    if ('scrollToShield' in action && action.scrollToShield) {
                      document.getElementById("shield-section")?.scrollIntoView({ behavior: "smooth" });
                    } else {
                      navigate(action.route);
                    }
                  }}
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
            onViewAll={() => navigate("/app/history")}
          />
        </div>
      </div>
    );
  }

  // ─── Desktop layout (bento grid, 12 columns) ─────────────────────
  return (
    <div data-testid="dashboard-root" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
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
          <button
            onClick={() => navigate("/app/history")}
            className="relative w-10 h-10 rounded-full bg-white/60 border border-black/5 flex items-center justify-center hover:bg-white/80 transition-all shrink-0 mt-1"
            aria-label="Notifications"
          >
            <Bell size={20} className="text-[var(--text-primary)]" />
            {hasUnread && (
              <div className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-white" />
            )}
          </button>
        </div>

        {/* Getting Started Card (new users only) */}
        {activities.length === 0 && publicBalance === 0 && (
          <div className="glass-card-static rounded-[2rem] p-6 space-y-4 border-2 border-emerald-200 mb-6">
            <h3 className="text-xl font-semibold" style={{ fontFamily: "'Outfit', sans-serif" }}>Getting Started</h3>
            <p className="text-sm text-[var(--text-secondary)]">Complete these 3 steps to start sending private payments</p>
            <div className="flex gap-4">
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
                <div className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm font-bold">1</div>
                <div>
                  <p className="text-sm font-medium">Get test USDC</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Tap the faucet button below</p>
                </div>
              </div>
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                <div className="w-8 h-8 rounded-full bg-gray-300 text-white flex items-center justify-center text-sm font-bold">2</div>
                <div>
                  <p className="text-sm font-medium">Shield your USDC</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Deposit tokens into your encrypted vault</p>
                </div>
              </div>
              <div className="flex-1 flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100">
                <div className="w-8 h-8 rounded-full bg-gray-300 text-white flex items-center justify-center text-sm font-bold">3</div>
                <div>
                  <p className="text-sm font-medium">Send your first private payment</p>
                  <p className="text-xs text-[var(--text-tertiary)]">Experience encrypted transactions</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Balance Card - Hero (col-span-8, row-span-2) */}
          <div className="col-span-full md:col-span-8 row-span-2">
            <BalanceCard
              balance={balance}
              privacyMode={privacyMode}
              onTogglePrivacy={togglePrivacyMode}
              activityCount={activities.length}
              chainName={activeChain.name}
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
                  onClick={() => {
                    if ('scrollToShield' in action && action.scrollToShield) {
                      document.getElementById("shield-section")?.scrollIntoView({ behavior: "smooth" });
                    } else {
                      navigate(action.route);
                    }
                  }}
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
          <div id="shield-section" className="col-span-full rounded-[2rem] glass-card-static p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-label text-[var(--text-secondary)]">DEPOSIT TO PRIVATE WALLET</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Deposit USDC to enable encrypted payments</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleMint} disabled={isMinting || faucetCooldown > 0} className="h-10 px-4 rounded-full bg-emerald-50 text-emerald-600 font-medium text-sm hover:bg-emerald-100 transition-colors disabled:opacity-50" aria-label="Get test USDC">
                  {isMinting ? "Minting..." : faucetCooldown > 0 ? `Try again in ${faucetCooldown}s` : "Get Test USDC"}
                </button>
                {hasUsdtFaucet && (
                  <button onClick={handleMintUsdt} disabled={isMintingUsdt} className="h-10 px-4 rounded-full bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors disabled:opacity-50" aria-label="Get test USDT">
                    {isMintingUsdt ? "Minting..." : "Get Test USDT"}
                  </button>
                )}
              </div>
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
                  aria-label="Shield amount"
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums"
                />
              </div>
              <button
                onClick={async () => { if (!shieldAmount || parseFloat(shieldAmount) <= 0) { toast.error("Enter an amount to deposit"); return; } await shield(shieldAmount); setShieldAmount(""); }}
                disabled={!shieldAmount || parseFloat(shieldAmount) <= 0}
                className="h-14 px-8 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Deposit to vault"
              >
                Deposit
              </button>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Vault Balance (Encrypted):</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{balance.formatted || "\u2022\u2022\u2022\u2022.\u2022\u2022"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">Public USDC Balance:</span>
              <span className="font-mono tabular-nums text-[var(--text-primary)]">{publicBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDC</span>
            </div>
            {/* Shield progress states */}
            {shieldStep === "approving" && (
              <div className="flex items-center gap-2 text-sm text-amber-600">
                <Loader2 size={16} className="animate-spin" />
                <span>Approving USDC...</span>
              </div>
            )}
            {shieldStep === "shielding" && (
              <div className="flex items-center gap-2 text-sm text-blue-600">
                <Loader2 size={16} className="animate-spin" />
                <span>Shielding tokens...</span>
              </div>
            )}
            {shieldStep === "success" && (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle size={16} />
                <span>Shielding complete!</span>
              </div>
            )}
            {shieldStep === "error" && (
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-red-600">
                  <AlertCircle size={16} />
                  <span>{shieldError || "Shield failed"}</span>
                </div>
                <button onClick={resetShield} className="text-xs font-medium text-red-600 underline hover:text-red-700" aria-label="Retry shield">Retry</button>
              </div>
            )}
          </div>

          {/* Unshield Section */}
          <div className="col-span-full rounded-[2rem] glass-card-static p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-label text-[var(--text-secondary)]">WITHDRAW FROM VAULT</p>
                <p className="text-sm text-[var(--text-secondary)] mt-1">Unshield encrypted USDC back to public balance</p>
              </div>
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
              One-tap: encrypts amount, requests on-chain, waits for the Threshold Network (~10s), and auto-claims your tokens.
            </p>
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={unshieldAmount}
                  onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setUnshieldAmount(v); }}
                  placeholder="0.00"
                  aria-label="Unshield amount"
                  disabled={unshieldBusy}
                  className="h-14 w-full pl-8 pr-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-lg font-mono tabular-nums disabled:opacity-50"
                />
              </div>
              <button
                onClick={handleUnshield}
                disabled={!unshieldAmount || parseFloat(unshieldAmount) <= 0 || unshieldBusy}
                className="h-14 px-6 rounded-2xl bg-amber-600 text-white font-medium hover:bg-amber-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Unshield"
              >
                {unshieldStep === "encrypting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Encrypting...</span>
                ) : unshieldStep === "requesting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Requesting...</span>
                ) : unshieldStep === "decrypting" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Decrypting...</span>
                ) : unshieldStep === "claiming" ? (
                  <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Claiming...</span>
                ) : "Unshield"}
              </button>
            </div>
            {unshieldStep === "decrypting" && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <Loader2 size={14} className="animate-spin" />
                <span>Threshold Network is decrypting your amount (~10s)…</span>
              </div>
            )}
            {unshieldStep === "success" && (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle size={16} />
                <span>Unshielded — public USDC balance updated.</span>
              </div>
            )}
            {unshieldStep === "error" && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle size={16} />
                <span>{unshieldError ?? "Unshield failed. Try again."}</span>
              </div>
            )}
            {hasPendingUnshield && unshieldStep !== "decrypting" && unshieldStep !== "claiming" && (
              <div className="flex items-center justify-between gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm">
                <div className="flex items-center gap-2 text-amber-900">
                  <Clock size={16} />
                  <span>Pending unshield from a previous session</span>
                </div>
                <button
                  onClick={handleRetryUnshieldClaim}
                  className="text-xs font-medium text-amber-900 underline hover:text-amber-950"
                  aria-label="Retry pending unshield claim"
                >
                  Retry claim
                </button>
              </div>
            )}
          </div>

          {/* Recent Activity (col-span-7) */}
          <div className="col-span-full md:col-span-7 rounded-[2rem] glass-card-static p-8">
            <ActivityList
              activities={recentActivities}
              isLoading={feedLoading}
              address={address}
              privacyMode={privacyMode}
              onViewAll={() => navigate("/app/history")}
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
              {/* FHE Status */}
              <div className={cn(
                "flex items-center justify-between p-4 rounded-2xl border",
                cofheConnected
                  ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-100 dark:border-emerald-500/20"
                  : "bg-amber-50 dark:bg-amber-500/10 border-amber-100 dark:border-amber-500/20"
              )}>
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center",
                    cofheConnected ? "bg-emerald-500" : "bg-amber-500"
                  )}>
                    <Shield size={20} className="text-white" />
                  </div>
                  <div>
                    {cofheConnected ? (
                      <>
                        <p className="font-medium text-emerald-900 dark:text-emerald-300">FHE Active</p>
                        <p className="text-sm text-emerald-700 dark:text-emerald-400">All amounts encrypted</p>
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-amber-900 dark:text-amber-300">Connecting to FHE...</p>
                        <p className="text-sm text-amber-700 dark:text-amber-400">Encryption initializing</p>
                      </>
                    )}
                  </div>
                </div>
                {cofheConnected && <CheckCircle size={24} className="text-emerald-600 dark:text-emerald-400" />}
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
  chainName?: string;
}

function BalanceCard({ balance, privacyMode, onTogglePrivacy, large, activityCount = 0, chainName = "Ethereum Sepolia" }: BalanceCardProps) {
  // Use balance.formatted from the hook — it handles decrypted values correctly.
  // balance.raw is the encrypted ciphertext handle (NOT the actual amount).
  // balance.isDecrypted tells us if the SDK successfully decrypted the value.
  // balance.totalDeposited is a plaintext aggregate from the vault contract.
  const formattedBalance = useMemo(() => {
    // Use real decrypted value if available
    if (balance.isDecrypted && balance.formatted && balance.formatted !== "Encrypted") {
      return balance.formatted;
    }
    // If user has an encrypted balance handle but can't decrypt, show encrypted indicator
    if (balance.hasBalance) {
      return null; // Will show ████.██ placeholder
    }
    // No balance handle at all — user hasn't shielded or received anything
    return "0.00";
  }, [balance.isDecrypted, balance.formatted, balance.hasBalance]);

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
                    ? <><span aria-hidden="true">{"\u2022\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}</span><span className="sr-only">Amount hidden</span></>
                    : formattedBalance ?? <><span aria-hidden="true">{"\u2022\u2022\u2022\u2022.\u2022\u2022"}</span><span className="sr-only">Encrypted</span></>}
                </h2>
              </div>
              {!displayAmount && formattedBalance === null && balance.hasBalance && (
                <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1"><Lock size={10} /> Balance encrypted — decryption requires CoFHE permit</p>
              )}
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
              USDC &middot; {chainName}
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
                className="text-2xl font-medium text-[var(--text-primary)]"
                style={{ fontFamily: "'Outfit', sans-serif" }}
              >
                {activityCount} transactions
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
          aria-label="View all activity"
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
                      {activityLabels[activity.activity_type] || activity.activity_type.charAt(0).toUpperCase() + activity.activity_type.slice(1)}
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
                    {isIncoming ? "+" : "-"}$
                    <span aria-hidden="true">{"\u2022\u2022\u2022\u2022.\u2022\u2022"}</span>
                    <span className="sr-only">Encrypted amount</span>
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
