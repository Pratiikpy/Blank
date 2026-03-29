import { motion } from "framer-motion";
import { useState } from "react";
import {
  Send,
  ArrowDownToLine,
  Users,
  Heart,
  FileText,
  Shield,
  ArrowLeftRight,
  Lock,
  Copy,
  Check,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { GradientAvatar } from "./GradientAvatar";
import type { ActivityRow } from "@/lib/supabase";

// ─── Config ──────────────────────────────────────────────────────────

const activityConfig: Record<
  string,
  { icon: typeof Send; color: string; bgTint: string; label: string }
> = {
  payment:          { icon: Send,            color: "text-accent",       bgTint: "bg-accent/10",    label: "Sent" },
  request:          { icon: ArrowDownToLine, color: "text-blue-400",     bgTint: "bg-blue-400/10",  label: "Requested" },
  request_fulfilled:{ icon: ArrowDownToLine, color: "text-accent",       bgTint: "bg-accent/10",    label: "Request paid" },
  group_expense:    { icon: Users,           color: "text-orange-400",   bgTint: "bg-orange-400/10", label: "Group expense" },
  group_settle:     { icon: Users,           color: "text-accent",       bgTint: "bg-accent/10",    label: "Settled" },
  tip:              { icon: Heart,           color: "text-pink-400",     bgTint: "bg-pink-400/10",  label: "Tipped" },
  invoice_created:  { icon: FileText,        color: "text-blue-400",     bgTint: "bg-blue-400/10",  label: "Invoiced" },
  invoice_paid:     { icon: FileText,        color: "text-accent",       bgTint: "bg-accent/10",    label: "Invoice paid" },
  escrow_created:   { icon: Shield,          color: "text-purple-400",   bgTint: "bg-purple-400/10", label: "Escrow" },
  escrow_released:  { icon: Shield,          color: "text-accent",       bgTint: "bg-accent/10",    label: "Escrow released" },
  exchange_filled:  { icon: ArrowLeftRight,  color: "text-cyan-400",     bgTint: "bg-cyan-400/10",  label: "Swapped" },
  shield:           { icon: Lock,            color: "text-encrypted",    bgTint: "bg-encrypted/10", label: "Shielded" },
  unshield:         { icon: Lock,            color: "text-neutral-400",  bgTint: "bg-neutral-400/10", label: "Unshielded" },
  mint:             { icon: ArrowDownToLine, color: "text-accent",       bgTint: "bg-accent/10",    label: "Minted" },
  faucet:           { icon: ArrowDownToLine, color: "text-accent",       bgTint: "bg-accent/10",    label: "Faucet" },
  payroll:          { icon: Users,           color: "text-accent",       bgTint: "bg-accent/10",    label: "Payroll" },
  escrow_expired:   { icon: Shield,          color: "text-warning",      bgTint: "bg-warning/10",   label: "Escrow expired" },
  escrow_resolved:  { icon: Shield,          color: "text-accent",       bgTint: "bg-accent/10",    label: "Escrow resolved" },
  request_cancelled:{ icon: ArrowDownToLine, color: "text-error",        bgTint: "bg-error/10",     label: "Request cancelled" },
};

const fallbackConfig = {
  icon: Send,
  color: "text-neutral-500",
  bgTint: "bg-neutral-500/10",
  label: "Activity",
};

// ─── Helpers ─────────────────────────────────────────────────────────

function truncateAddress(addr: string) {
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function relativeTime(dateStr: string): string {
  return formatDistanceToNowStrict(new Date(dateStr), { addSuffix: false })
    .replace(" seconds", "s")
    .replace(" second", "s")
    .replace(" minutes", "m")
    .replace(" minute", "m")
    .replace(" hours", "h")
    .replace(" hour", "h")
    .replace(" days", "d")
    .replace(" day", "d")
    .replace(" months", "mo")
    .replace(" month", "mo")
    .replace(" years", "y")
    .replace(" year", "y")
    .concat(" ago");
}

// ─── Component ───────────────────────────────────────────────────────

interface ActivityItemProps {
  activity: ActivityRow;
  currentUser: string;
  /** Zero-based index used for staggered entry animation */
  index?: number;
}

export function ActivityItem({ activity, currentUser, index = 0 }: ActivityItemProps) {
  const [copied, setCopied] = useState(false);
  const config = activityConfig[activity.activity_type] ?? {
    ...fallbackConfig,
    label: activity.activity_type,
  };
  const Icon = config.icon;

  const isSender = activity.user_from.toLowerCase() === currentUser.toLowerCase();
  const otherParty = isSender ? activity.user_to : activity.user_from;
  const direction = isSender ? "to" : "from";

  const timeAgo = relativeTime(activity.created_at);

  // Extract real tx hash (strip any _suffix for batch activities like payroll/splits/gifts)
  const realTxHash = activity.tx_hash?.includes("_")
    ? activity.tx_hash.split("_")[0]
    : activity.tx_hash;

  const copyTxHash = async () => {
    if (!realTxHash) return;
    await copyToClipboard(realTxHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.35,
        delay: index * 0.06,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      className={cn(
        "flex items-center gap-3 p-3",
        "rounded-2xl bg-glass-surface border border-glass-border",
        "hover:bg-glass-hover hover:border-glass-border-hover",
        "transition-all duration-200 group"
      )}
    >
      {/* Avatar with icon overlay */}
      <div className="relative shrink-0">
        <GradientAvatar
          address={otherParty !== ZERO_ADDRESS ? otherParty : activity.user_from}
          size="md"
        />
        <div
          className={cn(
            "absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center",
            "border-2 border-[#131316]",
            config.bgTint
          )}
        >
          <Icon className={cn("w-2.5 h-2.5", config.color)} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-medium text-white">{config.label}</span>
          <span className="text-neutral-600">{direction}</span>
          {otherParty !== ZERO_ADDRESS && (
            <span className="font-mono text-neutral-400 text-xs truncate">
              {truncateAddress(otherParty)}
            </span>
          )}
        </div>
        {activity.note && (
          <p className="text-xs text-neutral-500 truncate mt-0.5 max-w-[160px] sm:max-w-[240px]">
            {activity.note}
          </p>
        )}
      </div>

      {/* Encrypted amount + time + copy */}
      <div className="text-right shrink-0 flex items-center gap-1.5">
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-xs font-mono text-encrypted/60 tracking-tight">
            {ENCRYPTED_PLACEHOLDER}
          </span>
          <span className="text-[10px] text-neutral-500 leading-none">
            {timeAgo}
          </span>
        </div>
        {realTxHash && (
          <button
            onClick={(e) => { e.stopPropagation(); copyTxHash(); }}
            className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200 p-1 rounded-md hover:bg-white/[0.06]"
            aria-label="Copy transaction hash"
          >
            {copied ? (
              <Check className="w-3 h-3 text-accent" />
            ) : (
              <Copy className="w-3 h-3 text-neutral-500" />
            )}
          </button>
        )}
      </div>
    </motion.div>
  );
}
