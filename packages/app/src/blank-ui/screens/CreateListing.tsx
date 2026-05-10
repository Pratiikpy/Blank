// Wave 4 task #254 — Storefront create-listing screen.
//
// One-product page setup. Pick mode (Fixed / Auction / Pay-what-you-want),
// fill the form, get a shareable /shop/:chain/:id URL.

import { useState, useMemo } from "react";
import { Tag, Gavel, HandCoins, Copy, Check, AlertCircle, ShoppingBag } from "lucide-react";
import toast from "react-hot-toast";
import { keccak256, stringToBytes } from "viem";

import { useStorefront, SALE_MODE, type SaleMode } from "@/hooks/useStorefront";
import { useChain } from "@/providers/ChainProvider";
import { cn } from "@/lib/cn";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";

const AUCTION_DURATIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 86_400 },
  { label: "3 days", seconds: 3 * 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
];

export default function CreateListing() {
  const { contracts, activeChainId } = useChain();
  const { state, pipeline, createListing, reset } = useStorefront();

  const [mode, setMode] = useState<SaleMode>(SALE_MODE.FixedPrice);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceTokens, setPriceTokens] = useState("");
  const [auctionSeconds, setAuctionSeconds] = useState(AUCTION_DURATIONS[1].seconds);
  const [deliveryChannel, setDeliveryChannel] = useState("");

  const validation = useMemo(() => {
    if (title.trim().length === 0) return "Give your listing a title";
    if (title.length > 200) return "Title is too long (max 200 chars)";
    if (mode !== SALE_MODE.PayWhatYouWant) {
      if (!priceTokens || Number.parseFloat(priceTokens) <= 0) {
        return mode === SALE_MODE.Auction ? "Set a minimum bid (or 0 for any)" : "Set a price above zero";
      }
    }
    if (deliveryChannel.trim().length === 0) {
      return "Tell buyers how you'll deliver (DM handle, email, etc.)";
    }
    return null;
  }, [title, mode, priceTokens, deliveryChannel]);

  const handleCreate = async () => {
    if (validation) {
      toast.error(validation);
      return;
    }
    // hash description content client-side. In a real flow you'd upload
    // to IPFS first and store the CID hash; for now we hash the text.
    const descCidHash = description.trim()
      ? keccak256(stringToBytes(description.trim()))
      : ("0x" + "00".repeat(32)) as `0x${string}`;

    await createListing({
      mode,
      vault: contracts.FHERC20Vault_USDC,
      priceTokens: priceTokens || "0",
      decimals: 6,
      auctionSeconds: mode === SALE_MODE.Auction ? auctionSeconds : 0,
      title: title.trim(),
      descriptionCidHash: descCidHash,
      deliveryChannel: deliveryChannel.trim(),
    });
  };

  const shareUrl = state.lastListingId !== null
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${activeChainId}/${state.lastListingId}`
    : null;

  const copyUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    toast.success("Link copied");
  };

  // ─── Success ─────────────────────────────────────────────────
  if (state.step === "success" && shareUrl) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="glass-card-static rounded-[2rem] p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-6">
            <Check size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Listing live</h2>
          <p className="text-[var(--text-secondary)] mb-6">
            Share this link. Buyers don't need a wallet to view — they create one when they pay.
          </p>
          <div className="bg-[var(--surface-2)] rounded-2xl p-4 mb-4 break-all text-sm font-mono text-left">
            {shareUrl}
          </div>
          <button
            onClick={copyUrl}
            className="inline-flex items-center gap-2 px-6 h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors"
          >
            <Copy size={18} /> Copy link
          </button>
          <button
            onClick={() => { reset(); setTitle(""); setPriceTokens(""); setDescription(""); setDeliveryChannel(""); }}
            className="block mt-6 mx-auto text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Create another listing
          </button>
        </div>
      </div>
    );
  }

  // ─── Form ────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto">
      <div className="glass-card-static rounded-[2rem] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-fuchsia-50 flex items-center justify-center">
            <ShoppingBag size={24} className="text-fuchsia-600" />
          </div>
          <div>
            <h1 className="text-xl font-heading font-semibold">Sell something</h1>
            <p className="text-sm text-[var(--text-secondary)]">Encrypted price. Encrypted bids. Private revenue.</p>
          </div>
        </div>

        {/* Mode pills */}
        <label className="block text-sm font-medium mb-2">How are you selling?</label>
        <div className="grid grid-cols-3 gap-2 mb-6">
          <ModePill
            active={mode === SALE_MODE.FixedPrice}
            onClick={() => setMode(SALE_MODE.FixedPrice)}
            icon={<Tag size={16} />}
            label="Fixed price"
            hint="Set & forget"
          />
          <ModePill
            active={mode === SALE_MODE.Auction}
            onClick={() => setMode(SALE_MODE.Auction)}
            icon={<Gavel size={16} />}
            label="Auction"
            hint="Sealed bids"
          />
          <ModePill
            active={mode === SALE_MODE.PayWhatYouWant}
            onClick={() => setMode(SALE_MODE.PayWhatYouWant)}
            icon={<HandCoins size={16} />}
            label="Pay what"
            hint="You want"
          />
        </div>

        <Field label="Product title" value={title} onChange={setTitle} placeholder="Hand-bound notebook (signed)" />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="What's in the box. What's the experience. Why someone wants it."
          multiline
        />

        {mode !== SALE_MODE.PayWhatYouWant && (
          <Field
            label={mode === SALE_MODE.Auction ? "Minimum bid (USDC, 0 = any)" : "Price (USDC)"}
            value={priceTokens}
            onChange={(v) => setPriceTokens(v.replace(/[^0-9.]/g, ""))}
            placeholder={mode === SALE_MODE.Auction ? "0" : "10.00"}
          />
        )}

        {mode === SALE_MODE.Auction && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Auction window</label>
            <div className="grid grid-cols-3 gap-2">
              {AUCTION_DURATIONS.map((opt) => (
                <button
                  key={opt.seconds}
                  onClick={() => setAuctionSeconds(opt.seconds)}
                  aria-pressed={auctionSeconds === opt.seconds}
                  className={cn(
                    "h-12 rounded-xl border-2 text-sm font-medium transition-all",
                    auctionSeconds === opt.seconds
                      ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
                      : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field
          label="How will you deliver?"
          value={deliveryChannel}
          onChange={setDeliveryChannel}
          placeholder="DM @yourhandle on telegram / email me / ships in 3 days"
        />
        <p className="text-xs text-[var(--text-secondary)] -mt-3 mb-4">
          Public to buyers. Free text — write whatever helps them know the next step.
        </p>

        {pipeline.phase !== "idle" && (
          <div className="mb-4">
            <FhePipelineProgress state={pipeline} />
          </div>
        )}
        {state.error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{state.error}</span>
          </div>
        )}

        {validation && !state.isProcessing && (
          <p className="text-xs text-[var(--text-secondary)] mb-2 text-center">{validation}</p>
        )}
        <button
          onClick={handleCreate}
          disabled={state.isProcessing || !!validation}
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {state.isProcessing ? "Creating…" : "Create listing"}
        </button>
      </div>
    </div>
  );
}

// ─── primitives ───────────────────────────────────────────────────

function ModePill(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "flex flex-col items-center justify-center gap-1 h-20 rounded-xl border-2 transition-all",
        props.active
          ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
          : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
      )}
    >
      <div className={props.active ? "text-white/90" : "text-[var(--text-secondary)]"}>{props.icon}</div>
      <div className="text-sm font-medium">{props.label}</div>
      {props.hint && (
        <div className={cn("text-xs", props.active ? "text-white/60" : "text-[var(--text-secondary)]")}>
          {props.hint}
        </div>
      )}
    </button>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const cls = cn(
    "w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-base",
    "focus:border-[var(--border-strong)] focus:outline-none transition-colors",
    props.multiline ? "py-3 min-h-[96px] resize-y" : "h-12",
  );
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-2">{props.label}</label>
      {props.multiline ? (
        <textarea
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          className={cls}
        />
      ) : (
        <input
          type="text"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          className={cls}
        />
      )}
    </div>
  );
}
