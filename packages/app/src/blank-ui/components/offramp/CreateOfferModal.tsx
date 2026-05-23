import { useState } from "react";
import { X } from "lucide-react";
import toast from "react-hot-toast";

import { ALL_RAILS, type RailId, railById } from "@/lib/reclaim-providers";
import type { useP2POfframp } from "@/hooks/useP2POfframp";
import { useChain } from "@/providers/ChainProvider";

interface CreateOfferModalProps {
  onClose: () => void;
  onCreated: (offerId: bigint) => void;
  hook: ReturnType<typeof useP2POfframp>;
}

const USDC_DECIMALS = 6;

export function CreateOfferModal({ onClose, onCreated, hook }: CreateOfferModalProps) {
  const { contracts } = useChain();
  const [usdc, setUsdc] = useState("");
  const [fiat, setFiat] = useState("");
  const [rate, setRate] = useState("");
  const [rail, setRail] = useState<RailId>(ALL_RAILS[0].id);
  const [handle, setHandle] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [submitting, setSubmitting] = useState(false);

  const railDef = railById(rail);

  const submit = async () => {
    if (!usdc || !fiat || !rate || !handle) {
      toast.error("Fill every field.");
      return;
    }
    if (railDef && !railDef.handlePattern.test(handle)) {
      toast.error(`Handle doesn't match expected ${railDef.label} format.`);
      return;
    }
    if (hook.deploy.status !== "live") {
      toast.error("Offramp not deployed on this chain yet.");
      return;
    }
    const fiatNum = Number.parseFloat(fiat);
    const rateNum = Number.parseFloat(rate);
    if (!Number.isFinite(fiatNum) || fiatNum <= 0) {
      toast.error("Fiat amount must be > 0.");
      return;
    }
    if (!Number.isFinite(rateNum) || rateNum <= 0) {
      toast.error("Rate must be > 0.");
      return;
    }
    const expiryS = Math.max(300, Math.min(7 * 24 * 3600, Number.parseInt(expiryHours, 10) * 3600));

    setSubmitting(true);
    try {
      const out = await hook.createOffer({
        vault: contracts.FHERC20Vault_USDC,
        usdcAmountTokens: usdc,
        decimals: USDC_DECIMALS,
        minFillUsdcTokens: usdc,
        fiatRail: rail,
        makerHandle: handle.trim(),
        fiatAmountMicroUSD: BigInt(Math.round(fiatNum * 1_000_000)),
        fiatRateMicroUSD: BigInt(Math.round(rateNum * 1_000_000)),
        expirySeconds: expiryS,
      });
      if (out?.offerId !== undefined) {
        toast.success(`Offer #${out.offerId.toString()} created.`);
        onCreated(out.offerId);
        onClose();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="offramp-create-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="glass-card-static rounded-[2rem] p-8 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Create encrypted offer</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-xl hover:bg-black/5"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-[var(--text-secondary)] mb-1 block">Fiat rail</label>
            <select
              value={rail}
              onChange={(e) => setRail(Number(e.target.value) as RailId)}
              className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5"
            >
              {ALL_RAILS.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-[var(--text-secondary)] mb-1 block">
              Your {railDef?.label ?? "rail"} handle (kept off-chain as a digest)
            </label>
            <input
              data-testid="offramp-create-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={railDef?.handlePlaceholder ?? "your-handle"}
              className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5 font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--text-secondary)] mb-1 block">USDC amount (encrypted)</label>
              <input
                data-testid="offramp-create-usdc"
                type="number"
                step="0.01"
                value={usdc}
                onChange={(e) => setUsdc(e.target.value)}
                placeholder="50"
                className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Total fiat (USD-equiv)</label>
              <input
                data-testid="offramp-create-fiat"
                type="number"
                step="0.01"
                value={fiat}
                onChange={(e) => setFiat(e.target.value)}
                placeholder="50.00"
                className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Rate (USD/USDC)</label>
              <input
                data-testid="offramp-create-rate"
                type="number"
                step="0.0001"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="1.0000"
                className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Expires in (hours)</label>
              <input
                type="number"
                min={1}
                max={168}
                value={expiryHours}
                onChange={(e) => setExpiryHours(e.target.value)}
                className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5"
              />
            </div>
          </div>

          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3 text-xs text-amber-700">
            Heads up: the fiat price + rail are public so takers can find this offer.
            Only the USDC amount stays encrypted on-chain. The maker-handle hash is
            verified at proof time so the taker pays the right account.
          </div>

          <button
            data-testid="offramp-create-submit"
            disabled={submitting}
            onClick={submit}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-50"
          >
            {submitting ? "Creating offer…" : "Create encrypted offer"}
          </button>
        </div>
      </div>
    </div>
  );
}
