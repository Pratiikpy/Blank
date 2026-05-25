import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import {
  resolvePayTarget,
  type PayResolveResult,
} from "@/lib/pay-resolver";
import { truncateAddress } from "@/lib/address";
import { AddressLabel } from "@/blank-ui/components";
import { canonicalPublicHref } from "./publicLinks";
import { lookupName } from "@/lib/address-resolver";
import "./landing.css";

// ───────────────────────────────────────────────────────────────────
//  PayPage — public route /pay/:identifier
//
//  Identifier may be a 0x address, an ENS / Basenames name, or an
//  invoice ID (`INV-42`). Optional query params:
//
//    ?amount=<usdc-units>   — pre-fill the amount on the Send screen
//    ?note=<text>           — pre-fill the memo
//    ?chain=<chainId>       — auto-switch chain when the user lands
//                             (e.g. invoices created on Base Sepolia)
//
//  Two CTAs: "Pay with Blank" (passkey path) and "Pay with Wallet"
//  (MetaMask / WalletConnect path). Both end up in /app/send/amount
//  with the recipient + amount pre-filled. Auth gating is handled by
//  BlankApp itself, so unauthenticated visitors get onboarding.
// ───────────────────────────────────────────────────────────────────

export default function PayPage() {
  const { identifier: rawIdentifier } = useParams<{ identifier: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const amount = searchParams.get("amount") ?? "";
  const note = searchParams.get("note") ?? "";
  const chain = searchParams.get("chain") ?? "";

  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; result: Extract<PayResolveResult, { ok: true }>; reverseName?: string | null }
    | { phase: "error"; result: Extract<PayResolveResult, { ok: false }> }
  >({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!rawIdentifier) {
      setState({
        phase: "error",
        result: { ok: false, error: { kind: "invalid", identifier: "" } },
      });
      return;
    }
    (async () => {
      const result = await resolvePayTarget(rawIdentifier);
      if (cancelled) return;
      if (!result.ok) {
        setState({ phase: "error", result });
        return;
      }
      // For plain addresses, attempt a reverse lookup so we can show
      // `pratik.eth` instead of `0x123…` when the recipient has set a
      // primary ENS name. Failures here are silent — the address still
      // displays.
      let reverseName: string | null | undefined;
      if (result.target.kind === "address") {
        reverseName = await lookupName(result.target.address);
        if (cancelled) return;
      }
      setState({ phase: "ready", result, reverseName });
    })();
    return () => {
      cancelled = true;
    };
  }, [rawIdentifier]);

  const goToSend = (path: "send" | "send-with-wallet") => {
    if (state.phase !== "ready") return;
    const target = state.result.target;
    const params = new URLSearchParams();
    params.set("to", target.address);
    if (amount) params.set("amount", amount);
    if (note) params.set("note", note);
    else if (target.kind === "invoice" && target.invoice.description) {
      params.set("note", `Invoice #${target.invoice.invoice_id}: ${target.invoice.description}`);
    }
    if (chain) params.set("chain", chain);
    if (path === "send-with-wallet") params.set("wallet", "external");
    navigate(`/app/send/amount?${params.toString()}`);
  };

  const displayName = useMemo(() => {
    if (state.phase !== "ready") return null;
    const target = state.result.target;
    if (target.kind === "name") return target.ensName;
    if (target.kind === "invoice" && target.ensName) return target.ensName;
    if (state.reverseName) return state.reverseName;
    return null;
  }, [state]);

  const recipientAddress =
    state.phase === "ready" ? state.result.target.address : null;

  return (
    <div className="landing-page min-h-dvh flex flex-col" style={{ background: "#F9FAFB" }}>
      <LandingNav />

      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          {state.phase === "loading" && (
            <div className="rounded-3xl bg-white border border-black/5 shadow-sm p-10 text-center">
              <Loader2 className="w-8 h-8 mx-auto text-emerald-500 animate-spin mb-4" />
              <p className="text-[var(--text-secondary)]">Resolving payment link…</p>
            </div>
          )}

          {state.phase === "error" && (
            <div className="rounded-3xl bg-white border border-black/5 shadow-sm p-10 text-center">
              <XCircle className="w-10 h-10 mx-auto text-rose-500 mb-4" />
              <h1 className="text-2xl font-medium text-[var(--text-primary)] mb-2">
                Couldn't resolve this link
              </h1>
              <p className="text-sm text-[var(--text-secondary)] mb-6">
                {payErrorMessage(state.result.error)}
              </p>
              <a
                href={canonicalPublicHref("/")}
                className="inline-flex items-center gap-2 text-emerald-600 hover:underline font-medium"
              >
                Back to Blank
              </a>
            </div>
          )}

          {state.phase === "ready" && recipientAddress && (
            <div className="rounded-3xl bg-white border border-black/5 shadow-sm overflow-hidden">
              {state.result.target.kind === "invoice" &&
                state.result.target.invoice.status === "paid" && (
                  <div className="bg-emerald-50 border-b border-emerald-100 px-6 py-3 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm font-medium text-emerald-800">
                      This invoice has already been paid.
                    </span>
                  </div>
                )}

              <div className="p-8">
                <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-2">
                  Pay
                </p>
                <h1
                  className="text-3xl font-medium text-[var(--text-primary)] tracking-tight mb-1"
                  style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
                >
                  {displayName ?? truncateAddress(recipientAddress)}
                </h1>
                {displayName && (
                  <p className="text-sm text-[var(--text-secondary)] font-mono">
                    {truncateAddress(recipientAddress)}
                  </p>
                )}

                {amount && (
                  <div className="mt-6 pt-6 border-t border-black/5">
                    <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-1">
                      Amount
                    </p>
                    <p className="text-3xl font-medium text-[var(--text-primary)]">
                      ${amount} <span className="text-base text-[var(--text-secondary)]">USDC</span>
                    </p>
                  </div>
                )}

                {state.result.target.kind === "invoice" && (
                  <div className="mt-6 pt-6 border-t border-black/5 space-y-3">
                    <div>
                      <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-1">
                        Invoice
                      </p>
                      <p className="font-medium text-[var(--text-primary)]">
                        #{state.result.target.invoice.invoice_id}: {state.result.target.invoice.description}
                      </p>
                    </div>
                    {state.result.target.invoice.due_date && (
                      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                        <Clock className="w-4 h-4" />
                        Due {new Date(state.result.target.invoice.due_date).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                )}

                {note && state.result.target.kind !== "invoice" && (
                  <div className="mt-6 pt-6 border-t border-black/5">
                    <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-tertiary)] mb-1">
                      Memo
                    </p>
                    <p className="text-[var(--text-primary)]">{note}</p>
                  </div>
                )}

                <div className="mt-8 space-y-3">
                  <button
                    onClick={() => goToSend("send")}
                    className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-[#2D2D2F] transition-all active:scale-[0.99] flex items-center justify-center gap-2"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    Pay with Blank (passkey)
                  </button>
                  <button
                    onClick={() => goToSend("send-with-wallet")}
                    className="w-full h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium hover:bg-black/10 transition-all active:scale-[0.99] flex items-center justify-center gap-2"
                  >
                    Pay with connected wallet
                  </button>
                </div>

                <div className="mt-6 flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                  <Lock className="w-3 h-3" />
                  <span>Amount is encrypted on-chain. Only you and {displayName ?? "the recipient"} see it.</span>
                </div>
              </div>
            </div>
          )}

          {/* Tiny fingerprint of who built it */}
          {state.phase === "ready" && recipientAddress && (
            <p className="mt-6 text-center text-xs text-[var(--text-tertiary)]">
              Recipient:{" "}
              <span className="font-mono">
                <AddressLabel address={recipientAddress} />
              </span>
            </p>
          )}
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}

function payErrorMessage(error: Extract<PayResolveResult, { ok: false }>["error"]): string {
  switch (error.kind) {
    case "not-found":
      return `We couldn't find ${error.identifier}. Check the link or ask the sender for a fresh one.`;
    case "ens-failed":
      return `${error.identifier} doesn't resolve to an address right now.`;
    case "invalid":
      return `${error.identifier || "(empty)"} isn't a valid address, ENS name, or invoice ID.`;
    case "supabase-unavailable":
      return "Invoice lookups are temporarily unavailable. Please try again in a moment.";
  }
}
