import { useNavigate } from "react-router-dom";
import { Shield, Check, ExternalLink } from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";

export default function SendSuccess() {
  const navigate = useNavigate();
  const payment = useSendPayment();

  const handleBackHome = () => {
    payment.reset();
    navigate("/", { replace: true });
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="min-h-[calc(100dvh-8rem)] flex flex-col items-center justify-center px-6">
        {/* Large gradient circle with Shield + Check */}
        <div className="relative mb-10">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-lg shadow-emerald-500/25">
            <Shield size={48} className="text-white" strokeWidth={1.8} />
          </div>
          {/* Check overlay */}
          <div className="absolute -bottom-1 -right-1 w-12 h-12 rounded-full bg-white dark:bg-gray-900 flex items-center justify-center shadow-lg">
            <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center">
              <Check size={20} className="text-white" strokeWidth={3} />
            </div>
          </div>
        </div>

        {/* Heading */}
        <h1
          className="text-3xl font-semibold tracking-tight text-[var(--text-primary)] mb-3 text-center"
          style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
        >
          Payment Sent!
        </h1>

        {/* Subtitle */}
        <p className="text-base text-[var(--text-secondary)] text-center max-w-sm mb-6 leading-relaxed">
          Your encrypted payment has been confirmed on Base Sepolia. The amount is
          protected by Fully Homomorphic Encryption.
        </p>

        {/* FHE badge */}
        <div className="mb-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <Shield size={16} className="text-emerald-600 dark:text-emerald-400" />
            <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              FHE Protected
            </span>
          </div>
        </div>

        {/* Payment Details */}
        {payment.recipient && (
          <div className="w-full max-w-sm space-y-3 mb-10">
            <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
              <span className="text-sm text-[var(--text-secondary)]">To</span>
              <span className="text-sm font-mono">
                {payment.recipient.slice(0, 10)}...{payment.recipient.slice(-6)}
              </span>
            </div>
            <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
              <span className="text-sm text-[var(--text-secondary)]">Amount</span>
              <span className="text-sm font-mono">${payment.amount} USDC</span>
            </div>
            {payment.txHash && (
              <a
                href={`https://sepolia.basescan.org/tx/${payment.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 h-12 rounded-2xl bg-blue-50 text-blue-600 font-medium text-sm hover:bg-blue-100 transition-colors w-full"
              >
                View on Basescan <ExternalLink size={16} />
              </a>
            )}
          </div>
        )}

        {/* Back to Home button */}
        <div className="w-full max-w-sm">
          <button
            onClick={handleBackHome}
            className="w-full h-14 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium transition-all active:scale-95 hover:bg-[#000000] dark:hover:bg-gray-100 flex items-center justify-center gap-2"
          >
            Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
