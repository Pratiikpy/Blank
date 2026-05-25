import { useState } from "react";
import { ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";

import { useReclaimProof } from "@/hooks/useReclaimProof";
import { railById, type RailId } from "@/lib/reclaim-providers";
import type { Hex } from "viem";

interface ReclaimWidgetProps {
  receiverHandleHash: `0x${string}`;
  amountMicroUSD: bigint;
  providerId: RailId;
  onProof: (proof: Hex, providerId: RailId) => void;
}

/**
 * Wave 5 Block 1 — Reclaim attestation widget.
 *
 * v1 routes through useReclaimProof which currently ships the
 * mock-signed-by-operator flow (suitable for testnet demos). When
 * VITE_RECLAIM_MODE=live is enabled after the Block 0.5 spike,
 * the same hook will open Reclaim Protocol's iframe widget instead.
 *
 * UI is intentionally minimal — the actual rail-specific UI (login
 * to PhonePe, screen-record the transaction, etc.) lives inside the
 * Reclaim widget. Here we just describe what the user is about to
 * do and call requestProof.
 */
export function ReclaimWidget({
  receiverHandleHash,
  amountMicroUSD,
  providerId,
  onProof,
}: ReclaimWidgetProps) {
  const reclaim = useReclaimProof();
  const [submitted, setSubmitted] = useState(false);
  const rail = railById(providerId);

  const fiatUsd = (Number(amountMicroUSD) / 1_000_000).toFixed(2);

  const start = async () => {
    try {
      const out = await reclaim.requestProof({
        receiverHandle: receiverHandleHash,
        amountMicroUSD,
        providerId,
      });
      setSubmitted(true);
      onProof(out.proof, out.providerId);
    } catch {
      // useReclaimProof surfaces error in state.
    }
  };

  return (
    <div
      data-testid="offramp-reclaim-widget"
      className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5"
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={18} className="text-blue-600" />
        <h3 className="text-base font-semibold">
          Prove your {rail?.label ?? "rail"} payment of ${fiatUsd}
        </h3>
      </div>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        After you pay the maker off-chain on their {rail?.label ?? "rail"} account,
        click below to submit settlement evidence.
        {reclaim.mode === "mock" && (
          <>
            {" "}Testnet mock mode: an operator-signed attestation is generated
            in-browser. Live Reclaim Protocol integration ships after Block 0.5.
          </>
        )}
        {reclaim.mode !== "mock" && (
          <> Live mode uses Reclaim Protocol verification.</>
        )}
      </p>

      {reclaim.state === "error" && (
        <div className="flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-500/20 p-3 mb-3 text-sm text-rose-700">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>{reclaim.error ?? "Could not generate Reclaim proof."}</span>
        </div>
      )}

      <button
        data-testid="offramp-reclaim-start"
        disabled={submitted || reclaim.state === "widget-open" || reclaim.state === "proving"}
        onClick={start}
        className="inline-flex items-center gap-2 h-12 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
      >
        {(reclaim.state === "widget-open" || reclaim.state === "proving") && (
          <Loader2 size={16} className="animate-spin" />
        )}
        {submitted
          ? "Proof generated"
          : reclaim.state === "proving"
            ? "Generating proof…"
            : reclaim.state === "widget-open"
              ? "Opening widget…"
              : "Attest payment"}
      </button>
    </div>
  );
}
