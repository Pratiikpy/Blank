import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import { ArrowLeft, AlertOctagon } from "lucide-react";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useP2POfframp, type OfferRow } from "@/hooks/useP2POfframp";
import { P2POfframpAbi } from "@/lib/abis";
import { RailBadge } from "@/blank-ui/components/offramp/RailBadge";
import { ReputationBadge } from "@/blank-ui/components/offramp/ReputationBadge";
import { railById, type RailId } from "@/lib/reclaim-providers";

/**
 * Wave 5 Block 1 — offer detail + take flow.
 *
 * Reads the on-chain offer + maker reputation, shows the maker's rail
 * details, and offers the Take button (which calls takeOffer →
 * navigates to /app/offramp/fill/:fillId).
 */
export default function OfframpOfferDetail() {
  const { offerId: offerIdStr } = useParams<{ offerId: string }>();
  const navigate = useNavigate();
  const { activeChainId } = useChain();
  const { effectiveAddress: address } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const hook = useP2POfframp();

  const [offer, setOffer] = useState<OfferRow | null>(null);
  const [rep, setRep] = useState<{ fillCount: number; disputeCount: number }>({ fillCount: 0, disputeCount: 0 });
  const [loading, setLoading] = useState(true);

  const offerId = useMemo(() => {
    if (!offerIdStr) return null;
    try { return BigInt(offerIdStr); } catch { return null; }
  }, [offerIdStr]);

  useEffect(() => {
    if (offerId === null || !publicClient || hook.deploy.status !== "live" || !hook.deploy.address) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const o = (await publicClient.readContract({
          address: hook.deploy.address!,
          abi: P2POfframpAbi,
          functionName: "getOffer",
          args: [offerId],
        })) as readonly [
          `0x${string}`, `0x${string}`, bigint, bigint, number, `0x${string}`, number, number,
        ];
        if (cancelled) return;
        const row: OfferRow = {
          offerId,
          maker: o[0],
          vault: o[1],
          fiatAmountMicroUSD: o[2],
          fiatRateMicroUSD: o[3],
          fiatRail: o[4],
          makerHandleHash: o[5],
          expiry: o[6],
          state: o[7],
        };
        setOffer(row);

        const reputation = (await publicClient.readContract({
          address: hook.deploy.address!,
          abi: P2POfframpAbi,
          functionName: "getMakerReputation",
          args: [row.maker],
        })) as readonly [number, number];
        if (!cancelled) setRep({ fillCount: reputation[0], disputeCount: reputation[1] });
      } catch (err) {
        console.warn("OfframpOfferDetail: failed to read offer", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [offerId, publicClient, hook.deploy.status, hook.deploy.address]);

  const handleTake = async () => {
    if (offerId === null) return;
    try {
      const out = await hook.takeOffer(offerId);
      if (out?.fillId !== undefined) {
        toast.success(`Fill #${out.fillId.toString()} locked.`);
        navigate(`/app/offramp/fill/${out.fillId.toString()}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return <DetailShell><div className="text-[var(--text-secondary)]">Loading offer…</div></DetailShell>;
  }
  if (hook.deploy.status !== "live") {
    return (
      <DetailShell>
        <div
          data-testid="offramp-detail-not-deployed"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3"
        >
          <AlertOctagon size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium text-amber-700">Coming soon on this chain</div>
            <div className="text-[var(--text-primary)]/70 mt-0.5">
              Offer detail unavailable until P2POfframp contracts are deployed here.
            </div>
          </div>
        </div>
      </DetailShell>
    );
  }
  if (!offer) {
    return <DetailShell><div className="text-rose-600">Offer not found.</div></DetailShell>;
  }

  const rail = railById(offer.fiatRail as RailId);
  const expired = offer.expiry * 1000 < Date.now();
  const cancelled = offer.state === 1;
  const filled = offer.state === 2;
  const isMine = address && offer.maker.toLowerCase() === address.toLowerCase();
  const canTake = !isMine && !cancelled && !filled && !expired && address;

  return (
    <DetailShell>
      <div className="glass-card-static rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <RailBadge railId={offer.fiatRail} />
          <ReputationBadge fillCount={rep.fillCount} disputeCount={rep.disputeCount} />
          {cancelled && <Pill tone="slate">cancelled</Pill>}
          {filled && <Pill tone="blue">filled</Pill>}
          {expired && !cancelled && !filled && <Pill tone="amber">expired</Pill>}
        </div>
        <div className="text-3xl font-semibold tabular-nums" data-testid="offramp-detail-fiat">
          ${(Number(offer.fiatAmountMicroUSD) / 1_000_000).toFixed(2)}
        </div>
        <div className="text-sm text-[var(--text-secondary)] mt-1">
          @ ${(Number(offer.fiatRateMicroUSD) / 1_000_000).toFixed(4)} / USDC ·
          maker {offer.maker.slice(0, 6)}…{offer.maker.slice(-4)} · offer #{offer.offerId.toString()}
        </div>

        <div className="mt-5 rounded-xl bg-white/60 border border-black/5 p-3 text-xs">
          <div className="text-[var(--text-secondary)] mb-1">Maker's {rail?.label} handle digest</div>
          <div className="font-mono break-all">{offer.makerHandleHash}</div>
        </div>

        <div className="mt-3 rounded-xl bg-blue-500/5 border border-blue-500/20 p-3 text-xs text-blue-700">
          The exact handle isn't shown publicly. After you take this offer, the
          Reclaim attestation widget will give you the handle to pay so the
          on-chain verifier can confirm the rail payment matches.
        </div>
      </div>

      {canTake ? (
        <button
          data-testid="offramp-detail-take"
          onClick={handleTake}
          disabled={hook.state.isProcessing}
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-50"
        >
          {hook.state.isProcessing ? "Locking…" : "Take this offer"}
        </button>
      ) : isMine && !cancelled && !filled ? (
        <button
          data-testid="offramp-detail-cancel"
          onClick={async () => {
            try {
              await hook.cancelOffer(offer.offerId);
              toast.success("Offer cancelled.");
              navigate("/app/offramp");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
          className="w-full h-14 rounded-2xl bg-rose-600 text-white font-medium hover:bg-rose-700"
        >
          Cancel this offer
        </button>
      ) : (
        <Link
          to="/app/offramp"
          className="block w-full h-14 leading-[3.5rem] text-center rounded-2xl bg-white/60 border border-white/60 hover:bg-white/80 font-medium"
        >
          Back to order book
        </Link>
      )}
    </DetailShell>
  );
}

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
      <div className="max-w-xl mx-auto">
        <Link to="/app/offramp" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] mb-6 hover:text-[var(--text-primary)]">
          <ArrowLeft size={14} /> Order book
        </Link>
        {children}
      </div>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "slate" | "blue" | "amber" }) {
  const cls =
    tone === "slate" ? "bg-slate-200 text-slate-700" :
    tone === "blue"  ? "bg-blue-500/10 text-blue-600" :
                       "bg-amber-500/10 text-amber-600";
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{children}</span>;
}
