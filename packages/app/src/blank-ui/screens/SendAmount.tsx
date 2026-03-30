import { useState, useCallback, useEffect } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { Shield, MessageSquare, ChevronLeft } from "lucide-react";
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

  const { setRecipient, setAmount, setNote, note, send, canProceed } =
    useSendPayment();
  const balance = useEncryptedBalance();

  const [localAmount, setLocalAmount] = useState("0");
  const [showNote, setShowNote] = useState(false);

  // Sync recipient on mount - prefer URL param, then location state
  useEffect(() => {
    const target = recipient || urlRecipient || "";
    if (target) setRecipient(target);
  }, [recipient, urlRecipient, setRecipient]);

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

  const handleContinue = () => {
    if (!canProceed) return;
    send();
    navigate("/send/confirm");
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

        {/* Recipient card */}
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

        {/* Amount display */}
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
                // Use decrypted vault balance if available, otherwise show warning
                if (balance.isDecrypted && balance.raw !== null) {
                  const max = (Number(balance.raw) / 1e6).toFixed(6);
                  setLocalAmount(max);
                  setAmount(max);
                } else if (balance.totalDeposited > 0) {
                  // Approximate from vault aggregate (only correct for single-user testnet)
                  const max = balance.totalDeposited.toFixed(6);
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
          <div className="mt-4 flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <Shield size={14} className="text-emerald-600 dark:text-emerald-400" />
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              FHE Encrypted
            </span>
          </div>
        </div>

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

        {/* Keypad */}
        <div className="mb-4">
          <NumericKeypad onKey={handleKey} onBackspace={handleBackspace} />
        </div>

        {/* Continue button */}
        <div className="px-2 pb-6">
          <button
            disabled={!canProceed || localAmount === "0"}
            onClick={handleContinue}
            className={cn(
              "w-full h-14 rounded-2xl font-medium transition-all active:scale-95 flex items-center justify-center gap-2",
              canProceed && localAmount !== "0"
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
