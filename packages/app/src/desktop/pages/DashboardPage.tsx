import { motion, AnimatePresence } from "framer-motion";
import { useAccount } from "wagmi";
import {
  Shield,
  Send,
  ArrowDownToLine,
  Users,
  ArrowUpRight,
  Coins,
  Lock,
  Eye,
  Bell,
  ScanLine,
  FileText,
  ArrowLeftRight,
  Download,
  MoreHorizontal,
  List,
  Table2,
  MessageSquare,
  ChevronDown,
  Link as LinkIcon,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/cn";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { QuickSendRow } from "@/components/common/QuickSendRow";
import { TransactionBubble } from "@/components/common/TransactionBubble";
import { QRScannerModal } from "@/components/payment/QRScannerModal";
import { useShield } from "@/hooks/useShield";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useContacts } from "@/hooks/useContacts";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { useUsdPrice, formatAsUsd } from "@/hooks/useUsdPrice";
import { usePrivacy } from "@/hooks/usePrivacy";
import { ActivityItem } from "@/components/common/ActivityItem";
import { ActivityCharts } from "@/components/dashboard/ActivityCharts";
import { PaginatedActivityTable } from "@/components/common/PaginatedActivityTable";
import { CONTRACTS, BASE_SEPOLIA } from "@/lib/constants";
import { isOfflineMode } from "@/lib/supabase";

// ─── Quick Action Definitions (Apple HIG grid) ──────────────────────

const quickActions = [
  {
    label: "Shield",
    icon: Shield,
    path: "/",
    hiddenClass: "",
    scrollToShield: true,
  },
  {
    label: "Split",
    icon: Users,
    path: "/groups",
    hiddenClass: "",
  },
  {
    label: "Scan",
    icon: ScanLine,
    path: "",
    hiddenClass: "",
    openScanner: true,
  },
  {
    label: "Pay Link",
    icon: LinkIcon,
    path: "/receive?tab=link",
    hiddenClass: "",
  },
  {
    label: "Invoices",
    icon: FileText,
    path: "/business",
    hiddenClass: "hidden md:flex",
  },
  {
    label: "Swap",
    icon: ArrowLeftRight,
    path: "/exchange",
    hiddenClass: "hidden md:flex",
  },
  {
    label: "Export",
    icon: Download,
    path: "/settings",
    hiddenClass: "hidden lg:flex",
  },
  {
    label: "More",
    icon: MoreHorizontal,
    path: "/settings",
    hiddenClass: "hidden lg:flex",
  },
] as const;

// ─── Spring Transition Presets ───────────────────────────────────────

const springLift = {
  type: "spring" as const,
  stiffness: 400,
  damping: 20,
};

// ─── Dashboard Page ──────────────────────────────────────────────────

export function DashboardPage() {
  const { isConnected, address } = useAccount();
  const navigate = useNavigate();
  const {
    publicBalance,
    vaultBalance: vaultTotal,
    shield,
    mintTestTokens,
    isMinting,
    step: shieldStep,
    txHash,
  } = useShield();
  const {
    activities,
    isLoading: feedLoading,
    addLocalActivity,
  } = useActivityFeed();
  const { contacts } = useContacts();
  const { usdPrice, hasRealPrice } = useUsdPrice();
  const { hasBalance, formatted: encryptedFormatted, isDecrypted } = useEncryptedBalance();
  const { isExpired: permitExpired, isExpiringSoon: _isExpiringSoon, createPermit } = usePrivacy();
  void _isExpiringSoon; // Available for future use (e.g. warning banner)
  const [shieldAmount, setShieldAmount] = useState("");
  const [showShield, setShowShield] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [feedView, setFeedView] = useState<"list" | "bubbles" | "table">("list");
  const [isShielded, setIsShielded] = useState(true);

  // ─── Pending TX indicator (#14) ──────────────────────────────────
  const [hasPending, setHasPending] = useState(false);
  useEffect(() => {
    try {
      const pending = localStorage.getItem("blank_pending_send");
      setHasPending(!!pending);
    } catch {}
  }, []);

  // ─── Handlers ────────────────────────────────────────────────────

  const handleMint = useCallback(async () => {
    const hash = await mintTestTokens();
    // Only add to feed if tx actually succeeded
    if (hash && address) {
      addLocalActivity({
        tx_hash: hash,
        user_from: address,
        user_to: address,
        activity_type: "mint",
        contract_address: CONTRACTS.TestUSDC,
        note: "Minted 10,000 test USDC",
        token_address: CONTRACTS.TestUSDC,
        block_number: 0,
      });
    }
  }, [mintTestTokens, address, addLocalActivity]);

  const handleShield = useCallback(async () => {
    if (!shieldAmount || parseFloat(shieldAmount) <= 0) return;
    const hash = await shield(shieldAmount);
    // Only add to feed if tx actually succeeded
    if (hash && address) {
      addLocalActivity({
        tx_hash: hash,
        user_from: address,
        user_to: address,
        activity_type: "shield",
        contract_address: CONTRACTS.FHERC20Vault_USDC,
        note: `Shielded ${shieldAmount} USDC`,
        token_address: CONTRACTS.TestUSDC,
        block_number: 0,
      });
    }
    setShieldAmount("");
    setShowShield(false);
  }, [shieldAmount, shield, address, addLocalActivity]);

  // ─── Connect Gate ────────────────────────────────────────────────

  if (!isConnected) return <ConnectPrompt />;

  // ─── Format helpers ──────────────────────────────────────────────

  const formatBalance = (val: number): string => {
    if (val === 0) return "0.00";
    if (val < 0.01) return val.toFixed(6); // Show 6 decimals for micro-amounts
    if (val < 1) return val.toFixed(4); // Show 4 decimals for sub-dollar
    return val.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-8"
    >
      {isOfflineMode() && (
        <div className="mb-4 px-4 py-2 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning">
          Running in offline mode — some features are limited. Configure Supabase to enable full sync.
        </div>
      )}

      {hasPending && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          You have a pending transaction. Check your wallet for status.
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          HEADER
          ═══════════════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-heading-1 font-semibold tracking-tight text-white">
            Dashboard
          </h1>
          <p className="text-sm text-apple-secondary font-medium tracking-wide mt-1">
            Encrypted Wallet Active
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowScanner(true)}
            className="w-10 h-10 rounded-full bg-apple-gray6 flex items-center justify-center text-apple-secondary hover:text-white hover:bg-apple-gray5 transition-colors duration-200"
            aria-label="Scan QR code"
          >
            <ScanLine className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={() => navigate("/requests")}
            className="w-10 h-10 rounded-full bg-apple-gray6 flex items-center justify-center text-apple-secondary hover:text-white hover:bg-apple-gray5 transition-colors duration-200"
            aria-label="Notifications"
          >
            <Bell className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          BALANCE HERO CARD
          ═══════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-[2.5rem] p-8 lg:p-12 relative overflow-hidden bg-gradient-to-br from-apple-gray6 to-[#0A0A0A] border border-white/[0.08] shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
      >
        {/* Ambient emerald glow — top right (visible when shielded) */}
        {isShielded && (
          <div
            className="absolute -top-32 -right-32 w-96 h-96 bg-apple-green/10 rounded-full blur-[100px] pointer-events-none"
            aria-hidden="true"
          />
        )}

        {/* Content — above glow layer */}
        <div className="relative z-10">
          {/* Shield toggle — floating top right */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <p className="text-apple-secondary text-sm font-semibold uppercase tracking-widest">
                {isShielded ? "Encrypted Balance" : "Public Balance"}
              </p>
            </div>
            <button
              onClick={() => setIsShielded(!isShielded)}
              className="px-4 py-2 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center gap-2 text-sm font-medium transition-all duration-200 hover:bg-black/60"
              aria-label={isShielded ? "Switch to public balance view" : "Switch to shielded balance view"}
            >
              {isShielded ? (
                <>
                  <Lock className="w-3.5 h-3.5 text-apple-green fill-apple-green" />
                  <span className="text-apple-green">Shielded</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5 text-apple-secondary" />
                  <span className="text-apple-secondary">Public</span>
                </>
              )}
            </button>
          </div>

          {/* Balance display — MASSIVE */}
          <div className="flex items-baseline gap-2" aria-live="polite" aria-atomic="true">
            <span
              className={cn(
                "text-4xl font-medium transition-colors duration-300",
                isShielded ? "text-apple-green" : "text-apple-secondary"
              )}
            >
              $
            </span>
            <span className="text-6xl lg:text-[5rem] font-semibold tracking-tighter text-white font-mono tabular-nums">
              {isShielded
                ? permitExpired
                  ? <button onClick={createPermit} className="text-warning text-2xl font-sans cursor-pointer hover:text-warning/80 transition-colors">Permit expired &mdash; tap to renew</button>
                  : isDecrypted && encryptedFormatted
                    ? encryptedFormatted
                    : hasBalance
                      ? "***,***.**"
                      : "0.00"
                : formatBalance(publicBalance)}
            </span>
          </div>

          {/* Info pill below balance */}
          <div className="mt-4">
            <span className="inline-flex items-center bg-black/20 px-3 py-1 rounded-lg backdrop-blur-sm border border-white/[0.05] text-xs text-apple-secondary font-medium">
              {isShielded ? "Amount encrypted with FHE" : "public visible ledger"}
            </span>
          </div>

          {/* CTA buttons row */}
          <div className="flex items-center gap-3 mt-8">
            <button
              onClick={() => navigate("/send")}
              className="px-8 py-4 rounded-full bg-white text-black font-semibold text-sm inline-flex items-center gap-2 hover:bg-white/90 transition-colors duration-200"
            >
              Send FHE
              <ArrowUpRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigate("/receive")}
              className="px-8 py-4 rounded-full bg-apple-gray6/80 backdrop-blur-xl text-white font-semibold text-sm border border-white/10 inline-flex items-center gap-2 hover:bg-apple-gray5/80 transition-colors duration-200"
            >
              Request
            </button>
          </div>

          {/* Stat pills row */}
          <div className="mt-8 grid grid-cols-2 gap-4">
            {/* Public USDC pill */}
            <div className="rounded-2xl bg-black/30 backdrop-blur-xl border border-white/[0.06] px-5 py-4 transition-all duration-200 hover:bg-white/[0.04] hover:border-white/[0.1]">
              <p className="text-apple-secondary text-xs font-semibold uppercase tracking-widest mb-2">
                Public USDC
              </p>
              <p className="text-xl font-mono font-semibold text-white tabular-nums leading-none">
                {formatBalance(publicBalance)}
              </p>
              <p className="text-xs text-apple-tertiary font-mono mt-1 tabular-nums">
                {/* publicBalance is already in human-readable form (e.g. 1000.50) */}
                {formatAsUsd(Math.round(publicBalance * 1e6), 6, usdPrice)}
                {hasRealPrice && " (live)"}
              </p>
            </div>

            {/* Vault Deposits pill */}
            <div className="rounded-2xl bg-black/30 backdrop-blur-xl border border-apple-green/15 px-5 py-4 transition-all duration-200 hover:bg-white/[0.04] hover:border-apple-green/25">
              <p className="text-apple-secondary text-xs font-semibold uppercase tracking-widest mb-2">
                Vault Deposits
              </p>
              <p className="text-xl font-mono font-semibold text-apple-green tabular-nums leading-none">
                {formatBalance(vaultTotal)}
              </p>
              <p className="text-xs text-apple-green/50 font-mono mt-1 tabular-nums">
                {/* vaultTotal is already in human-readable form (e.g. 500.25) */}
                {formatAsUsd(Math.round(vaultTotal * 1e6), 6, usdPrice)}
                {hasRealPrice && " (live)"}
              </p>
            </div>
          </div>

          {/* Action buttons row — Shield / Unshield / Get Test USDC */}
          <div className="flex items-center gap-3 mt-6 pt-6 border-t border-white/[0.06]">
            <Button
              variant="primary"
              size="md"
              icon={<Shield className="w-4 h-4" />}
              onClick={() => setShowShield(!showShield)}
              loading={shieldStep === "shielding"}
            >
              Shield Tokens
              <ChevronDown className={cn("w-4 h-4 ml-1 transition-transform duration-300", showShield && "rotate-180")} />
            </Button>
            <Button
              variant="secondary"
              size="md"
              icon={<ArrowDownToLine className="w-4 h-4" />}
              onClick={() => setShowShield(true)}
            >
              Unshield
            </Button>
            <Button
              variant="ghost"
              size="md"
              icon={<Coins className="w-4 h-4" />}
              onClick={handleMint}
              loading={isMinting}
            >
              Get Test USDC
            </Button>
          </div>

          {/* Shield expandable form */}
          <AnimatePresence>
            {showShield && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="mt-6 pt-6 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-apple-secondary uppercase tracking-widest">
                      Amount to shield
                    </span>
                    <button
                      onClick={() => setShieldAmount(String(publicBalance))}
                      className="text-[10px] font-semibold text-apple-green/70 hover:text-apple-green uppercase tracking-wider transition-colors"
                      aria-label="Set maximum shield amount"
                    >
                      Max
                    </button>
                  </div>
                  <div className="flex items-end gap-3">
                    <Input
                      label=""
                      placeholder="0.00"
                      type="number"
                      min="0"
                      step="0.01"
                      value={shieldAmount}
                      onChange={(e) => setShieldAmount(e.target.value)}
                      className="flex-1 font-mono"
                      rightElement={
                        <span className="text-xs font-medium text-apple-tertiary">
                          USDC
                        </span>
                      }
                    />
                    <Button
                      variant="primary"
                      size="lg"
                      onClick={handleShield}
                      loading={
                        shieldStep === "approving" ||
                        shieldStep === "shielding"
                      }
                      disabled={
                        !shieldAmount || parseFloat(shieldAmount) <= 0
                      }
                      icon={<Shield className="w-4 h-4" />}
                    >
                      Shield
                    </Button>
                  </div>
                  <p className="text-xs text-apple-secondary mt-3 leading-relaxed">
                    Converts public USDC into encrypted eUSDC. Only you can
                    see your balance.
                  </p>
                  <p className="text-[11px] text-apple-secondary mt-2">
                    This requires 2 transactions: approve + deposit.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Last transaction link */}
          {txHash && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 }}
              className="mt-5 pt-4 border-t border-white/[0.04]"
            >
              <a
                href={`${BASE_SEPOLIA.explorerUrl}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-apple-green/50 hover:text-apple-green font-mono transition-colors duration-200"
              >
                Last tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
                <ArrowUpRight className="w-3 h-3" />
              </a>
            </motion.div>
          )}
        </div>
      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════
          QUICK ACTIONS GRID (Apple HIG style)
          ═══════════════════════════════════════════════════════════════ */}
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4"
      >
        {quickActions.map((action) => {
          const handleClick = () => {
            if ("scrollToShield" in action && action.scrollToShield) {
              setShowShield(true);
            } else if ("openScanner" in action && action.openScanner) {
              setShowScanner(true);
            } else {
              navigate(action.path);
            }
          };
          return (
            <motion.div
              key={action.label}
              variants={fadeInUp}
              className={action.hiddenClass}
            >
              <button onClick={handleClick} className="block group w-full">
                <motion.div
                  whileHover={{ scale: 1.05, transition: springLift }}
                  whileTap={{ scale: 0.97 }}
                  className="flex flex-col items-center gap-2.5"
                >
                  {/* Icon container */}
                  <div className="w-14 h-14 md:w-16 md:h-16 rounded-[1.2rem] bg-apple-gray6 border border-white/[0.05] flex items-center justify-center transition-colors duration-200 group-hover:bg-apple-gray5">
                    <action.icon className="w-5 h-5 md:w-6 md:h-6 text-apple-secondary group-hover:text-white transition-colors duration-200" />
                  </div>
                  {/* Label */}
                  <span className="text-xs font-medium text-apple-secondary group-hover:text-white transition-colors duration-200">
                    {action.label}
                  </span>
                </motion.div>
              </button>
            </motion.div>
          );
        })}
      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════
          ACTIVITY CHARTS
          ═══════════════════════════════════════════════════════════════ */}
      <ActivityCharts activities={activities} />

      {/* ═══════════════════════════════════════════════════════════════
          QUICK SEND
          ═══════════════════════════════════════════════════════════════ */}
      <QuickSendRow
        contacts={contacts.map((c) => ({ address: c.address, name: c.nickname }))}
        onSelect={(addr) => navigate(`/send?to=${addr}`)}
        onAddContact={() => navigate("/settings")}
      />

      {/* ═══════════════════════════════════════════════════════════════
          ACTIVITY FEED (Encrypted Ledger)
          ═══════════════════════════════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="bg-apple-gray6/30 border border-white/[0.05] rounded-[2rem] p-3 backdrop-blur-xl min-h-[320px]"
      >
        {/* Section header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-4">
          <h2 className="text-lg font-semibold text-white tracking-tight">
            Encrypted Ledger
          </h2>
          <div className="flex items-center gap-2">
            {activities.length > 0 && (
              <>
                <button
                  onClick={() => setFeedView("list")}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors duration-150",
                    feedView === "list"
                      ? "bg-apple-gray5 text-white"
                      : "text-apple-tertiary hover:text-apple-secondary"
                  )}
                  aria-label="List view"
                >
                  <List className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setFeedView("bubbles")}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors duration-150",
                    feedView === "bubbles"
                      ? "bg-apple-gray5 text-white"
                      : "text-apple-tertiary hover:text-apple-secondary"
                  )}
                  aria-label="Bubble view"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setFeedView("table")}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors duration-150",
                    feedView === "table"
                      ? "bg-apple-gray5 text-white"
                      : "text-apple-tertiary hover:text-apple-secondary"
                  )}
                  aria-label="Table view -- full transaction history"
                >
                  <Table2 className="w-4 h-4" />
                </button>
              </>
            )}
            {activities.length > 0 && (
              <Link
                to="/activity"
                className="inline-flex items-center gap-1 text-xs font-medium text-apple-green/70 hover:text-apple-green transition-colors duration-200 ml-2"
              >
                Explorer
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>

        {/* Feed content */}
        <div className="px-1">
          {feedLoading ? (
            /* Shimmer loading skeletons */
            <div className="space-y-2 p-2">
              <div className="shimmer h-16 rounded-2xl" style={{ animationDelay: "0.15s" }} />
              <div className="shimmer h-16 rounded-2xl w-[92%]" style={{ animationDelay: "0.3s" }} />
              <div className="shimmer h-16 rounded-2xl w-[85%]" style={{ animationDelay: "0.45s" }} />
            </div>
          ) : activities.length > 0 ? (
            feedView === "list" ? (
              /* Classic list view with Apple HIG styling */
              <motion.div
                variants={staggerContainer}
                initial="initial"
                animate="animate"
                className="divide-y divide-white/[0.03]"
              >
                {activities.slice(0, 10).map((activity, index) => (
                  <div
                    key={activity.id}
                    className="p-4 rounded-2xl hover:bg-apple-gray5/50 transition-colors duration-150"
                  >
                    <ActivityItem
                      activity={activity}
                      currentUser={address || ""}
                      index={index}
                    />
                  </div>
                ))}
              </motion.div>
            ) : feedView === "table" ? (
              /* Paginated table view */
              <div className="p-2">
                <PaginatedActivityTable
                  activities={activities}
                  currentUser={address || ""}
                  isLoading={feedLoading}
                  pageSize={8}
                />
              </div>
            ) : (
              /* iMessage-style bubble view */
              <div className="space-y-3 p-2">
                {activities.slice(0, 10).map((activity, index) => {
                  const isSender = activity.user_from.toLowerCase() === (address || "").toLowerCase();
                  const validType = ["payment", "request", "request_fulfilled", "group_expense",
                    "group_settle", "tip", "invoice_created", "invoice_paid",
                    "escrow_created", "escrow_released", "exchange_filled", "shield", "unshield"];
                  // Type narrowing: activity_type is a string from Supabase;
                  // TransactionBubble expects a union literal type
                  type TxType = "payment" | "request" | "request_fulfilled" | "group_expense"
                    | "group_settle" | "tip" | "invoice_created" | "invoice_paid"
                    | "escrow_created" | "escrow_released" | "exchange_filled" | "shield" | "unshield";
                  const txType: TxType = validType.includes(activity.activity_type)
                    ? (activity.activity_type as TxType)
                    : "payment";
                  return (
                    <TransactionBubble
                      key={activity.id}
                      type={txType}
                      isSender={isSender}
                      otherParty={isSender ? activity.user_to : activity.user_from}
                      note={activity.note}
                      timestamp={activity.created_at}
                      index={index}
                    />
                  );
                })}
              </div>
            )
          ) : (
            /* Rich empty state */
            <div className="flex flex-col items-center justify-center py-16">
              {/* Pulsing shield icon */}
              <div className="relative mb-6">
                {/* Glow ring */}
                <motion.div
                  animate={{
                    scale: [1, 1.3, 1],
                    opacity: [0.15, 0.05, 0.15],
                  }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="absolute inset-0 rounded-2xl bg-apple-green/20"
                  style={{ filter: "blur(16px)" }}
                  aria-hidden="true"
                />
                <div className="relative w-16 h-16 rounded-2xl bg-apple-gray6 border border-white/[0.08] flex items-center justify-center">
                  <motion.div
                    animate={{
                      scale: [1, 1.06, 1],
                    }}
                    transition={{
                      duration: 3,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  >
                    <Shield className="w-8 h-8 text-apple-tertiary" />
                  </motion.div>
                </div>
              </div>

              <p className="text-lg font-semibold text-white mb-1.5">
                No activity yet
              </p>
              <p className="text-sm text-apple-secondary text-center max-w-xs leading-relaxed mb-6">
                Shield some tokens and send your first encrypted payment
              </p>

              <button
                onClick={() => navigate("/send")}
                className="px-6 py-3 rounded-full bg-white text-black font-semibold text-sm inline-flex items-center gap-2 hover:bg-white/90 transition-colors duration-200"
              >
                <Send className="w-4 h-4" />
                Send your first payment
                <ArrowUpRight className="w-3.5 h-3.5 opacity-60" />
              </button>
            </div>
          )}
        </div>
      </motion.div>

      {/* QR Scanner Modal */}
      <QRScannerModal
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={(addr) => {
          navigate(`/send?to=${addr}`);
          setShowScanner(false);
        }}
      />
    </motion.div>
  );
}
