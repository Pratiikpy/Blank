import { useState, useCallback, useEffect } from "react";
import {
  ArrowDownUp,
  Lock,
  Fuel,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  X,
  AlertTriangle,
} from "lucide-react";
import { useExchange } from "@/hooks/useExchange";
import { useShield } from "@/hooks/useShield";
import { useAccount } from "wagmi";

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Swap() {
  const { address } = useAccount();
  const { offers, createOffer, fillOffer, cancelOffer, isLoadingOffers, step, error, reset } = useExchange();
  const { publicBalance } = useShield();

  const [giveAmount, setGiveAmount] = useState("");
  const [wantAmount, setWantAmount] = useState("");
  const [lastSwap, setLastSwap] = useState<{ give: string; want: string } | null>(null);

  // Clear success state after 4 seconds
  useEffect(() => {
    if (step === "success") {
      const timer = setTimeout(() => {
        setLastSwap(null);
        reset();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [step, reset]);

  const handleCreateOffer = useCallback(async () => {
    if (!giveAmount || parseFloat(giveAmount) <= 0) return;
    if (!wantAmount || parseFloat(wantAmount) <= 0) return;
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
    setLastSwap({ give: giveAmount, want: wantAmount });
    await createOffer(giveAmount, wantAmount, expiry);
    setGiveAmount("");
    setWantAmount("");
  }, [giveAmount, wantAmount, createOffer]);

  const isSubmitting = step === "approving" || step === "sending";

  const formatTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  const activeOffers = offers.filter((o) => o.status === "active");
  const myOffers = activeOffers.filter((o) => o.maker_address === address?.toLowerCase());
  const otherOffers = activeOffers.filter((o) => o.maker_address !== address?.toLowerCase());

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            P2P Exchange
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Create and fill swap offers with private amounts
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          {/* Balance Card */}
          <div className="md:col-span-1 space-y-3">
            <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-4">
              Your Balances
            </h3>

            <div className="rounded-2xl glass-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/50 border border-black/5 flex items-center justify-center text-sm font-bold text-[var(--text-primary)]">
                    U
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)]">USDC</p>
                    <p className="text-xs text-[var(--text-primary)]/50">Public</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono font-medium text-[var(--text-primary)]">
                    {publicBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl glass-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-sm font-bold text-emerald-600">
                    <Lock size={16} />
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)]">Vault USDC</p>
                    <p className="text-xs text-[var(--text-primary)]/50">Encrypted</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium encrypted-text">
                    {"\u2588\u2588\u2588\u2588\u2588"}
                  </p>
                </div>
              </div>
            </div>

            {/* Error display */}
            {error && (
              <div className="p-4 rounded-2xl bg-red-50 border border-red-100">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-red-700 break-all">{error}</p>
                </div>
              </div>
            )}
          </div>

          {/* Exchange Interface */}
          <div className="md:col-span-2 rounded-[2rem] glass-card p-8">
            {step === "success" && lastSwap ? (
              <div className="flex flex-col items-center justify-center h-full py-8">
                <div className="w-20 h-20 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
                  <CheckCircle2 size={48} className="text-emerald-500" />
                </div>
                <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">Offer Created!</h3>
                <p className="text-[var(--text-primary)]/60 text-center">
                  Offering {lastSwap.give} USDC for {lastSwap.want} USDC
                </p>
              </div>
            ) : (
            <>
            <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
              Create Swap Offer
            </h3>

            <div className="space-y-4">
              {/* Give Amount */}
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                  You Give (USDC)
                </label>
                <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
                  <input
                    type="text"
                    value={giveAmount}
                    onChange={(e) => setGiveAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-transparent text-3xl font-heading font-medium text-[var(--text-primary)] outline-none placeholder:text-black/20"
                  />
                </div>
              </div>

              {/* Swap Direction Icon */}
              <div className="flex justify-center">
                <div className="w-12 h-12 rounded-xl bg-[var(--text-primary)]/10 flex items-center justify-center">
                  <ArrowDownUp size={24} className="text-[var(--text-primary)]" />
                </div>
              </div>

              {/* Want Amount */}
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                  You Want (USDC)
                </label>
                <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
                  <input
                    type="text"
                    value={wantAmount}
                    onChange={(e) => setWantAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-transparent text-3xl font-heading font-medium text-[var(--text-primary)] outline-none placeholder:text-black/20"
                  />
                </div>
              </div>

              {/* Gas Estimate */}
              <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Fuel size={20} className="text-blue-600" />
                  <p className="text-sm font-medium text-blue-900">
                    Estimated Gas
                  </p>
                </div>
                <p className="text-sm font-medium text-blue-700">~1.2M gas</p>
              </div>

              {/* Step indicator */}
              {isSubmitting && (
                <div className="p-4 rounded-2xl bg-amber-50 border border-amber-100 flex items-center gap-3">
                  <Loader2 size={20} className="text-amber-600 animate-spin" />
                  <p className="text-sm font-medium text-amber-900">
                    {step === "approving" ? "Approving vault access..." : "Creating offer on-chain..."}
                  </p>
                </div>
              )}

              {/* Create Offer Button */}
              <button
                disabled={!giveAmount || !wantAmount || parseFloat(giveAmount) <= 0 || parseFloat(wantAmount) <= 0 || isSubmitting || !address}
                onClick={handleCreateOffer}
                className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  <Lock size={20} />
                )}
                <span>{isSubmitting ? "Processing..." : "Create Swap Offer"}</span>
              </button>
            </div>
            </>
            )}
          </div>
        </div>

        {/* Active Offers from Others */}
        {otherOffers.length > 0 && (
          <div className="rounded-[2rem] glass-card p-8 mb-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                Available Offers
              </h3>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-100">
                <ArrowLeftRight size={16} className="text-emerald-600" />
                <span className="text-sm font-medium text-emerald-600">
                  {otherOffers.length} Open
                </span>
              </div>
            </div>

            <div className="space-y-3">
              {otherOffers.map((offer) => (
                <div
                  key={offer.id}
                  className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-[#007AFF]/10 flex items-center justify-center">
                      <ArrowLeftRight size={24} className="text-[#007AFF]" />
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">
                        {offer.amount_give} USDC &rarr; {offer.amount_want} USDC
                      </p>
                      <p className="text-sm text-[var(--text-primary)]/50">
                        {offer.maker_address.slice(0, 6)}...{offer.maker_address.slice(-4)} &middot; {formatTime(offer.created_at)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => fillOffer(offer.offer_id)}
                    disabled={isSubmitting}
                    className="h-10 px-5 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50"
                  >
                    Fill Offer
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* My Active Offers */}
        {myOffers.length > 0 && (
          <div className="rounded-[2rem] glass-card p-8 mb-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                My Open Offers
              </h3>
            </div>

            <div className="space-y-3">
              {myOffers.map((offer) => (
                <div
                  key={offer.id}
                  className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                      <ArrowLeftRight size={24} className="text-purple-600" />
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">
                        Offering {offer.amount_give} USDC for {offer.amount_want} USDC
                      </p>
                      <p className="text-sm text-[var(--text-primary)]/50">
                        Created {formatTime(offer.created_at)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => cancelOffer(offer.offer_id)}
                    disabled={isSubmitting}
                    className="h-10 px-5 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 border border-red-100 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                  >
                    <X size={14} />
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!isLoadingOffers && offers.length === 0 && (
          <div className="rounded-[2rem] glass-card p-8">
            <div className="text-center py-8 text-[var(--text-primary)]/40">
              <ArrowLeftRight size={40} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium mb-1">No offers yet</p>
              <p className="text-sm">Create the first swap offer above</p>
            </div>
          </div>
        )}

        {/* Loading State */}
        {isLoadingOffers && (
          <div className="rounded-[2rem] glass-card p-8">
            <div className="flex items-center justify-center py-8 gap-3">
              <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
              <span className="text-[var(--text-primary)]/50">Loading offers...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
