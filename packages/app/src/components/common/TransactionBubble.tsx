import { motion } from "framer-motion";
import {
  Send,
  ArrowDownToLine,
  Users,
  Heart,
  FileText,
  Shield,
  ArrowLeftRight,
  Lock,
  type LucideIcon,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import { EncryptedAmount } from "./EncryptedAmount";

// ─── Types ──────────────────────────────────────────────────────────

type TransactionType =
  | "payment"
  | "request"
  | "request_fulfilled"
  | "group_expense"
  | "group_settle"
  | "tip"
  | "invoice_created"
  | "invoice_paid"
  | "escrow_created"
  | "escrow_released"
  | "exchange_filled"
  | "shield"
  | "unshield";

interface TransactionBubbleProps {
  type: TransactionType;
  /** Is current user the sender? Determines alignment. */
  isSender: boolean;
  /** Other party's address or name */
  otherParty: string;
  /** Encrypted amount (raw bigint from contract) */
  encryptedAmount?: bigint | null;
  /** Token decimals for display */
  decimals?: number;
  /** Token symbol */
  symbol?: string;
  /** Optional note/memo (public context) */
  note?: string;
  /** ISO timestamp string */
  timestamp: string;
  /** Transaction status */
  status?: "pending" | "confirmed" | "failed";
  /** Zero-based index for staggered entry */
  index?: number;
  className?: string;
}

// ─── Config per transaction type ────────────────────────────────────

interface TypeConfig {
  icon: LucideIcon;
  /** Color used for the icon and sent-bubble accent tint */
  color: string;
  /** Background tint for the icon circle */
  iconBg: string;
  /** Label shown above the bubble content */
  label: string;
  /** Bubble tint for sent (isSender) messages */
  sentTint: string;
}

const typeConfig: Record<TransactionType, TypeConfig> = {
  payment:           { icon: Send,            color: "text-accent",         iconBg: "bg-accent/10",         label: "Sent",            sentTint: "from-accent/[0.08] to-accent/[0.03]" },
  request:           { icon: ArrowDownToLine, color: "text-info",           iconBg: "bg-info/10",           label: "Requested",       sentTint: "from-info/[0.08] to-info/[0.03]" },
  request_fulfilled: { icon: ArrowDownToLine, color: "text-accent",         iconBg: "bg-accent/10",         label: "Request paid",    sentTint: "from-accent/[0.08] to-accent/[0.03]" },
  group_expense:     { icon: Users,           color: "text-warning",        iconBg: "bg-warning/10",        label: "Group expense",   sentTint: "from-warning/[0.06] to-warning/[0.02]" },
  group_settle:      { icon: Users,           color: "text-accent",         iconBg: "bg-accent/10",         label: "Settled",         sentTint: "from-accent/[0.08] to-accent/[0.03]" },
  tip:               { icon: Heart,           color: "text-pink-400",       iconBg: "bg-pink-400/10",       label: "Tipped",          sentTint: "from-pink-400/[0.08] to-pink-400/[0.03]" },
  invoice_created:   { icon: FileText,        color: "text-info",           iconBg: "bg-info/10",           label: "Invoice sent",    sentTint: "from-info/[0.08] to-info/[0.03]" },
  invoice_paid:      { icon: FileText,        color: "text-accent",         iconBg: "bg-accent/10",         label: "Invoice paid",    sentTint: "from-accent/[0.08] to-accent/[0.03]" },
  escrow_created:    { icon: Shield,          color: "text-encrypted",      iconBg: "bg-encrypted/10",      label: "Escrow",          sentTint: "from-encrypted/[0.08] to-encrypted/[0.03]" },
  escrow_released:   { icon: Shield,          color: "text-accent",         iconBg: "bg-accent/10",         label: "Released",        sentTint: "from-accent/[0.08] to-accent/[0.03]" },
  exchange_filled:   { icon: ArrowLeftRight,  color: "text-cyan-400",       iconBg: "bg-cyan-400/10",       label: "Swapped",         sentTint: "from-cyan-400/[0.06] to-cyan-400/[0.02]" },
  shield:            { icon: Lock,            color: "text-encrypted",      iconBg: "bg-encrypted/10",      label: "Shielded",        sentTint: "from-encrypted/[0.08] to-encrypted/[0.03]" },
  unshield:          { icon: Lock,            color: "text-neutral-400",    iconBg: "bg-neutral-400/10",    label: "Unshielded",      sentTint: "from-neutral-400/[0.06] to-neutral-400/[0.02]" },
};

// ─── Helpers ────────────────────────────────────────────────────────

function truncateAddress(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

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

// ─── Entry animation ────────────────────────────────────────────────

const bubbleSpring = {
  type: "spring" as const,
  stiffness: 350,
  damping: 28,
};

// ─── Component ──────────────────────────────────────────────────────

export function TransactionBubble({
  type,
  isSender,
  otherParty,
  encryptedAmount,
  decimals = 6,
  symbol = "USDC",
  note,
  timestamp,
  status = "confirmed",
  index = 0,
  className,
}: TransactionBubbleProps) {
  const config = typeConfig[type];
  const Icon = config.icon;
  const timeAgo = relativeTime(timestamp);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        ...bubbleSpring,
        delay: index * 0.05,
      }}
      className={cn(
        // Full row: flex with alignment based on sender/receiver
        "flex gap-2.5",
        isSender ? "justify-end" : "justify-start",
        className
      )}
    >
      {/* ── Avatar / Icon (left side for received, right for sent) ── */}
      {!isSender && (
        <div
          className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-1",
            "ring-1 ring-inset ring-white/[0.06]",
            config.iconBg
          )}
        >
          <Icon className={cn("w-4 h-4", config.color)} />
        </div>
      )}

      {/* ── Bubble body ── */}
      <div
        className={cn(
          "relative max-w-[75%] min-w-[160px]",
          "rounded-2xl px-4 py-3",
          "ring-1 ring-inset ring-white/[0.04]",
          // Sent: accent-tinted gradient, right-aligned "tail"
          isSender && [
            "bg-gradient-to-br",
            config.sentTint,
            "border border-white/[0.06]",
            // Right-side tail: slightly more rounded on bottom-right
            "rounded-br-md",
          ].join(" "),
          // Received: neutral glass, left-aligned "tail"
          !isSender && [
            "bg-gradient-to-b from-white/[0.05] to-white/[0.02]",
            "border border-white/[0.08]",
            "rounded-bl-md",
          ].join(" ")
        )}
      >
        {/* ── Top row: type label + other party ── */}
        <div className="flex items-center gap-1.5 mb-1.5">
          {isSender && (
            <Icon className={cn("w-3.5 h-3.5 shrink-0", config.color)} />
          )}
          <span className={cn("text-xs font-medium", config.color)}>
            {config.label}
          </span>
          <span className="text-xs text-text-muted">
            {isSender ? "to" : "from"}
          </span>
          <span className="text-xs font-mono text-text-tertiary truncate">
            {truncateAddress(otherParty)}
          </span>
        </div>

        {/* ── Encrypted amount ── */}
        <div className="mb-1">
          <EncryptedAmount
            value={encryptedAmount}
            decimals={decimals}
            symbol={symbol}
            size="md"
            showToggle={encryptedAmount != null}
          />
        </div>

        {/* ── Note (if present) ── */}
        {note && (
          <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
            {note}
          </p>
        )}

        {/* ── Bottom row: timestamp + status ── */}
        <div className="flex items-center justify-end gap-2 mt-2">
          {status === "pending" && (
            <span className="text-[10px] text-warning font-medium animate-[pulse_3s_ease-in-out_infinite]">
              Pending
            </span>
          )}
          {status === "failed" && (
            <span className="text-[10px] text-error font-medium">
              Failed
            </span>
          )}
          <span className="text-[10px] text-text-muted leading-none">
            {timeAgo}
          </span>
        </div>
      </div>

      {/* ── Avatar / Icon (right side for sent) ── */}
      {isSender && (
        <div
          className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-1",
            "ring-1 ring-inset ring-white/[0.06]",
            "bg-accent/10"
          )}
        >
          <Icon className={cn("w-4 h-4", config.color)} />
        </div>
      )}
    </motion.div>
  );
}
