import { useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Check, Share2, Shield } from "lucide-react";
import toast from "react-hot-toast";

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Receive() {
  const { address } = useAccount();
  const [copiedField, setCopiedField] = useState<"address" | "link" | null>(
    null,
  );

  const paymentLink = address
    ? `${window.location.origin}/send/amount?to=${address}`
    : "";

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
    try {
      await navigator.share({
        title: "Pay me on BlankPay",
        text: "Send me an FHE-encrypted payment on BlankPay",
        url: paymentLink,
      });
    } catch {
      // User cancelled or share not supported -- fallback to copy
      copyToClipboard(paymentLink, "link");
    }
  }, [address, paymentLink, copyToClipboard]);

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
                size={220}
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
              Scan to send me money
            </p>
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
