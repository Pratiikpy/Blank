import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import { ArrowLeft, AlertOctagon, AlertTriangle, CheckCircle, Clock, Loader2 } from "lucide-react";
import { formatUnits } from "viem";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useP2POfframp } from "@/hooks/useP2POfframp";
import { P2POfframpAbi } from "@/lib/abis";
import { railById, type RailId } from "@/lib/reclaim-providers";
import { FILL_STATE } from "@/lib/offramp-fill-state";
import { ReclaimWidget } from "@/blank-ui/components/offramp/ReclaimWidget";

interface FillView {
  fillId: bigint;
  offerId: bigint;
  taker: `0x${string}`;
  fiatAmountAtLockMicroUSD: bigint;
  lockedAt: number;
  proofSubmittedAt: number;
  reclaimProofHash: `0x${string}`;
  state: number; // 0 Locked / 1 ProofSubmitted / 2 Released / 3 Disputed / 4 Resolved / 5 Refunded / 6 Pending / 7 Voided
}

interface OfferView {
  maker: `0x${string}`;
  fiatRail: number;
  makerHandleHash: `0x${string}`;
}

const USDC_DECIMALS = 6;

const STATE_LABEL: Record<number, string> = {
  0: "Locked. Pay the maker off-chain.",
  1: "Proof submitted. Challenge window open.",
  2: "Released to taker.",
  3: "Disputed. Awaiting arbiter.",
  4: "Dispute resolved.",
  5: "Refunded to maker.",
  6: "Checking the maker's escrow. Do not send fiat yet.",
  7: "Voided. The maker's balance was too low; the offer is open again.",
};

/**
 * Wave 5 Block 1 — fill lifecycle screen.
 *
 * Five-phase flow for the taker (with maker-disputable side path):
 *   6 Pending         → funding check of the maker's escrow; fiat leg stays closed
 *   7 Voided          → escrow was empty or short; offer reopened, nothing is due
 *   0 Locked          → ReclaimWidget to attest off-chain payment
 *   1 ProofSubmitted  → Challenge window countdown + Release button
 *   2 Released        → Success — USDC received
 *   3 Disputed        → Awaiting arbiter
 *   4 Resolved        → Arbiter decision rendered
 *   5 Refunded        → Refunded to maker (proof window expired)
 */
export default function OfframpFillFlow() {
  const { fillId: fillIdStr } = useParams<{ fillId: string }>();
  const { activeChainId } = useChain();
  const { effectiveAddress: address } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const hook = useP2POfframp();

  const [fill, setFill] = useState<FillView | null>(null);
  const [offer, setOffer] = useState<OfferView | null>(null);
  const [challengeWindow, setChallengeWindow] = useState<number>(300);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [disputedAt, setDisputedAt] = useState(0);
  const [disputeTimeout, setDisputeTimeout] = useState(7 * 24 * 3600);
  const [escrowed, setEscrowed] = useState<bigint | null>(null);
  const [escrowError, setEscrowError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [escrowConfirmed, setEscrowConfirmed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const autoFinishedFor = useRef<string | null>(null);

  // Tick clock every second so the challenge-window countdown is live.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const fillId = useMemo(() => {
    if (!fillIdStr) return null;
    try { return BigInt(fillIdStr); } catch { return null; }
  }, [fillIdStr]);

  const load = async () => {
    if (fillId === null || !publicClient || hook.deploy.status !== "live" || !hook.deploy.address) {
      setLoading(false);
      return;
    }
    try {
      const f = (await publicClient.readContract({
        address: hook.deploy.address,
        abi: P2POfframpAbi,
        functionName: "getFill",
        args: [fillId],
      })) as readonly [
        bigint, `0x${string}`, bigint, number, number, `0x${string}`, number,
      ];
      const fv: FillView = {
        fillId,
        offerId: f[0],
        taker: f[1],
        fiatAmountAtLockMicroUSD: f[2],
        lockedAt: f[3],
        proofSubmittedAt: f[4],
        reclaimProofHash: f[5],
        state: f[6],
      };
      setFill(fv);
      const o = (await publicClient.readContract({
        address: hook.deploy.address,
        abi: P2POfframpAbi,
        functionName: "getOffer",
        args: [fv.offerId],
      })) as readonly [
        `0x${string}`, `0x${string}`, bigint, bigint, number, `0x${string}`, number, number,
      ];
      setOffer({ maker: o[0], fiatRail: o[4], makerHandleHash: o[5] });

      const cw = (await publicClient.readContract({
        address: hook.deploy.address,
        abi: P2POfframpAbi,
        functionName: "CHALLENGE_WINDOW_SECONDS",
      })) as number;
      setChallengeWindow(cw);

      if (fv.state === 3) {
        const [at, timeout] = await Promise.all([
          publicClient.readContract({
            address: hook.deploy.address,
            abi: P2POfframpAbi,
            functionName: "fillDisputedAt",
            args: [fillId],
          }) as Promise<number>,
          publicClient.readContract({
            address: hook.deploy.address,
            abi: P2POfframpAbi,
            functionName: "DISPUTE_TIMEOUT_SECONDS",
          }) as Promise<number>,
        ]);
        setDisputedAt(Number(at));
        setDisputeTimeout(Number(timeout));
      }
    } catch (err) {
      console.warn("OfframpFillFlow: load failed", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [fillId, publicClient, hook.deploy.status]);

  // Finish the escrow check of a fill left Pending (tab closed, slow Threshold
  // Network). Anyone may confirm, so this runs for taker, maker and visitors.
  const finishFill = async () => {
    if (fillId === null) return;
    setFinishing(true);
    setFinishError(null);
    try {
      const verdict = await hook.confirmPendingFill(fillId);
      if (verdict === "locked") toast.success("Escrow confirmed. You can now pay the maker.");
      else toast.error("The maker's balance was too low; the offer is open again.");
      await load();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinishing(false);
    }
  };

  useEffect(() => {
    if (!fill || fill.state !== FILL_STATE.Pending || !hook.fheReady) return;
    const key = fill.fillId.toString();
    if (autoFinishedFor.current === key) return;
    autoFinishedFor.current = key;
    void finishFill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, hook.fheReady]);

  if (loading) {
    return <Shell><div className="text-[var(--text-secondary)]">Loading fill…</div></Shell>;
  }
  if (hook.deploy.status !== "live") {
    return (
      <Shell>
        <NotDeployedBanner />
      </Shell>
    );
  }
  if (!fill || !offer) {
    return <Shell><div className="text-rose-600">Fill not found.</div></Shell>;
  }

  const isTaker = address && fill.taker.toLowerCase() === address.toLowerCase();
  const isMaker = address && offer.maker.toLowerCase() === address.toLowerCase();
  const rail = railById(offer.fiatRail as RailId);
  const fiatUsd = (Number(fill.fiatAmountAtLockMicroUSD) / 1_000_000).toFixed(2);

  const proofUnlockTs = fill.proofSubmittedAt + challengeWindow;
  const secondsUntilRelease = Math.max(0, proofUnlockTs - now);

  const submitProof = async (proof: `0x${string}`, providerId: RailId) => {
    try {
      await hook.submitProof({ fillId: fill.fillId, reclaimProof: proof, providerId });
      toast.success("Proof submitted on-chain.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const checkEscrow = async () => {
    setDecrypting(true);
    setEscrowError(null);
    try {
      const v = await hook.decryptEscrowedAmount(fill.fillId);
      setEscrowed(v);
    } catch (err) {
      setEscrowError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecrypting(false);
    }
  };

  const resolveStale = async () => {
    try {
      await hook.resolveStaleDispute(fill.fillId);
      toast.success("Dispute timed out. Encrypted USDC released to the taker.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const release = async () => {
    try {
      await hook.releaseFill(fill.fillId);
      toast.success("Fill released. Encrypted USDC sent to taker.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const dispute = async () => {
    const reason = window.prompt("Reason for dispute (visible on-chain):") ?? "";
    if (!reason.trim()) return;
    try {
      await hook.disputeFill(fill.fillId, reason.trim());
      toast.success("Dispute opened. Arbiter will resolve.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const expire = async () => {
    try {
      await hook.expireFill(fill.fillId);
      toast.success("Fill expired. Maker funds refunded.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Shell>
      <div className="glass-card-static rounded-2xl p-6 mb-6">
        <div className="text-xs text-[var(--text-secondary)] mb-1">
          Fill #{fill.fillId.toString()} · offer #{fill.offerId.toString()}
        </div>
        <div className="text-2xl font-semibold tabular-nums" data-testid="offramp-fill-fiat">
          ${fiatUsd}
        </div>
        <div className="text-sm mt-2" data-testid="offramp-fill-state">
          {STATE_LABEL[fill.state] ?? `state ${fill.state}`}
        </div>
      </div>

      {/* Phase 6: Pending, the maker's escrow is being checked */}
      {fill.state === FILL_STATE.Pending && (
        <div className="space-y-3" data-testid="offramp-fill-pending">
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-700">
            <Clock size={16} className="inline mr-1" />
            The network is checking that the maker's escrow is funded. The payment step opens
            only once it is. Do not send any fiat before then.
          </div>
          {finishError && (
            <div
              data-testid="offramp-fill-finish-error"
              className="flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-sm text-rose-700"
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{finishError}</span>
            </div>
          )}
          <button
            data-testid="offramp-fill-finish"
            onClick={finishFill}
            disabled={finishing || !hook.fheReady}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40 inline-flex items-center justify-center gap-2"
          >
            {finishing && <Loader2 size={16} className="animate-spin" />}
            {finishing ? "Checking escrow…" : !hook.fheReady ? "Connecting to the FHE network…" : "Finish escrow check"}
          </button>
          {isMaker && (
            <button
              data-testid="offramp-fill-expire-pending"
              onClick={expire}
              disabled={now < fill.lockedAt + 24 * 3600}
              className="w-full h-12 rounded-2xl bg-white/60 border border-white/60 hover:bg-white/80 disabled:opacity-40 font-medium"
            >
              {now < fill.lockedAt + 24 * 3600
                ? `Reclaim escrow available in ${Math.ceil((fill.lockedAt + 24 * 3600 - now) / 60)} min`
                : "Reclaim unconfirmed escrow"}
            </button>
          )}
        </div>
      )}

      {/* Phase 7: Voided */}
      {fill.state === FILL_STATE.Voided && (
        <div
          data-testid="offramp-fill-voided"
          className="rounded-2xl border border-slate-300 bg-slate-100 p-5 text-sm text-slate-700"
        >
          Voided. The maker's escrow was empty or short, so no fiat is due. Anything that moved
          went back to the maker and the offer is open again.
        </div>
      )}

      {/* Phase 0 — Locked, taker should pay off-chain + submit Reclaim proof */}
      {fill.state === 0 && (isTaker || isMaker) && (
        <div
          data-testid="offramp-escrow-check"
          className="rounded-2xl border border-white/60 bg-white/60 p-5 mb-4 text-sm"
        >
          <div className="font-medium mb-1">Escrowed USDC</div>
          {isTaker && (
            <p className="text-[var(--text-secondary)] mb-3">
              The vault moves 0 if the maker is short. Decrypt the escrow and check it before you
              send any fiat.
            </p>
          )}
          {escrowed !== null ? (
            <div data-testid="offramp-escrow-amount" className="text-xl font-semibold tabular-nums">
              {formatUnits(escrowed, USDC_DECIMALS)} USDC
            </div>
          ) : (
            <button
              data-testid="offramp-escrow-decrypt"
              onClick={checkEscrow}
              disabled={decrypting}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
            >
              {decrypting && <Loader2 size={16} className="animate-spin" />}
              {decrypting ? "Decrypting…" : "Decrypt escrowed amount"}
            </button>
          )}
          {escrowError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-rose-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{escrowError}</span>
            </div>
          )}
          {isTaker && escrowed === 0n && (
            <div
              data-testid="offramp-escrow-empty"
              className="mt-3 flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 text-rose-700"
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                Nothing was escrowed. Do not send fiat. The maker can reclaim this lock after the
                proof window, which frees your lock slot.
              </span>
            </div>
          )}
          {isTaker && escrowed !== null && escrowed > 0n && (
            <label className="mt-3 flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid="offramp-escrow-confirm"
                checked={escrowConfirmed}
                onChange={(e) => setEscrowConfirmed(e.target.checked)}
                className="mt-1"
              />
              <span>
                {formatUnits(escrowed, USDC_DECIMALS)} USDC for ${fiatUsd} is what I agreed to. I
                will now pay the maker on {rail?.label ?? "their rail"}.
              </span>
            </label>
          )}
        </div>
      )}

      {fill.state === 0 && isTaker && escrowConfirmed && escrowed !== null && escrowed > 0n && hook.deploy.address && (
        <ReclaimWidget
          chainId={activeChainId}
          offramp={hook.deploy.address}
          fillId={fill.fillId}
          amountMicroUSD={fill.fiatAmountAtLockMicroUSD}
          providerId={offer.fiatRail as RailId}
          onProof={submitProof}
        />
      )}

      {/* Phase 0 — Locked, maker waiting for taker. Can expire after 24h. */}
      {fill.state === 0 && isMaker && (
        <div className="space-y-3">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5 text-sm text-blue-700">
            <Clock size={16} className="inline mr-1" />
            Waiting for taker to pay you on {rail?.label} and submit the Reclaim proof.
            If they don't submit within 24 hours of lock, you can reclaim the escrow.
          </div>
          <button
            data-testid="offramp-fill-expire"
            onClick={expire}
            disabled={now < fill.lockedAt + 24 * 3600}
            className="w-full h-12 rounded-2xl bg-white/60 border border-white/60 hover:bg-white/80 disabled:opacity-40 font-medium"
          >
            {now < fill.lockedAt + 24 * 3600
              ? `Refund available in ${Math.ceil((fill.lockedAt + 24 * 3600 - now) / 60)} min`
              : "Refund escrow now"}
          </button>
        </div>
      )}

      {/* Phase 1 — ProofSubmitted, challenge window open */}
      {fill.state === 1 && (
        <div className="space-y-3">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5 text-sm text-blue-700">
            <Clock size={16} className="inline mr-1" />
            Challenge window:{" "}
            {secondsUntilRelease > 0
              ? `${Math.ceil(secondsUntilRelease / 60)} min remaining`
              : "closed. Anyone can release now."}
            .
            {isMaker && " If the taker's proof is bad, dispute now before the window closes."}
          </div>
          {isMaker && secondsUntilRelease > 0 && (
            <button
              data-testid="offramp-fill-dispute"
              onClick={dispute}
              className="w-full h-12 rounded-2xl bg-rose-600 text-white font-medium hover:bg-rose-700"
            >
              Dispute fill
            </button>
          )}
          <button
            data-testid="offramp-fill-release"
            onClick={release}
            disabled={secondsUntilRelease > 0}
            className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
          >
            {secondsUntilRelease > 0
              ? `Release in ${Math.ceil(secondsUntilRelease / 60)} min`
              : "Release encrypted USDC to taker"}
          </button>
        </div>
      )}

      {/* Phase 2 — Released */}
      {fill.state === 2 && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-sm text-emerald-700 flex items-start gap-3">
          <CheckCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            Released. The escrowed USDC was paid to the taker against the ${fiatUsd} fiat
            payment.
          </div>
        </div>
      )}

      {/* Phase 3 — Disputed */}
      {fill.state === 3 && (
        <div className="space-y-3">
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-700">
            Dispute open. The arbiter rules based on the Reclaim proof and any evidence both
            parties provide.
            {disputedAt === 0
              ? " This dispute predates the timeout rule, so only the arbiter can resolve it."
              : now < disputedAt + disputeTimeout
                ? ` If the arbiter has not ruled in ${Math.ceil((disputedAt + disputeTimeout - now) / 3600)} h, anyone can release the escrow to the taker.`
                : " The arbiter window has closed. Anyone can release the escrow to the taker."}
          </div>
          {disputedAt !== 0 && now >= disputedAt + disputeTimeout && (
            <button
              data-testid="offramp-fill-resolve-stale"
              onClick={resolveStale}
              disabled={hook.state.isProcessing}
              className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
            >
              Release to taker (arbiter timed out)
            </button>
          )}
        </div>
      )}

      {/* Phase 4 — Resolved */}
      {fill.state === 4 && (
        <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-5 text-sm text-blue-700">
          This dispute is resolved, by the arbiter or by the timeout release. Check your
          wallet for the final balance change.
        </div>
      )}

      {/* Phase 5 — Refunded */}
      {fill.state === 5 && (
        <div className="rounded-2xl border border-slate-300 bg-slate-100 p-5 text-sm text-slate-700">
          Refunded. The encrypted USDC was returned to the maker (proof window expired
          without taker action, or arbiter ruled for maker).
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
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

function NotDeployedBanner() {
  return (
    <div
      data-testid="offramp-fill-not-deployed"
      className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3"
    >
      <AlertOctagon size={18} className="text-amber-600 shrink-0 mt-0.5" />
      <div className="text-sm">
        <div className="font-medium text-amber-700">Coming soon on this chain</div>
        <div className="text-[var(--text-primary)]/70 mt-0.5">
          Fill flow unavailable until P2POfframp contracts are deployed here.
        </div>
      </div>
    </div>
  );
}
