import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";

import type { OfferRow as OfferRowData } from "@/hooks/useP2POfframp";
import { RailBadge } from "./RailBadge";
import { ReputationBadge } from "./ReputationBadge";

interface OfferRowProps {
  offer: OfferRowData;
  /** Maker reputation if the parent screen already fetched it. */
  reputation?: { fillCount: number; disputeCount: number };
  /** Hide the per-row Take button if this is the maker's own offer. */
  isMine?: boolean;
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatFiat(microUSD: bigint): string {
  // Display as USD with 2 decimals. microUSD = 1e-6 USD.
  const usd = Number(microUSD) / 1_000_000;
  return `$${usd.toFixed(2)}`;
}

function formatRate(microUSD: bigint): string {
  // 1 USDC = N microUSD-of-fiat. Maker chose the wording; we just show
  // the dollar-equivalent for now.
  const usd = Number(microUSD) / 1_000_000;
  return `$${usd.toFixed(4)} / USDC`;
}

export function OfferRow({ offer, reputation, isMine }: OfferRowProps) {
  const expired = offer.expiry * 1000 < Date.now();
  const cancelled = offer.state === 1;
  const filled = offer.state === 2;
  const canTake = !isMine && !cancelled && !filled && !expired;

  return (
    <div
      data-testid="offramp-offer-row"
      data-offer-id={offer.offerId.toString()}
      className="glass-card-static rounded-2xl p-5 flex items-center gap-4"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <RailBadge railId={offer.fiatRail} />
          <ReputationBadge
            fillCount={reputation?.fillCount ?? 0}
            disputeCount={reputation?.disputeCount ?? 0}
          />
          {cancelled && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
              cancelled
            </span>
          )}
          {filled && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-600">
              filled
            </span>
          )}
          {expired && !cancelled && !filled && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-600">
              expired
            </span>
          )}
        </div>
        <div className="text-base font-semibold tabular-nums">
          {formatFiat(offer.fiatAmountMicroUSD)}{" "}
          <span className="text-sm font-normal text-[var(--text-secondary)]">
            @ {formatRate(offer.fiatRateMicroUSD)}
          </span>
        </div>
        <div className="text-xs text-[var(--text-secondary)] mt-1">
          maker {shortAddr(offer.maker)} · offer #{offer.offerId.toString()}
        </div>
      </div>
      <Link
        to={`/app/offramp/${offer.offerId.toString()}`}
        className="inline-flex items-center gap-1.5 h-10 px-4 rounded-2xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-black transition-colors disabled:opacity-40"
        aria-disabled={!canTake}
      >
        {canTake ? "Take" : "View"} <ArrowUpRight size={14} />
      </Link>
    </div>
  );
}
