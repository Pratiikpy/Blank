// Wave 4 task #254 — Storefront public buyer page (/shop/:chainId/:listingId).
//
// Loads the listing on-chain, renders the right UI for the listing's mode.
// Public; the buyer creates a passkey via the existing onboarding modal
// when they need to pay/bid.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicClient } from "wagmi";
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
    refundLoserBid,
  } = useStorefront();
  // Passkey-aware: the connected smart-account address. Used to gate
  // the Claim button so non-winners don't pay gas just to revert. Falls
  // back to undefined for unconnected viewers; we then show a generic
  // "Connect your wallet to claim" rather than the Claim CTA.
  const { effectiveAddress } = useEffectiveAddress();

  const [onChain, setOnChain] = useState<OnChainListing | null>(null);
  const [bidCount, setBidCount] = useState<number>(0);
  // Indices of bids placed by the connected viewer (post-close only). Replaces
  // a window.prompt() that asked the user to type their bid index — that
  // routed wrong-index taps to a contract revert ("not your bid") AFTER 30s
  // of FHE encryption + UserOp prefund. Loading on chain makes wrong taps
  // impossible. §1.7 of WAVE4_HALF_BAKED #9.
  const [myBids, setMyBids] = useState<{ index: number; refunded: boolean }[]>([]);
  const [myBidsLoaded, setMyBidsLoaded] = useState(false);
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
    if (
      !publicClient ||
      !onChain ||
      onChain.mode !== SALE_MODE.Auction ||
      !onChain.closed ||
      !effectiveAddress ||
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
        const me = effectiveAddress.toLowerCase();
        const collected: { index: number; refunded: boolean }[] = [];
        for (let i = 0; i < bidCount; i++) {
          const result = (await publicClient.readContract({
            address: contracts.Storefront,
            abi: StorefrontAbi,
            functionName: "getBid",
            args: [BigInt(listingId), BigInt(i)],
          })) as readonly [`0x${string}`, boolean];
          if (cancelled) return;
          if (result[0].toLowerCase() === me) {
            collected.push({ index: i, refunded: result[1] });
          }
        }
        if (!cancelled) {
          setMyBids(collected);
          setMyBidsLoaded(true);
        }
      } catch {
        if (!cancelled) setMyBidsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, onChain, effectiveAddress, bidCount, chainId, listingId, reloadKey]);

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

      {/* ── FixedPrice ── */}
      {onChain.mode === SALE_MODE.FixedPrice && (
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
          hint="Your payment must equal the seller's price exactly. The chain checks via FHE; neither side reveals the number."
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
          onClaim={() => claimAuctionWin(listingId)}
          onRefund={(idx) => refundLoserBid(listingId, idx)}
          myBids={myBids}
          myBidsLoaded={myBidsLoaded}
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
  onRefund: (idx: number) => void;
  myBids: { index: number; refunded: boolean }[];
  myBidsLoaded: boolean;
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
          hint="Bids are encrypted end-to-end. Highest bid wins at close, decided by the Fhenix Threshold Network."
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
  // status === "closed"
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const noBids = props.onChain.winner.toLowerCase() === ZERO_ADDR;
  const viewerIsWinner =
    !!props.viewerAddress &&
    !noBids &&
    props.viewerAddress.toLowerCase() === props.onChain.winner.toLowerCase();

  if (noBids) {
    // C11: closing an auction with zero bids was previously rendering a
    // "Winner: 0x000…0000" banner + Claim button that always reverted.
    // Branch out explicitly so the dead-end state is honest.
    return (
      <div className="text-left">
        <div className="px-4 py-3 rounded-xl bg-slate-100 text-slate-700 mb-4 text-sm">
          Auction closed without bids. Nothing to claim or refund.
        </div>
      </div>
    );
  }

  return (
    <div className="text-left">
      <div className="px-4 py-3 rounded-xl bg-emerald-50 text-emerald-700 mb-4 text-sm">
        Winner: <span className="font-mono">{props.onChain.winner.slice(0, 6)}…{props.onChain.winner.slice(-4)}</span>
        {viewerIsWinner && <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-900 text-xs font-medium">You</span>}
      </div>
      <div className="space-y-2">
        {viewerIsWinner ? (
          // C6: only the actual winner sees the Claim CTA. Without this
          // gate, non-winners clicked Claim, ate gas, and got an opaque
          // contract revert. The button is disabled (not hidden) when
          // the viewer is connected but isn't the winner, so they know
          // the action exists but isn't theirs.
          <button
            onClick={props.onClaim}
            disabled={props.isProcessing}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
          >
            {props.isProcessing ? "Claiming…" : "Claim your win"}
          </button>
        ) : !props.viewerAddress ? (
          <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
            Connect your wallet to claim or refund
          </div>
        ) : (
          <div className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
            You aren't the winner. If you bid, you can refund below.
          </div>
        )}
        {!props.viewerAddress ? null : !props.myBidsLoaded ? (
          <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
            <Loader2 size={14} className="animate-spin mr-2" /> Checking your bids…
          </div>
        ) : props.myBids.length === 0 ? (
          <div className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
            You didn't bid on this auction.
          </div>
        ) : (
          <div className="space-y-2" data-testid="my-bids-list">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              {viewerIsWinner ? "Your other bids" : "Your bids"}
            </div>
            {props.myBids.map((b) => (
              <button
                key={b.index}
                onClick={() => props.onRefund(b.index)}
                disabled={props.isProcessing || b.refunded || (viewerIsWinner && b.index === props.myBids[props.myBids.length - 1]?.index)}
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
