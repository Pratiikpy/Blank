import { useState, useCallback, useMemo } from "react";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Check, Share2, Shield, MessageSquare } from "lucide-react";
import toast from "react-hot-toast";

import { truncateAddress } from "@/lib/address";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/** Match SendAmount's input rules so a recipient can never produce a link the
 *  payer screen will reject: numeric only, single decimal point, max 6 dp.
 *  Returns the sanitised string (empty = no constraint). */
function sanitizeAmount(raw: string): string {
  const trimmed = raw.replace(/[^0-9.]/g, "");
  const parts = trimmed.split(".");
  if (parts.length === 1) return parts[0];
  // Collapse multiple dots: keep first dot only.
  const head = parts[0];
  const tail = parts.slice(1).join("").slice(0, 6);
  return tail.length > 0 ? `${head}.${tail}` : `${head}.`;
}

export default function Receive() {
  // Passkey-aware: useAccount().address is undefined for passkey-only users
  // and would render the receive page blank.
  const { effectiveAddress: address } = useEffectiveAddress();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [copiedField, setCopiedField] = useState<"address" | "link" | null>(
    null,
  );
  const [requestAmount, setRequestAmount] = useState("");
  const [requestNote, setRequestNote] = useState("");

  // Build the pay-link with optional amount + note URL params. SendAmount.tsx
  // (`?to=&amount=&note=`) consumes all three on the receiver's first paint,
  // so a "request $50 for dinner" link lands the payer on a pre-filled
  // confirm flow with one tap. Keeps the bare address case unchanged when
  // both inputs are empty.
  const paymentLink = useMemo(() => {
    if (!address) return "";
    const url = new URL(`${window.location.origin}/app/send/amount`);
    url.searchParams.set("to", address);
    // Strip a trailing dot so the URL doesn't look broken when the user
    // typed "5." but never finished the decimals.
    const cleanedAmount = requestAmount.replace(/\.$/, "");
    if (cleanedAmount && cleanedAmount !== "0") {
      url.searchParams.set("amount", cleanedAmount);
    }
    const trimmedNote = requestNote.trim();
    if (trimmedNote) url.searchParams.set("note", trimmedNote);
    return url.toString();
  }, [address, requestAmount, requestNote]);

  const copyToClipboard = useCallback(
    async (text: string, field: "address" | "link") => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedField(field);
        toast.success("Copied to clipboard");
        setTimeout(() => setCopiedField(null), 2000);
      } catch {
        toast.error("Failed to copy");
      }
    },
    [],
  );

  const handleShare = useCallback(async () => {
    if (!navigator.share || !address) return;
    const cleanedAmount = requestAmount.replace(/\.$/, "");
    const trimmedNote = requestNote.trim();
    const hasAmount = cleanedAmount && cleanedAmount !== "0";
    const text = hasAmount
      ? `Send me $${cleanedAmount} on BlankPay${trimmedNote ? `: ${trimmedNote}` : ""}`
      : "Send me an FHE-encrypted payment on BlankPay";
    try {
      await navigator.share({
        title: hasAmount ? `Pay $${cleanedAmount} on BlankPay` : "Pay me on BlankPay",
        text,
        url: paymentLink,
      });
    } catch {
      // User cancelled or share not supported -- fallback to copy
      copyToClipboard(paymentLink, "link");
    }
  }, [address, paymentLink, copyToClipboard, requestAmount, requestNote]);

  if (!address) return null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1
            className="text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
            style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
          >
            Receive Money
          </h1>
          <p className="text-base text-[var(--text-secondary)] leading-relaxed">
            Share your address or QR code to receive encrypted payments
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* QR Code Card */}
          <div className="rounded-[2rem] glass-card-static p-8 flex flex-col items-center">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Your Payment QR
            </h3>

            {/* QR Code */}
            <div className="w-64 h-64 rounded-3xl bg-white border-4 border-black/5 dark:border-white/10 flex items-center justify-center mb-6 shadow-sm">
              <QRCodeSVG
                value={paymentLink || address || ""}
                size={isMobile ? 160 : 220}
                level="M"
                bgColor="#FFFFFF"
                fgColor="#000000"
                includeMargin={false}
              />
            </div>

            {/* Name and badge */}
            <p
              className="text-lg font-medium text-[var(--text-primary)] mb-2 font-mono"
            >
              {truncateAddress(address)}
            </p>
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Shield size={14} className="text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                FHE Protected
              </span>
            </div>

            <p className="text-sm text-[var(--text-secondary)] text-center mt-4">
              {requestAmount && requestAmount !== "0"
                ? `Scan to send $${requestAmount.replace(/\.$/, "")}`
                : "Scan to send me money"}
            </p>

            {/* Optional request inputs — populate the QR/link with a
                specific amount + note. Empty inputs preserve the bare
                "send to my address" QR. */}
            <div className="w-full mt-6 pt-6 border-t border-black/5 dark:border-white/10 space-y-3">
              <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)]">
                Request a specific amount (optional)
              </p>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] font-medium">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="h-12 w-full pl-9 pr-4 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)] font-mono"
                  placeholder="0.00"
                  aria-label="Request amount in USDC"
                  value={requestAmount}
                  onChange={(e) => setRequestAmount(sanitizeAmount(e.target.value))}
                />
              </div>
              <div className="relative">
                <MessageSquare
                  size={16}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                />
                <input
                  type="text"
                  className="h-12 w-full pl-11 pr-4 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)]"
                  placeholder="What is this for?"
                  aria-label="Payment note"
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  maxLength={280}
                />
              </div>
            </div>
          </div>

          {/* Address & Links Card */}
          <div className="rounded-[2rem] glass-card-static p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Your Address
            </h3>

            <div className="space-y-4">
              {/* Wallet Address */}
              <div className="p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2">
                  Wallet Address
                </p>
                <p className="font-mono text-sm text-[var(--text-primary)] break-all">
                  {address}
                </p>
              </div>

              {/* Copy Address Button */}
              <button
                onClick={() => copyToClipboard(address, "address")}
                className="w-full h-14 px-6 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium transition-all active:scale-95 hover:bg-[#000000] dark:hover:bg-gray-100 flex items-center justify-center gap-2"
                aria-label="Copy address"
              >
                {copiedField === "address" ? (
                  <>
                    <Check size={20} strokeWidth={2.2} />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={20} strokeWidth={2.2} />
                    <span>Copy Address</span>
                  </>
                )}
              </button>

              {/* Payment Link */}
              <div className="p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2">
                  Payment Link
                </p>
                <p className="text-sm text-[var(--text-primary)] break-all">
                  {paymentLink}
                </p>
              </div>

              {/* Copy Payment Link */}
              <button
                onClick={() => copyToClipboard(paymentLink, "link")}
                className="w-full h-14 px-6 rounded-2xl bg-black/5 dark:bg-white/10 text-[var(--text-primary)] font-medium transition-all active:scale-95 hover:bg-black/10 dark:hover:bg-white/20 flex items-center justify-center gap-2"
                aria-label="Copy payment link"
              >
                {copiedField === "link" ? (
                  <>
                    <Check size={20} strokeWidth={2.2} />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={20} strokeWidth={2.2} />
                    <span>Copy Payment Link</span>
                  </>
                )}
              </button>

              {/* Share button */}
              <button
                onClick={handleShare}
                className="w-full h-14 px-6 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium transition-all active:scale-95 hover:bg-[#000000] dark:hover:bg-gray-100 flex items-center justify-center gap-2"
                aria-label="Share payment link"
              >
                <Share2 size={20} strokeWidth={2.2} />
                <span>Share Payment Link</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
