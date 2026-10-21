// Wave 4 task #254 — Storefront public buyer page (/shop/:chainId/:listingId).
//
// Loads the listing on-chain, renders the right UI for the listing's mode.
// Public; the buyer creates a passkey via the existing onboarding modal
// when they need to pay/bid.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import {
  Tag,
  Gavel,
  HandCoins,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Clock,
  ShoppingBag,
  Copy,
  ExternalLink,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useStorefront, SALE_MODE, type SaleMode } from "@/hooks/useStorefront";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { CONTRACTS_BY_CHAIN, type SupportedChainId } from "@/lib/constants";
import { StorefrontAbi } from "@/lib/abis";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";
import { cn } from "@/lib/cn";
import { classifyLoadError, type ClassifiedLoadError } from "@/lib/load-error";

interface OnChainListing {
  seller: `0x${string}`;
  vault: `0x${string}`;
  mode: SaleMode;
  closesAt: bigint;
  winner: `0x${string}`;
  active: boolean;
  closed: boolean;
  title: string;
  descriptionCidHash: `0x${string}`;
  deliveryChannel: string;
  createdAt: bigint;
}

const MODE_META: Record<SaleMode, { label: string; icon: LucideIcon; tone: string }> = {
  [SALE_MODE.FixedPrice]: { label: "Fixed price", icon: Tag, tone: "bg-blue-50 text-blue-600" },
  [SALE_MODE.Auction]: { label: "Sealed-bid auction", icon: Gavel, tone: "bg-purple-50 text-purple-600" },
  [SALE_MODE.PayWhatYouWant]: { label: "Pay what you want", icon: HandCoins, tone: "bg-emerald-50 text-emerald-600" },
};

export default function StorefrontPage() {
  const params = useParams<{ chainId: string; listingId: string }>();
  const chainId = params.chainId ? Number(params.chainId) : NaN;
  const listingId = params.listingId ? Number(params.listingId) : NaN;
  const publicClient = usePublicClient({ chainId });
  const {
    state,
    txExplorerUrl,
    pipeline,
    buyFixed,
    placeBid,
    payPWYW,
    closeAuction,
    claimAuctionWin,
    revealWinner,
    refundLoserBid,
    decryptPaidByBuyer,
    pendingPurchases,
    finishPendingPurchases,
    fheReady,
  } = useStorefront();
  // Passkey-aware: the connected smart-account address. Used to gate
  // the Claim button so non-winners don't pay gas just to revert. Falls
  // back to undefined for unconnected viewers; we then show a generic
  // "Connect your wallet to claim" rather than the Claim CTA.
  const { effectiveAddress } = useEffectiveAddress();

  const [onChain, setOnChain] = useState<OnChainListing | null>(null);
  const [bidCount, setBidCount] = useState<number>(0);
  // The auction closed with no funded bid above the minimum (Storefront.NO_WINNER).
  // Every bid is refundable and there is no sale to settle.
  const [noWinner, setNoWinner] = useState(false);
  const [finishingPending, setFinishingPending] = useState(false);
  const resumedFor = useRef<string | null>(null);
  // Indices of bids placed by the connected viewer (post-close only). Replaces
  // a window.prompt() that asked the user to type their bid index — that
  // routed wrong-index taps to a contract revert ("not your bid") AFTER 30s
  // of FHE encryption + UserOp prefund. Loading on chain makes wrong taps
  // impossible. §1.7 of WAVE4_HALF_BAKED #9.
  const [myBids, setMyBids] = useState<{ index: number; refunded: boolean }[]>([]);
  const [myBidsLoaded, setMyBidsLoaded] = useState(false);
  const [winnerSettled, setWinnerSettled] = useState(false);
  const [loadError, setLoadError] = useState<ClassifiedLoadError | null>(null);
  // Retry CTA bumps reloadKey, re-running the effect.
  const [reloadKey, setReloadKey] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const [amount, setAmount] = useState("");

  // ─── Load on-chain listing + bid count ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setOnChain(null);
    setNoWinner(false);
    if (
      !Number.isFinite(chainId) ||
      !Number.isFinite(listingId) ||
      !Number.isInteger(chainId) ||
      !Number.isInteger(listingId) ||
      chainId < 0 ||
      listingId < 0
    ) {
      // Reject 1.5, 1e21, "abc", negative ids. Otherwise BigInt(1.5)
      // throws RangeError that surfaces as a transient retry error.
      setLoadError({ kind: "permanent", headline: "Invalid URL", hint: "The chain id or listing id in the URL isn't a valid positive integer.", rawCause: "" });
      return;
    }
    if (!(chainId in CONTRACTS_BY_CHAIN)) {
      setLoadError({ kind: "permanent", headline: "Unsupported chain", hint: "Blank only supports Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia for now.", rawCause: "" });
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[chainId as SupportedChainId];
    if (!contracts.Storefront || contracts.Storefront === "0x0000000000000000000000000000000000000000") {
      setLoadError({ kind: "permanent", headline: "Storefront not deployed on this chain yet", hint: "This chain doesn't have the Storefront contract deployed.", rawCause: "" });
      return;
    }
    if (!publicClient) return;

    (async () => {
      try {
        const result = await publicClient.readContract({
          address: contracts.Storefront,
          abi: StorefrontAbi,
          functionName: "getListing",
          args: [BigInt(listingId)],
        });
        if (cancelled) return;
        const [
          seller, vault, mode, closesAt, winner, active, closed,
          title, descriptionCidHash, deliveryChannel, createdAt,
        ] = result as readonly [
          `0x${string}`, `0x${string}`, number, bigint, `0x${string}`, boolean, boolean,
          string, `0x${string}`, string, bigint,
        ];
        if (seller === "0x0000000000000000000000000000000000000000") {
          setLoadError({ kind: "permanent", headline: "Listing not found", hint: "Check the chain you're on, or the listing id in the URL.", rawCause: "" });
          return;
        }
        setOnChain({
          seller, vault, mode: mode as SaleMode, closesAt, winner, active, closed,
          title, descriptionCidHash, deliveryChannel, createdAt,
        });
        setLastLoadedAt(Date.now());

        if ((mode as SaleMode) === SALE_MODE.Auction) {
          const count = await publicClient.readContract({
            address: contracts.Storefront,
            abi: StorefrontAbi,
            functionName: "getBidCount",
            args: [BigInt(listingId)],
          });
          if (!cancelled) setBidCount(Number(count));
          if (closed) {
            try {
              const none = await publicClient.readContract({
                address: contracts.Storefront,
                abi: StorefrontAbi,
                functionName: "auctionHasNoWinner",
                args: [BigInt(listingId)],
              });
              if (!cancelled) setNoWinner(none === true);
            } catch {
              // Pre-gate Storefront: no such view, and no NO_WINNER outcome either.
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(classifyLoadError(err, { resourceName: "Listing" }));
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, listingId, publicClient, reloadKey]);

  const auctionStatus = useMemo(() => {
    if (!onChain || onChain.mode !== SALE_MODE.Auction) return null;
    const now = Math.floor(Date.now() / 1000);
    const closeTs = Number(onChain.closesAt);
    if (onChain.closed) return "closed";
    if (now < closeTs) return "open";
    return "needsClose";
  }, [onChain]);

  // Load caller's own bids for a closed auction. Walks getBidCount → getBid
  // and keeps only indices where bidder === effectiveAddress. Cheap on Base
  // Sepolia (paginated via wagmi multicall under the hood). Refunded bids
  // stay in the list so the UI can show them disabled with a "refunded"
  // chip rather than silently dropping them.
  useEffect(() => {
    let cancelled = false;
    setMyBidsLoaded(false);
    setMyBids([]);
    setWinnerSettled(false);
    if (
      !publicClient ||
      !onChain ||
      onChain.mode !== SALE_MODE.Auction ||
      !onChain.closed ||
      !Number.isFinite(bidCount) ||
      bidCount <= 0 ||
      !(chainId in CONTRACTS_BY_CHAIN)
    ) {
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[chainId as SupportedChainId];
    if (!contracts.Storefront) return;
    (async () => {
      try {
        const me = effectiveAddress?.toLowerCase() ?? null;
        const winner = onChain.winner.toLowerCase();
        const collected: { index: number; refunded: boolean }[] = [];
        // The winner's bid is marked refunded once the win is settled.
        // Settled = every bid by the winner is marked (one bid per address
        // since the upgrade; older listings may have several).
        let winnerBids = 0;
        let winnerBidsMarked = 0;
        for (let i = 0; i < bidCount; i++) {
          const result = (await publicClient.readContract({
            address: contracts.Storefront,
            abi: StorefrontAbi,
            functionName: "getBid",
            args: [BigInt(listingId), BigInt(i)],
          })) as readonly [`0x${string}`, boolean];
          if (cancelled) return;
          const bidder = result[0].toLowerCase();
          if (me && bidder === me) collected.push({ index: i, refunded: result[1] });
          if (bidder === winner) {
            winnerBids++;
            if (result[1]) winnerBidsMarked++;
          }
        }
        if (!cancelled) {
          setMyBids(collected);
          setWinnerSettled(winnerBids > 0 && winnerBids === winnerBidsMarked);
          setMyBidsLoaded(true);
        }
      } catch {
        if (!cancelled) setMyBidsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, onChain, effectiveAddress, bidCount, chainId, listingId, reloadKey]);

  // A payment left Pending (tab closed, slow Threshold Network) finishes on the
  // next visit, once the FHE session is up. The hook reads its own retry list and
  // returns at once when there is nothing to finish. The ref keeps it to one
  // automatic run per listing and wallet, so a payment that fails during this
  // visit is not retried in a loop; the Finish button covers a manual retry.
  const pendingHere = pendingPurchases.filter((p) => p.listingId === listingId);
  useEffect(() => {
    if (!onChain || !effectiveAddress || !fheReady) return;
    const key = `${chainId}:${listingId}:${effectiveAddress.toLowerCase()}`;
    if (resumedFor.current === key) return;
    resumedFor.current = key;
    void finishPendingPurchases(listingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChain, effectiveAddress, fheReady]);

  const handleFinishPending = async () => {
    setFinishingPending(true);
    try {
      await finishPendingPurchases(listingId);
    } finally {
      setFinishingPending(false);
    }
  };

  // ─── Error / loading screens ───────────────────────────────────

  if (loadError) {
    const isTransient = loadError.kind === "transient";
    return (
      <CenterCard>
        <IconBubble
          color={isTransient ? "bg-amber-50" : "bg-red-50"}
          icon={<AlertCircle size={32} className={isTransient ? "text-amber-600" : "text-red-600"} />}
        />
        <h1 className="text-2xl font-heading font-semibold mb-3">{loadError.headline}</h1>
        <p className="text-[var(--text-secondary)] mb-4">{loadError.hint}</p>
        {isTransient ? (
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-block px-6 h-12 leading-[3rem] rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
          >
            Retry
          </button>
        ) : (
          <a href="/" className="inline-block px-6 h-12 leading-[3rem] rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors">
            Go home
          </a>
        )}
        {loadError.rawCause && (
          <details className="mt-4 text-left text-xs text-[var(--text-tertiary)]">
            <summary className="cursor-pointer">Details</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all">{loadError.rawCause}</pre>
          </details>
        )}
      </CenterCard>
    );
  }

  if (!onChain) {
    return (
      <CenterCard>
        <Loader2 size={32} className="animate-spin text-[var(--text-secondary)] mb-4" />
        <p className="text-[var(--text-secondary)]">Loading listing…</p>
      </CenterCard>
    );
  }

  if (!onChain.active && onChain.mode !== SALE_MODE.Auction) {
    return (
      <CenterCard>
        <IconBubble color="bg-slate-100" icon={<AlertCircle size={32} className="text-slate-500" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Listing closed</h1>
        <p className="text-[var(--text-secondary)]">The seller deactivated this listing.</p>
      </CenterCard>
    );
  }

  // ─── Success state ─────────────────────────────────────────────

  if (state.step === "success") {
    const purchaseRef = [
      `Blank storefront purchase`,
      `Listing: #${listingId}`,
      `Chain: ${chainId}`,
      `Seller: ${onChain.seller}`,
      state.txHash ? `Transaction: ${state.txHash}` : null,
      `Delivery channel: ${onChain.deliveryChannel || "Seller handoff"}`,
    ].filter(Boolean).join("\n");
    const copyPurchaseRef = async () => {
      await navigator.clipboard.writeText(purchaseRef);
    };
    return (
      <CenterCard>
        <IconBubble color="bg-emerald-50" icon={<CheckCircle2 size={32} className="text-emerald-600" />} />
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium mb-4">
          Delivery pending
        </div>
        <h1 className="text-2xl font-heading font-semibold mb-3">Payment confirmed</h1>
        <p className="text-[var(--text-secondary)] mb-2">
          Your encrypted payment is on-chain. The seller now fulfills through their published delivery channel.
        </p>
        {onChain.deliveryChannel && (
          <div className="mt-4 mb-4 text-left rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] mb-1">Seller handoff</div>
            <div className="font-medium text-[var(--text-primary)] break-words">{onChain.deliveryChannel}</div>
          </div>
        )}
        <div className="mb-5 text-left rounded-2xl border border-[var(--border)] p-4 text-sm space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[var(--text-secondary)]">Listing</span>
            <span className="font-mono">#{listingId}</span>
          </div>
          {state.txHash && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[var(--text-secondary)]">Transaction</span>
              {txExplorerUrl ? (
                <a
                  href={txExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs underline inline-flex items-center gap-1"
                >
                  {state.txHash.slice(0, 8)}...{state.txHash.slice(-6)} <ExternalLink size={11} />
                </a>
              ) : (
                <span className="font-mono text-xs">{state.txHash.slice(0, 8)}...{state.txHash.slice(-6)}</span>
              )}
            </div>
          )}
        </div>
        {onChain.mode === SALE_MODE.FixedPrice && effectiveAddress && (
          <PaidCheck
            label="Check what you paid"
            run={() => decryptPaidByBuyer(listingId, effectiveAddress)}
          />
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={copyPurchaseRef}
            className="h-12 rounded-2xl border border-[var(--border)] font-medium inline-flex items-center justify-center gap-2"
          >
            <Copy size={16} /> Copy reference
          </button>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium inline-flex items-center justify-center gap-2"
          >
            <RefreshCw size={16} /> Refresh listing
          </button>
        </div>
        <a href="/app" className="inline-block mt-3 text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Open Blank
        </a>
      </CenterCard>
    );
  }

  const meta = MODE_META[onChain.mode];
  const ModeIcon = meta.icon;
  const viewerIsSeller =
    !!effectiveAddress && effectiveAddress.toLowerCase() === onChain.seller.toLowerCase();

  // ─── Per-mode buyer UI ─────────────────────────────────────────

  return (
    <CenterCard>
      <IconBubble color={meta.tone} icon={<ShoppingBag size={32} />} />
      <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] mb-2 inline-flex items-center gap-1.5">
        <ModeIcon size={12} /> {meta.label}
      </div>
      <h1 className="text-2xl font-heading font-semibold mb-3">{onChain.title}</h1>
      <p className="text-sm text-[var(--text-secondary)] mb-1">
        From <span className="font-mono">{onChain.seller.slice(0, 6)}…{onChain.seller.slice(-4)}</span>
      </p>
      <p className="text-sm text-[var(--text-secondary)] mb-6">
        Delivery: <span className="font-medium text-[var(--text-primary)]">{onChain.deliveryChannel}</span>
      </p>
      <DeliveryHandoff
        deliveryChannel={onChain.deliveryChannel}
        lastLoadedAt={lastLoadedAt}
        onRefresh={() => setReloadKey((k) => k + 1)}
      />

      {pendingHere.length > 0 && (
        <div
          data-testid="storefront-pending-payment"
          role="status"
          className="mb-6 text-left rounded-2xl border border-amber-500/30 bg-amber-50 p-4 text-sm text-amber-800"
        >
          <p className="mb-3">
            Your payment is on-chain but not confirmed yet. The seller delivers only after it is.
          </p>
          <button
            type="button"
            data-testid="storefront-finish-payment"
            onClick={handleFinishPending}
            disabled={finishingPending || state.isProcessing || !fheReady}
            className="h-10 px-4 rounded-xl bg-[#1D1D1F] text-white font-medium inline-flex items-center gap-2 disabled:opacity-40"
          >
            {(finishingPending || state.isProcessing) && <Loader2 size={14} className="animate-spin" />}
            {finishingPending || state.isProcessing ? "Checking…" : !fheReady ? "Connecting…" : "Finish now"}
          </button>
        </div>
      )}

      {/* ── FixedPrice: seller checks a buyer's payment before delivering ── */}
      {onChain.mode === SALE_MODE.FixedPrice && viewerIsSeller && (
        <SellerPaymentCheck
          check={(buyer) => decryptPaidByBuyer(listingId, buyer)}
        />
      )}

      {/* ── FixedPrice ── */}
      {onChain.mode === SALE_MODE.FixedPrice && !viewerIsSeller && (
        <BuyForm
          label="Pay (USDC)"
          placeholder="10.00"
          value={amount}
          onChange={setAmount}
          ctaLabel="Buy now"
          isProcessing={state.isProcessing}
          disabled={!amount || Number.parseFloat(amount) <= 0}
          onSubmit={() => buyFixed({
            listingId,
            vault: onChain.vault,
            offerTokens: amount,
            decimals: 6,
          })}
          hint="Your payment must equal the seller's price exactly. The chain checks via FHE; neither side reveals the number. On a mismatch or a short balance nothing moves, and you can check what you paid after."
        />
      )}

      {/* ── PWYW ── */}
      {onChain.mode === SALE_MODE.PayWhatYouWant && (
        <BuyForm
          label="Name your price (USDC)"
          placeholder="any amount"
          value={amount}
          onChange={setAmount}
          ctaLabel="Send"
          isProcessing={state.isProcessing}
          disabled={!amount || Number.parseFloat(amount) <= 0}
          onSubmit={() => payPWYW({
            listingId,
            vault: onChain.vault,
            amountTokens: amount,
            decimals: 6,
          })}
          hint="Tip jar / open-source funding mode. The seller sees their total earnings only, never individual amounts."
        />
      )}

      {/* ── Auction ── */}
      {onChain.mode === SALE_MODE.Auction && (
        <AuctionView
          onChain={onChain}
          listingId={listingId}
          bidCount={bidCount}
          status={auctionStatus!}
          isProcessing={state.isProcessing}
          amount={amount}
          setAmount={setAmount}
          viewerAddress={effectiveAddress}
          onPlaceBid={() => placeBid({ listingId, vault: onChain.vault, bidTokens: amount, decimals: 6 })}
          onClose={() => closeAuction(listingId)}
          onClaim={async () => { if (await claimAuctionWin(listingId)) setReloadKey((k) => k + 1); }}
          onReveal={async () => { if (await revealWinner(listingId)) setReloadKey((k) => k + 1); }}
          onRefund={async (idx) => { if (await refundLoserBid(listingId, idx)) setReloadKey((k) => k + 1); }}
          myBids={myBids}
          myBidsLoaded={myBidsLoaded}
          winnerSettled={winnerSettled}
          noWinner={noWinner}
        />
      )}

      {pipeline.phase !== "idle" && (
        <div className="mt-4 text-left">
          <FhePipelineProgress state={pipeline} compact />
        </div>
      )}
      {state.error && (
        <div className="mt-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 text-sm text-left">
          {state.error}
        </div>
      )}
    </CenterCard>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function PaidCheck(props: { label: string; run: () => Promise<bigint> }) {
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      setPaid(await props.run());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 text-left rounded-2xl border border-[var(--border)] p-4 text-sm" data-testid="storefront-paid-check">
      {paid !== null ? (
        <div className={cn("font-medium", paid === 0n ? "text-red-700" : "text-[var(--text-primary)]")}>
          {paid === 0n
            ? "Nothing was paid. The amount did not match the price, or the balance was short."
            : `Paid in total: ${formatUnits(paid, 6)} USDC`}
        </div>
      ) : (
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className="h-10 px-4 rounded-xl border border-[var(--border)] font-medium inline-flex items-center gap-2 disabled:opacity-40"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? "Decrypting…" : props.label}
        </button>
      )}
      {err && <div className="mt-2 text-red-700">{err}</div>}
    </div>
  );
}

function SellerPaymentCheck(props: { check: (buyer: `0x${string}`) => Promise<bigint> }) {
  const [buyer, setBuyer] = useState("");
  const valid = /^0x[0-9a-fA-F]{40}$/.test(buyer.trim());
  return (
    <div className="text-left mb-6" data-testid="storefront-seller-check">
      <label className="block text-sm font-medium mb-2">Verify a buyer's payment</label>
      <p className="text-xs text-[var(--text-secondary)] mb-2">
        Paste the buyer's address and decrypt the total they paid on this listing. Deliver only
        if it covers your price.
      </p>
      <input
        type="text"
        value={buyer}
        onChange={(e) => setBuyer(e.target.value)}
        placeholder="0x…"
        className="w-full h-12 rounded-xl border border-[var(--border)] bg-transparent px-3 font-mono text-sm focus:border-[var(--border-strong)] focus:outline-none mb-3"
      />
      {valid ? (
        <PaidCheck key={buyer.trim().toLowerCase()} label="Decrypt payment" run={() => props.check(buyer.trim() as `0x${string}`)} />
      ) : (
        <p className="text-xs text-[var(--text-secondary)] mb-5">Enter a full 0x address.</p>
      )}
    </div>
  );
}

function BuyForm(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  ctaLabel: string;
  isProcessing: boolean;
  disabled: boolean;
  onSubmit: () => void;
  hint?: string;
}) {
  return (
    <div className="text-left">
      <label className="block text-sm font-medium mb-2">{props.label}</label>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder={props.placeholder}
        className="w-full h-12 rounded-xl border border-[var(--border)] bg-transparent px-3 focus:border-[var(--border-strong)] focus:outline-none"
      />
      <button
        onClick={props.onSubmit}
        disabled={props.isProcessing || props.disabled}
        className="mt-4 w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {props.isProcessing ? "Processing…" : props.ctaLabel}
      </button>
      {props.hint && (
        <p className="text-xs text-[var(--text-secondary)] mt-3">{props.hint}</p>
      )}
    </div>
  );
}

function AuctionView(props: {
  onChain: OnChainListing;
  listingId: number;
  bidCount: number;
  status: "open" | "closed" | "needsClose";
  isProcessing: boolean;
  amount: string;
  setAmount: (v: string) => void;
  viewerAddress: `0x${string}` | undefined;
  onPlaceBid: () => void;
  onClose: () => void;
  onClaim: () => void;
  onReveal: () => void;
  onRefund: (idx: number) => void;
  myBids: { index: number; refunded: boolean }[];
  myBidsLoaded: boolean;
  winnerSettled: boolean;
  noWinner: boolean;
}) {
  const closeTs = Number(props.onChain.closesAt);
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, closeTs - now);
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);

  if (props.status === "open") {
    return (
      <div className="text-left">
        <div className="flex items-center gap-2 mb-4 text-sm text-[var(--text-secondary)]">
          <Clock size={14} />
          <span>
            {days > 0 ? `${days}d ` : ""}{hours}h {minutes}m left · {props.bidCount} bid{props.bidCount === 1 ? "" : "s"} so far
          </span>
        </div>
        <BuyForm
          label="Your bid (USDC)"
          placeholder="enter your max"
          value={props.amount}
          onChange={props.setAmount}
          ctaLabel="Place bid"
          isProcessing={props.isProcessing}
          disabled={!props.amount || Number.parseFloat(props.amount) <= 0}
          onSubmit={props.onPlaceBid}
          hint="Bids are encrypted. One bid per address, so bid your max. Highest bid wins at close, decided by the Fhenix Threshold Network."
        />
      </div>
    );
  }
  if (props.status === "needsClose") {
    return (
      <div className="text-left">
        <div className="flex items-center gap-2 mb-4 text-sm text-[var(--text-secondary)]">
          <Clock size={14} />
          <span>Auction ended · {props.bidCount} total bid{props.bidCount === 1 ? "" : "s"}. Anyone can finalize.</span>
        </div>
        <button
          onClick={props.onClose}
          disabled={props.isProcessing}
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
        >
          {props.isProcessing ? "Closing…" : "Close auction"}
        </button>
      </div>
    );
  }
  // status === "closed". closeAuction requires at least one bid, so a
  // closed auction always has bids. A zero winner means the encrypted
  // winner index is not revealed yet.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const revealed = props.onChain.winner.toLowerCase() !== ZERO_ADDR;

  if (!revealed && !props.noWinner) {
    return (
      <div className="text-left" data-testid="auction-reveal">
        <div className="px-4 py-3 rounded-xl bg-blue-50 text-blue-700 mb-4 text-sm">
          Auction closed with {props.bidCount} bid{props.bidCount === 1 ? "" : "s"}. The winner is
          still encrypted. Anyone can reveal it. Refunds and settlement open after the reveal.
        </div>
        <button
          data-testid="auction-reveal-winner"
          onClick={props.onReveal}
          disabled={props.isProcessing || !props.viewerAddress}
          className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
        >
          {!props.viewerAddress ? "Connect your wallet to reveal" : props.isProcessing ? "Revealing…" : "Reveal winner"}
        </button>
      </div>
    );
  }

  const viewerIsWinner =
    !props.noWinner &&
    !!props.viewerAddress &&
    props.viewerAddress.toLowerCase() === props.onChain.winner.toLowerCase();
  const refundable = viewerIsWinner ? [] : props.myBids;

  return (
    <div className="text-left">
      {props.noWinner ? (
        <div data-testid="auction-no-winner" className="px-4 py-3 rounded-xl bg-amber-50 text-amber-800 mb-4 text-sm">
          No winning bid: all bids refundable. No bid was funded and at or above the minimum, so
          nobody won and the seller is not paid.
        </div>
      ) : (
        <div className="px-4 py-3 rounded-xl bg-emerald-50 text-emerald-700 mb-4 text-sm">
          Winner: <span className="font-mono">{props.onChain.winner.slice(0, 6)}…{props.onChain.winner.slice(-4)}</span>
          {viewerIsWinner && <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-900 text-xs font-medium">You</span>}
        </div>
      )}
      <div className="space-y-2">
        {!props.myBidsLoaded ? (
          <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
            <Loader2 size={14} className="animate-spin mr-2" /> Checking bids…
          </div>
        ) : props.noWinner ? null : props.winnerSettled ? (
          <div data-testid="auction-settled" className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
            Settled. The winning bid was paid to the seller.
          </div>
        ) : !props.viewerAddress ? (
          <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
            Connect your wallet to settle or refund
          </div>
        ) : (
          // Anyone can settle, so the seller is paid even if the winner
          // walks away. Only the winner's delivery note is recorded.
          <button
            data-testid="auction-settle"
            onClick={props.onClaim}
            disabled={props.isProcessing}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
          >
            {props.isProcessing ? "Settling…" : viewerIsWinner ? "Claim your win" : "Settle auction (pay the seller)"}
          </button>
        )}
        {props.noWinner && !props.viewerAddress ? (
          <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
            Connect your wallet to refund your bid
          </div>
        ) : null}
        {!props.viewerAddress || !props.myBidsLoaded ? null : props.myBids.length === 0 ? (
          <div className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
            You didn't bid on this auction.
          </div>
        ) : refundable.length === 0 ? null : (
          <div className="space-y-2" data-testid="my-bids-list">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Your bid</div>
            {refundable.map((b) => (
              <button
                key={b.index}
                onClick={() => props.onRefund(b.index)}
                disabled={props.isProcessing || b.refunded}
                className="w-full h-12 px-4 rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40 flex items-center justify-between text-sm"
              >
                <span>Bid #{b.index}</span>
                <span className={cn("text-xs", b.refunded ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)] font-medium")}>
                  {b.refunded ? "Refunded" : props.isProcessing ? "Refunding…" : "Refund"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeliveryHandoff(props: {
  deliveryChannel: string;
  lastLoadedAt: number | null;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-6 text-left rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] mb-1">Seller-handled delivery</div>
          <p className="text-sm text-[var(--text-secondary)]">
            Pay on-chain here. The seller fulfills through the channel below.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onRefresh}
          className="h-8 px-2 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-white/60"
          aria-label="Refresh listing state"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="mt-3 rounded-xl bg-white/60 dark:bg-white/[0.04] px-3 py-2 text-sm font-medium break-words">
        {props.deliveryChannel || "Seller will contact you after payment."}
      </div>
      {props.lastLoadedAt && (
        <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">
          On-chain listing state checked {new Date(props.lastLoadedAt).toLocaleTimeString()}.
        </p>
      )}
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="glass-card-static rounded-[2rem] p-10 max-w-md w-full text-center">
        {children}
      </div>
    </div>
  );
}

function IconBubble({ color, icon }: { color: string; icon: React.ReactNode }) {
  return (
    <div className={cn("w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6", color)}>
      {icon}
    </div>
  );
}
