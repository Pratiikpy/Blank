import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  X,
  ShieldCheck,
  Info,
  Users,
  Repeat,
  Workflow,
} from "lucide-react";
import { useExchange } from "@/hooks/useExchange";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import DexSwapTab from "./DexSwapTab";
import Bridge from "./Bridge";
import { cn } from "@/lib/cn";
import { formatUnits } from "viem";

// Exchange screen: DEX | Bridge | P2P (retired).
// `?tab=` is the source of truth so deeplinks like /app/swap?tab=bridge work.
// The token-for-token P2P book (P2PExchange) is retired on-chain. Its tab
// stays so makers can cancel open offers and both sides can verify past
// fills. New P2P trades go through the fiat offramp at /app/offramp.

type ExchangeTab = "dex" | "bridge" | "p2p";

const VALID_TABS: ReadonlySet<ExchangeTab> = new Set(["dex", "bridge", "p2p"]);

const TAB_DEFS: Array<{ id: ExchangeTab; label: string; Icon: typeof Users; sublabel: string }> = [
  { id: "dex", label: "DEX", Icon: Repeat, sublabel: "Uniswap v3" },
  { id: "bridge", label: "Bridge", Icon: Workflow, sublabel: "CCTP V2" },
  { id: "p2p", label: "P2P", Icon: Users, sublabel: "Retired" },
];

function formatOfferAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return "0";
  const raw = formatUnits(BigInt(Math.trunc(amount)), 6);
  return raw.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function parseTab(raw: string | null): ExchangeTab {
  return raw && VALID_TABS.has(raw as ExchangeTab) ? (raw as ExchangeTab) : "dex";
}

export default function Swap() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  const setTab = useCallback(
    (next: ExchangeTab) => {
      const sp = new URLSearchParams(searchParams);
      if (next === "dex") {
        sp.delete("tab"); // clean URL for the default tab
      } else {
        sp.set("tab", next);
      }
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Exchange
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Swap tokens through the DEX or bridge USDC across chains.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Exchange surface"
          data-testid="exchange-tabs"
          className="mb-8 inline-flex p-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10"
        >
          {TAB_DEFS.map(({ id, label, Icon, sublabel }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              data-testid={`exchange-tab-${id}`}
              onClick={() => setTab(id)}
              className={cn(
                "h-12 px-5 rounded-xl text-sm font-medium transition-all flex items-center gap-2.5 group",
                tab === id
                  ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              <Icon size={16} />
              <span className="flex flex-col items-start leading-tight">
                <span>{label}</span>
                <span
                  className={cn(
                    "text-[10px] font-normal",
                    tab === id ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
                  )}
                >
                  {sublabel}
                </span>
              </span>
            </button>
          ))}
        </div>

        {tab === "dex" && <DexSwapTab />}
        {tab === "bridge" && <Bridge embedded />}
        {tab === "p2p" && <P2PRetiredTab />}
      </div>
    </div>
  );
}

function P2PRetiredTab() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const {
    offers,
    filledOffers,
    cancelOffer,
    isCancelling,
    verifyTrade,
    verifyingOfferId,
    isLoadingOffers,
  } = useExchange();

  const me = address?.toLowerCase();
  const myOpenOffers = offers.filter((o) => o.status === "active" && o.maker_address === me);

  return (
    <>
      <div
        data-testid="p2p-retired-banner"
        className="mb-6 rounded-2xl p-5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 flex items-start gap-3"
      >
        <Info size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-amber-900 dark:text-amber-200 mb-1">
            The token P2P book is retired
          </p>
          <p className="text-sm text-amber-800 dark:text-amber-300/80 leading-relaxed">
            New offers and fills are disabled on-chain. You can still cancel your open offers and
            verify past fills here. To trade USDC for fiat with another person, use the{" "}
            <Link to="/app/offramp" className="underline font-medium">
              P2P offramp
            </Link>
            .
          </p>
        </div>
      </div>

      {isLoadingOffers && (
        <div className="rounded-[2rem] glass-card p-8 mb-6">
          <div className="flex items-center justify-center py-8 gap-3">
            <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
            <span className="text-[var(--text-primary)]/50">Loading your offers...</span>
          </div>
        </div>
      )}

      {myOpenOffers.length > 0 && (
        <div className="rounded-[2rem] glass-card p-6 sm:p-8 mb-6" data-testid="p2p-my-open-offers">
          <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
            My open offers
          </h3>
          <div className="space-y-3">
            {myOpenOffers.map((offer) => (
              <div
                key={offer.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-5 rounded-2xl bg-white/50 border border-black/5"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center shrink-0">
                    <ArrowLeftRight size={24} className="text-purple-600" />
                  </div>
                  <p className="font-medium text-[var(--text-primary)]">
                    Offering {formatOfferAmount(offer.amount_give)} USDC for{" "}
                    {formatOfferAmount(offer.amount_want)} USDT · #{offer.offer_id}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (!window.confirm("Cancel this offer? This cannot be undone.")) return;
                    cancelOffer(offer.offer_id);
                  }}
                  disabled={isCancelling}
                  className="h-10 px-5 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 border border-red-100 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1"
                  aria-label="Cancel offer"
                >
                  {isCancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {filledOffers.length > 0 && (
        <div className="rounded-[2rem] glass-card p-6 sm:p-8 mb-6">
          <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
            Past fills
          </h3>
          <p className="text-sm text-[var(--text-primary)]/50 mt-1 mb-6">
            Publish the encrypted trade-validity verdict so anyone can read it on-chain.
          </p>
          <div className="space-y-3">
            {filledOffers.map((offer) => {
              const isVerifying = verifyingOfferId === offer.offer_id;
              const isMaker = offer.maker_address === me;
              return (
                <div
                  key={offer.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-5 rounded-2xl bg-white/50 border border-black/5"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0">
                      <CheckCircle2 size={24} className="text-emerald-600" />
                    </div>
                    <p className="font-medium text-[var(--text-primary)]">
                      {isMaker ? "Sold" : "Bought"} {formatOfferAmount(offer.amount_give)} USDC for{" "}
                      {formatOfferAmount(offer.amount_want)} USDT · #{offer.offer_id}
                    </p>
                  </div>
                  <button
                    onClick={() => verifyTrade(offer.offer_id)}
                    disabled={verifyingOfferId !== null}
                    className="h-10 px-5 rounded-xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-[#000000] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    aria-label="Verify trade on-chain"
                  >
                    {isVerifying ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      <>
                        <ShieldCheck size={14} />
                        Verify trade
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!isLoadingOffers && myOpenOffers.length === 0 && filledOffers.length === 0 && (
        <div className="rounded-[2rem] glass-card p-8" data-testid="p2p-retired-empty">
          <div className="text-center py-8 text-[var(--text-primary)]/40">
            <ArrowLeftRight size={40} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium mb-1">Nothing to do here</p>
            <p className="text-sm">You have no open offers and no past fills on the retired book.</p>
          </div>
        </div>
      )}
    </>
  );
}
