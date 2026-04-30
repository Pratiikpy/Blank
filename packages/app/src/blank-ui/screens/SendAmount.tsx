import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { Shield, MessageSquare, ChevronLeft, Users, Equal, ListChecks } from "lucide-react";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { cn } from "@/lib/cn";
import { useSendPayment } from "@/hooks/useSendPayment";
import { NumericKeypad } from "../components";

import { truncateAddress } from "@/lib/address";
import toast from "react-hot-toast";

function avatarColor(addr: string): string {
  const colors = [
    "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400",
    "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400",
    "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
    "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400",
    "bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-400",
    "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400",
  ];
  const hash = addr
    .toLowerCase()
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

export default function SendAmount() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const locationState = location.state as {
    recipient: string;
    nickname: string;
  } | null;
  const recipient = locationState?.recipient || "";
  const nickname = locationState?.nickname || "";
  const urlRecipient = searchParams.get("to");

  const {
    mode,
    recipients,
    splitMode,
    recipientAmounts,
    setRecipient,
    setAmount,
    setNote,
    setSplitMode,
    setRecipientAmount,
    note,
    send,
    canProceed,
  } = useSendPayment();
  const balance = useEncryptedBalance();

  const [localAmount, setLocalAmount] = useState("0");
  const [showNote, setShowNote] = useState(false);

  // Sync recipient on mount - prefer URL param, then location state
  useEffect(() => {
    const target = recipient || urlRecipient || "";
    if (target) setRecipient(target);
  }, [recipient, urlRecipient, setRecipient]);

  // Pre-fill amount + note from URL — used by the public /pay/:identifier
  // page so a freelancer's "Pay $3,700 to pratik.eth" link lands on this
  // screen with both already filled in. Defaults to "0" / blank when the
  // params are absent (regular Send flow), preserving existing behavior.
  const urlAmount = searchParams.get("amount") ?? "";
  const urlNote = searchParams.get("note") ?? "";
  useEffect(() => {
    setLocalAmount(urlAmount || "0");
    setAmount(urlAmount);
    if (urlNote) {
      setNote(urlNote);
      setShowNote(true);
    }
  }, [recipient, urlRecipient, urlAmount, urlNote, setAmount, setNote]);

  const handleKey = useCallback(
    (key: string) => {
      setLocalAmount((prev) => {
        let next = prev;
        if (prev === "0" && key !== ".") {
          next = key;
        } else if (key === "." && prev.includes(".")) {
          return prev;
        } else if (prev.includes(".") && prev.split(".")[1].length >= 6) {
          return prev;
        } else {
          next = prev + key;
        }
        setAmount(next);
        return next;
      });
    },
    [setAmount],
  );

  const handleBackspace = useCallback(() => {
    setLocalAmount((prev) => {
      const next = prev.length > 1 ? prev.slice(0, -1) : "0";
      setAmount(next === "0" ? "" : next);
      return next;
    });
  }, [setAmount]);

  // ─── Phase 8.2 — Batch totals (equal-split: per × N) ────────────────
  const equalSplitTotal = useMemo(() => {
    if (mode !== "many" || splitMode !== "equal") return "";
    const per = parseFloat(localAmount);
    if (!Number.isFinite(per) || per <= 0 || recipients.length === 0) return "";
    return (per * recipients.length).toFixed(per % 1 === 0 ? 2 : 6);
  }, [mode, splitMode, localAmount, recipients.length]);

  const customSplitTotal = useMemo(() => {
    if (mode !== "many" || splitMode !== "custom") return "";
    const sum = recipientAmounts.reduce((acc, a) => acc + (parseFloat(a) || 0), 0);
    if (sum <= 0) return "";
    return sum.toFixed(sum % 1 === 0 ? 2 : 6);
  }, [mode, splitMode, recipientAmounts]);

  const handleContinue = async () => {
    if (!canProceed) {
      toast.error(
        mode === "many"
          ? "Pick recipients and enter amounts"
          : "Enter an amount and select a recipient",
      );
      return;
    }
    await send();
    navigate("/app/send/confirm");
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-lg mx-auto flex flex-col min-h-[calc(100dvh-8rem)]">
        {/* Back button */}
        <div className="mb-6">
          <button
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <ChevronLeft size={20} className="text-[var(--text-primary)]" />
          </button>
        </div>

        {/* Recipient card — branch on mode. Single shows the picked
            contact; Many shows a recipients summary + Equal/Custom toggle. */}
        {mode === "single" ? (
          <div className="mb-6">
            <div className="rounded-[2rem] glass-card-static p-5 flex items-center gap-3">
              <div
                className={cn(
                  "w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold shrink-0",
                  avatarColor(recipient),
                )}
              >
                {(nickname || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[var(--text-primary)] truncate">
                  {nickname || truncateAddress(recipient)}
                </p>
                <p className="text-sm text-[var(--text-secondary)] font-mono">
                  {truncateAddress(recipient)}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-6 space-y-4">
            {/* Recipients summary */}
            <div className="rounded-[2rem] glass-card-static p-5 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center shrink-0">
                <Users size={20} className="text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[var(--text-primary)]">
                  {recipients.length} recipient{recipients.length === 1 ? "" : "s"}
                </p>
                <p className="text-sm text-[var(--text-secondary)] font-mono truncate">
                  {recipients.slice(0, 3).map((r) => truncateAddress(r)).join(", ")}
                  {recipients.length > 3 && ` +${recipients.length - 3} more`}
                </p>
              </div>
            </div>

            {/* Equal | Custom split toggle */}
            <div
              role="tablist"
              aria-label="Split mode"
              className="inline-flex w-full p-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10"
            >
              <button
                role="tab"
                aria-selected={splitMode === "equal"}
                data-testid="split-mode-equal"
                onClick={() => setSplitMode("equal")}
                className={cn(
                  "flex-1 h-10 px-4 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2",
                  splitMode === "equal"
                    ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                <Equal size={16} />
                <span>Equal split</span>
              </button>
              <button
                role="tab"
                aria-selected={splitMode === "custom"}
                data-testid="split-mode-custom"
                onClick={() => setSplitMode("custom")}
                className={cn(
                  "flex-1 h-10 px-4 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2",
                  splitMode === "custom"
                    ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                )}
              >
                <ListChecks size={16} />
                <span>Custom amounts</span>
              </button>
            </div>
          </div>
        )}

        {/* Amount display — branches by mode/splitMode.
            • Single OR Many+Equal: shared keypad-driven big-number display.
              In Many+Equal we annotate "× N = total" beneath.
            • Many+Custom: per-recipient input list (no keypad). */}
        {(mode === "single" || splitMode === "equal") && (
          <div className="flex-1 flex flex-col items-center justify-center py-8">
            <div className="flex items-center gap-2">
              <p
                className={cn(
                  "text-6xl font-semibold text-center tracking-tight transition-colors",
                  localAmount === "0"
                    ? "text-[var(--text-muted)]"
                    : "text-[var(--text-primary)]",
                )}
                style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace", fontVariantNumeric: "tabular-nums" }}
              >
                ${localAmount}
              </p>
              <button
                onClick={() => {
                  if (balance.isDecrypted && balance.raw !== null) {
                    const max = (Number(balance.raw) / 1e6).toFixed(6);
                    setLocalAmount(max);
                    setAmount(max);
                  } else {
                    toast("Enter amount manually — encrypted balance can't be read yet");
                  }
                }}
                className="text-xs font-medium text-[#6366F1] hover:text-[#4F46E5] px-2 py-1 rounded-lg hover:bg-[#6366F1]/5 transition-colors"
                aria-label="Set maximum amount"
              >
                MAX
              </button>
            </div>
            {mode === "many" && splitMode === "equal" && equalSplitTotal && (
              <p className="mt-2 text-sm text-[var(--text-secondary)] tabular-nums">
                × {recipients.length} ={" "}
                <span className="font-semibold text-[var(--text-primary)]">${equalSplitTotal}</span>{" "}
                total
              </p>
            )}
            <div className="mt-4 flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Shield size={14} className="text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                FHE Encrypted
              </span>
            </div>
          </div>
        )}

        {mode === "many" && splitMode === "custom" && (
          <div className="flex-1 py-4">
            <div className="space-y-2 max-h-[55dvh] overflow-y-auto pr-1">
              {recipients.map((addr, i) => (
                <div
                  key={addr}
                  className="flex items-center gap-3 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 px-4 py-3"
                >
                  <div
                    className={cn(
                      "w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0",
                      avatarColor(addr),
                    )}
                  >
                    {addr.slice(2, 3).toUpperCase()}
                  </div>
                  <p className="flex-1 min-w-0 text-sm font-mono text-[var(--text-secondary)] truncate">
                    {truncateAddress(addr)}
                  </p>
                  <div className="relative w-32">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-tertiary)]">
                      $
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      data-testid={`recipient-amount-${i}`}
                      placeholder="0.00"
                      aria-label={`Amount for ${truncateAddress(addr)}`}
                      value={recipientAmounts[i] ?? ""}
                      onChange={(e) => setRecipientAmount(i, e.target.value)}
                      className="h-10 w-full pl-7 pr-3 rounded-xl bg-white dark:bg-white/10 border border-black/10 dark:border-white/15 focus:border-black/30 dark:focus:border-white/30 outline-none transition-all text-sm font-mono text-right"
                    />
                  </div>
                </div>
              ))}
            </div>
            {customSplitTotal && (
              <p className="mt-4 text-center text-sm text-[var(--text-secondary)] tabular-nums">
                Total:{" "}
                <span className="text-2xl font-semibold text-[var(--text-primary)]">
                  ${customSplitTotal}
                </span>
              </p>
            )}
          </div>
        )}

        {/* Note input */}
        <div className="px-2 mb-4">
          {showNote ? (
            <div className="relative">
              <MessageSquare
                size={16}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <input
                type="text"
                className="h-14 w-full pl-11 pr-5 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)]"
                placeholder="What is this for?"
                aria-label="Payment note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={280}
                autoFocus
              />
            </div>
          ) : (
            <button
              onClick={() => setShowNote(true)}
              className="w-full text-center text-emerald-600 dark:text-emerald-400 font-medium py-3 hover:underline transition-colors"
              aria-label="Add a note"
            >
              Add a note
            </button>
          )}
        </div>

        {/* Keypad — hidden in custom-split mode (per-recipient inputs use
            the native keyboard instead so multiple amounts can be edited
            without arbitrating focus through a shared keypad). */}
        {(mode === "single" || splitMode === "equal") && (
          <div className="mb-4">
            <NumericKeypad onKey={handleKey} onBackspace={handleBackspace} />
          </div>
        )}

        {/* Continue button */}
        <div className="px-2 pb-6">
          <button
            disabled={
              !canProceed ||
              (mode === "single" && localAmount === "0") ||
              (mode === "many" && splitMode === "equal" && localAmount === "0")
            }
            onClick={handleContinue}
            className={cn(
              "w-full h-14 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-2",
              canProceed
                ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-[#000000] dark:hover:bg-gray-100"
                : "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed",
            )}
          >
            <Shield size={18} strokeWidth={2.2} />
            <span>Continue</span>
          </button>
        </div>
      </div>
    </div>
  );
}
