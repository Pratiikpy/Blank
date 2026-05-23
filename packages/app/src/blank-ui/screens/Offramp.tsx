import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw, AlertOctagon } from "lucide-react";

import { useP2POfframp } from "@/hooks/useP2POfframp";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { OfferRow } from "@/blank-ui/components/offramp/OfferRow";
import { CreateOfferModal } from "@/blank-ui/components/offramp/CreateOfferModal";
import { ALL_RAILS } from "@/lib/reclaim-providers";

type Tab = "buy" | "sell" | "myOffers" | "myFills";

/**
 * Wave 5 Block 1 — encrypted P2P offramp order book.
 *
 * Anyone-can-take by default (the "Buy crypto / Sell crypto" duality
 * is a UX framing — under the hood every offer is a maker selling USDC
 * for fiat, takers buy USDC by paying fiat off-chain). v1 shows ALL
 * open offers in one list with a rail filter; v2 will separate buy/sell.
 *
 * Honest banner shows when the contract is not yet deployed on the
 * active chain (P2POfframp address == 0). Operator activation steps
 * live in RELEASE_OPERATOR_CHECKLIST.md.
 */
export default function Offramp() {
  const { activeChain } = useChain();
  const { effectiveAddress: address } = useEffectiveAddress();
  const hook = useP2POfframp();
  const [tab, setTab] = useState<Tab>("buy");
  const [railFilter, setRailFilter] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const visibleOffers = useMemo(() => {
    const src = tab === "myOffers" ? hook.myOffers : hook.openOffers;
    if (railFilter === null) return src;
    return src.filter((o) => o.fiatRail === railFilter);
  }, [hook.openOffers, hook.myOffers, railFilter, tab]);

  const notDeployed = hook.deploy.status !== "live";

  return (
    <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-heading font-semibold mb-2">P2P Offramp</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-2xl">
            Order amounts on Blank are encrypted until you take them.
            The fill cannot be drifted between match and release.
          </p>
        </header>

        {notDeployed && (
          <div
            data-testid="offramp-not-deployed"
            role="note"
            className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 mb-6 flex items-start gap-3"
          >
            <AlertOctagon size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-amber-700">
                Coming soon on {activeChain.name}
              </div>
              <div className="text-[var(--text-primary)]/70 mt-0.5">
                The offramp contracts are not yet deployed on this chain.
                Wave 5 Block 1 ships the contracts (verified locally with 11/11
                tests); the on-chain deploy is the next operator step.
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
          <div className="flex gap-2" role="tablist" aria-label="Offer view">
            {([
              ["buy", "Browse"],
              ["myOffers", "My offers"],
              ["myFills", "My fills"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                role="tab"
                aria-selected={tab === k}
                className={
                  "h-10 px-4 rounded-2xl text-sm font-medium transition-colors " +
                  (tab === k
                    ? "bg-[var(--text-primary)] text-white"
                    : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80")
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => hook.refreshBook()}
              className="h-10 w-10 rounded-2xl flex items-center justify-center bg-white/60 border border-white/60 hover:bg-white/80"
              aria-label="Refresh"
            >
              <RefreshCw size={16} className={hook.loadingBook ? "animate-spin" : ""} />
            </button>
            <button
              data-testid="offramp-new-offer"
              disabled={notDeployed || !address}
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 h-12 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
            >
              <Plus size={18} /> New offer
            </button>
          </div>
        </div>

        {!notDeployed && (
          <div className="flex flex-wrap gap-2 mb-6">
            <button
              onClick={() => setRailFilter(null)}
              className={
                "h-8 px-3 rounded-full text-xs font-medium " +
                (railFilter === null
                  ? "bg-[var(--text-primary)] text-white"
                  : "bg-white/60 border border-white/60 text-[var(--text-primary)]")
              }
            >
              All rails
            </button>
            {ALL_RAILS.map((r) => (
              <button
                key={r.id}
                onClick={() => setRailFilter(r.id)}
                className={
                  "h-8 px-3 rounded-full text-xs font-medium " +
                  (railFilter === r.id
                    ? "bg-[var(--text-primary)] text-white"
                    : `${r.badgeClass} hover:opacity-90`)
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {tab === "myFills" ? (
          <div className="space-y-3">
            {hook.myFills.length === 0 ? (
              <EmptyHint
                title="No fills yet"
                body="When you take an open offer, it appears here through the proof + release lifecycle."
              />
            ) : (
              hook.myFills.map((f) => (
                <Link
                  key={f.fillId.toString()}
                  to={`/app/offramp/fill/${f.fillId.toString()}`}
                  data-testid="offramp-my-fill-row"
                  data-fill-id={f.fillId.toString()}
                  className="block glass-card-static rounded-2xl p-5 hover:bg-white/60"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">Fill #{f.fillId.toString()}</div>
                      <div className="text-xs text-[var(--text-secondary)]">
                        offer #{f.offerId.toString()} · state {f.state}
                      </div>
                    </div>
                    <div className="text-sm tabular-nums">
                      ${(Number(f.fiatAmountAtLockMicroUSD) / 1_000_000).toFixed(2)}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {visibleOffers.length === 0 ? (
              <EmptyHint
                title={tab === "myOffers" ? "No offers yet" : "Order book is quiet"}
                body={
                  tab === "myOffers"
                    ? "Post the first offer with the New offer button. Order amount stays encrypted on-chain."
                    : notDeployed
                      ? "Contracts deploy here next. Check back after operator activation."
                      : "Be the first maker. Other users will see and take your offer."
                }
              />
            ) : (
              visibleOffers.map((o) => (
                <OfferRow
                  key={o.offerId.toString()}
                  offer={o}
                  isMine={address && o.maker.toLowerCase() === address.toLowerCase() ? true : false}
                />
              ))
            )}
          </div>
        )}

        {showCreate && (
          <CreateOfferModal
            hook={hook}
            onClose={() => setShowCreate(false)}
            onCreated={() => hook.refreshBook()}
          />
        )}
      </div>
    </div>
  );
}

function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass-card-static rounded-2xl p-10 text-center">
      <div className="text-base font-semibold mb-1">{title}</div>
      <div className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">{body}</div>
    </div>
  );
}
