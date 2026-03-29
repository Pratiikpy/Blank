import { useState } from "react";
import { User, DollarSign, MessageSquare, ArrowRight, Lock, Eye } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import { cn } from "@/lib/cn";

interface SendFormProps {
  recipient: string;
  amount: string;
  note: string;
  token: string;
  canProceed: boolean;
  cofheConnected?: boolean;
  contacts?: { address: string; nickname: string }[];
  availableBalance?: string;
  onRecipientChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSend: () => void;
}

const isValidAddress = (addr: string) => !addr || /^0x[a-fA-F0-9]{40}$/.test(addr);

/** Derive a human-readable reason why the button is disabled. */
function getDisabledReason(recipient: string, amount: string): string | null {
  if (!recipient.trim()) return "Enter recipient address";
  if (!isValidAddress(recipient)) return "Invalid Ethereum address";
  if (!amount.trim() || parseFloat(amount) <= 0) return "Enter amount";
  return null;
}

export function SendForm({
  recipient,
  amount,
  note,
  token,
  canProceed,
  cofheConnected,
  contacts,
  availableBalance,
  onRecipientChange,
  onAmountChange,
  onNoteChange,
  onSend,
}: SendFormProps) {
  const disabledReason = getDisabledReason(recipient, amount);
  const truncatedRecipient = recipient
    ? `${recipient.slice(0, 6)}...${recipient.slice(-4)}`
    : null;
  const [showContactDropdown, setShowContactDropdown] = useState(false);
  const filteredContacts = contacts?.filter(
    (c) =>
      c.nickname.toLowerCase().includes(recipient.toLowerCase()) ||
      c.address.toLowerCase().includes(recipient.toLowerCase())
  ).slice(0, 5) ?? [];

  return (
    <div className="space-y-5 bg-apple-gray6/30 backdrop-blur-xl border border-white/[0.05] rounded-[2rem] p-6">
      {/* ─── HERO AMOUNT ────────────────────────────────────────────── */}
      <GlassCard variant="elevated">
        <div className="flex flex-col items-center py-4">
          {/* Amount input row: $ + input + token pill */}
          <div className="flex items-center justify-center gap-1 w-full">
            {/* Dollar sign prefix */}
            <span className={cn("text-5xl font-mono select-none leading-none", amount ? "text-neutral-400" : "text-neutral-600")}>
              $
            </span>

            {/* The hero input — borderless, huge, centered */}
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => onAmountChange(e.target.value)}
              className="text-5xl font-mono font-bold text-white bg-transparent border-none outline-none placeholder:text-neutral-700 caret-accent tabular-nums text-center w-full max-w-[280px] leading-none"
              aria-label="Payment amount"
            />

            {/* Token pill */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-glass-strong border border-glass-border shrink-0">
              <DollarSign className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-semibold text-neutral-300 tracking-wide">
                {token}
              </span>
            </div>
          </div>

          {/* Available balance */}
          {availableBalance && (
            <p className="text-xs text-apple-secondary mt-2">
              Available: <span className="font-mono tabular-nums text-white">{availableBalance}</span> USDC
            </p>
          )}

          {/* Encrypted preview — what recipient sees */}
          <div className="mt-3 flex items-center gap-2">
            <Lock className="w-3 h-3 text-encrypted/60" />
            <span className="text-sm font-mono text-encrypted/70 tracking-wide">
              = {ENCRYPTED_PLACEHOLDER} encrypted
            </span>
          </div>
        </div>
      </GlassCard>

      {/* ─── RECIPIENT ──────────────────────────────────────────────── */}
      <GlassCard variant="default">
        <div className="relative">
          <Input
            label="Recipient"
            placeholder="0x... or ENS name"
            value={recipient}
            onChange={(e) => { onRecipientChange(e.target.value); setShowContactDropdown(true); }}
            onFocus={() => setShowContactDropdown(true)}
            onBlur={() => { setTimeout(() => setShowContactDropdown(false), 150); }}
            rightElement={<User className="w-4 h-4 text-neutral-600" />}
            error={recipient && !recipient.match(/^0x[a-fA-F0-9]{40}$/) ? "Invalid Ethereum address" : undefined}
          />
          {showContactDropdown && filteredContacts.length > 0 && recipient && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-apple-gray6 border border-white/[0.06] rounded-xl overflow-hidden z-20 max-h-40 overflow-y-auto">
              {filteredContacts.map((c) => (
                <button
                  key={c.address}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onRecipientChange(c.address); setShowContactDropdown(false); }}
                  className="w-full text-left px-4 py-2.5 hover:bg-apple-gray5 transition-colors flex items-center gap-3"
                >
                  <span className="text-sm font-medium text-white">{c.nickname}</span>
                  <span className="text-xs font-mono text-apple-secondary">{c.address.slice(0, 8)}...{c.address.slice(-4)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </GlassCard>

      {/* ─── NOTE ───────────────────────────────────────────────────── */}
      <GlassCard variant="default">
        <Input
          label="Note (optional)"
          placeholder="What's this for?"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          hint="Notes are public — everyone can see them"
          rightElement={<MessageSquare className="w-4 h-4 text-neutral-600" />}
        />
      </GlassCard>

      {/* ─── PRIVACY PREVIEW ────────────────────────────────────────── */}
      <GlassCard variant="outlined">
        <div className="space-y-0">
          {/* PUBLIC section */}
          <div className="flex items-start gap-3 pb-3">
            <div className="w-7 h-7 rounded-lg bg-white/[0.04] border border-glass-border flex items-center justify-center shrink-0 mt-0.5">
              <Eye className="w-3.5 h-3.5 text-neutral-400" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-label font-semibold uppercase text-neutral-500 tracking-widest block mb-1">
                Public
              </span>
              <p className="text-sm text-white leading-relaxed">
                You{" "}
                <span className="text-neutral-500 mx-1">&rarr;</span>{" "}
                <span className="font-mono text-neutral-300">
                  {truncatedRecipient || "Recipient"}
                </span>
                {note && (
                  <span className="text-neutral-500 ml-2">
                    &ldquo;{note}&rdquo;
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Dashed divider */}
          <div className="border-t border-dashed border-encrypted/15 my-0" />

          {/* ENCRYPTED section */}
          <div className="flex items-start gap-3 pt-3">
            <div className="w-7 h-7 rounded-lg bg-encrypted/[0.06] border border-encrypted/15 flex items-center justify-center shrink-0 mt-0.5">
              <Lock className="w-3.5 h-3.5 text-encrypted" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-label font-semibold uppercase text-encrypted/60 tracking-widest block mb-1">
                Encrypted
              </span>
              <p className="text-sm font-mono text-encrypted leading-relaxed">
                Amount: {ENCRYPTED_PLACEHOLDER}
              </p>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* ─── COFHE CONNECTION WARNING ──────────────────────────────── */}
      {cofheConnected === false && (
        <p className="text-xs text-warning font-medium animate-pulse">Connecting to encryption engine...</p>
      )}

      {/* ─── SEND BUTTON ────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Button
          variant="primary"
          size="lg"
          className="w-full apple-btn-primary"
          disabled={!canProceed || !isValidAddress(recipient)}
          onClick={onSend}
          icon={<ArrowRight className="w-4 h-4" />}
        >
          Encrypt & Send
        </Button>

        {/* Disabled reason hint */}
        {disabledReason && (
          <p className="text-center text-caption text-neutral-600">
            {disabledReason}
          </p>
        )}
      </div>
    </div>
  );
}
