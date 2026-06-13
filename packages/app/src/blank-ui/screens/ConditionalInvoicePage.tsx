// Conditional invoice — Reineira IConditionResolver standard on Blank's own
// EncryptedEscrow (Arbitrum Sepolia only).
//
// Two surfaces in one file:
//   * ConditionalInvoicePage (default)  — public link
//       /conditional-invoice/:chainId/:escrowId. The payer (depositor)
//       approves release; the recipient (beneficiary) or anyone triggers
//       release once approved or past the auto-release deadline.
//   * ConditionalInvoiceCreate (named)  — authed create form at
//       /app/conditional-invoices. The payer escrows an encrypted amount to a
//       recipient; releases on approval or after the deadline.
//
// Privacy boundary: payer + recipient + description + deadline are public;
// the amount stays encrypted in the vault (visible only to the two parties).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { usePublicClient } from "wagmi";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Lock,
  ShieldCheck,
} from "lucide-react";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { useEncryptedEscrow, ESCROW_STATUS } from "@/hooks/useEncryptedEscrow";
import { EncryptedEscrowAbi, InvoiceApprovalResolverAbi } from "@/lib/abis";
import {
  CONTRACTS_BY_CHAIN,
  ARB_SEPOLIA_ID,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "@/lib/constants";
import { truncateAddress } from "@/lib/address";

const ZERO = "0x0000000000000000000000000000000000000000";
const POLL_MS = 8_000;

const CHAIN_NAME: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "Ethereum Sepolia",
  [BASE_SEPOLIA_ID]: "Base Sepolia",
  [ARB_SEPOLIA_ID]: "Arbitrum Sepolia",
};

const STEP_LABEL: Record<string, string> = {
  approving: "Approving vault…",
  encrypting: "Encrypting amount…",
  sending: "Submitting…",
};

function statusLabel(status: number): { label: string; tone: string } {
  switch (status) {
    case ESCROW_STATUS.Released:
      return { label: "Released", tone: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30" };
    case ESCROW_STATUS.Refunded:
      return { label: "Refunded", tone: "text-slate-600 bg-slate-500/10 border-slate-500/30" };
    case ESCROW_STATUS.Disputed:
      return { label: "Disputed", tone: "text-amber-700 bg-amber-500/10 border-amber-500/30" };
    default:
      return { label: "Active", tone: "text-indigo-700 bg-indigo-500/10 border-indigo-500/30" };
  }
}

interface OnChainEscrow {
  depositor: `0x${string}`;
  beneficiary: `0x${string}`;
  deadline: bigint;
  status: number;
  description: string;
}
interface Condition {
  buyer: `0x${string}`;
  autoReleaseDeadline: bigint;
  isApproved: boolean;
  deadlinePassed: boolean;
  set: boolean;
}

// ─── Public link view ──────────────────────────────────────────────────────

export default function ConditionalInvoicePage() {
  const params = useParams<{ chainId: string; escrowId: string }>();
  const navigate = useNavigate();
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId, setActiveChain } = useChain();
  const { approveInvoice, triggerRelease, state } = useEncryptedEscrow();

  const linkChainId = useMemo(() => Number(params.chainId), [params.chainId]);
  const escrowId = useMemo(() => Number(params.escrowId), [params.escrowId]);
  const supported = linkChainId === ETH_SEPOLIA_ID || linkChainId === BASE_SEPOLIA_ID || linkChainId === ARB_SEPOLIA_ID;
  const onArb = linkChainId === ARB_SEPOLIA_ID;
  const onLinkChain = linkChainId === activeChainId;
  const publicClient = usePublicClient({ chainId: supported ? linkChainId : undefined });

  const [escrow, setEscrow] = useState<OnChainEscrow | null>(null);
  const [condition, setCondition] = useState<Condition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!publicClient || !supported || !Number.isFinite(escrowId)) {
      setLoading(false);
      setLoadError(!supported ? "Unsupported chain in link" : "Invalid invoice id");
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[linkChainId as SupportedChainId];
    const resolver = contracts?.InvoiceApprovalResolver as `0x${string}`;
    if (!resolver || resolver === ZERO) {
      setLoading(false);
      setLoadError("Conditional invoices are only available on Arbitrum Sepolia.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const e = (await publicClient.readContract({
          address: contracts.EncryptedEscrow as `0x${string}`,
          abi: EncryptedEscrowAbi,
          functionName: "getEscrow",
          args: [BigInt(escrowId)],
        })) as readonly [
          `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`,
          bigint, boolean, boolean, number, string, bigint,
        ];
        const c = (await publicClient.readContract({
          address: resolver,
          abi: InvoiceApprovalResolverAbi,
          functionName: "getCondition",
          args: [BigInt(escrowId)],
        })) as readonly [`0x${string}`, bigint, boolean, boolean, boolean];
        if (cancelled) return;
        setEscrow({ depositor: e[0], beneficiary: e[1], deadline: e[4], status: e[7], description: e[8] });
        setCondition({ buyer: c[0], autoReleaseDeadline: c[1], isApproved: c[2], deadlinePassed: c[3], set: c[4] });
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError((prev) => prev ?? (err instanceof Error ? err.message : "Couldn't load invoice"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, linkChainId, escrowId, supported, tick]);

  // Re-poll while Active so the screen reflects approve/release without reload.
  useEffect(() => {
    if (escrow && escrow.status !== ESCROW_STATUS.Active) return;
    const t = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, [escrow]);

  const me = effectiveAddress?.toLowerCase();
  const isPayer = !!me && !!escrow && me === escrow.depositor.toLowerCase();
  const isRecipient = !!me && !!escrow && me === escrow.beneficiary.toLowerCase();
  const releasable = !!condition && (condition.isApproved || condition.deadlinePassed);
  const active = escrow?.status === ESCROW_STATUS.Active;

  const onApprove = useCallback(async () => {
    if (!onLinkChain) { toast.error(`Switch to ${CHAIN_NAME[linkChainId]} first`); return; }
    const ok = await approveInvoice(escrowId);
    if (ok) setTick((n) => n + 1);
  }, [onLinkChain, linkChainId, approveInvoice, escrowId]);

  const onRelease = useCallback(async () => {
    if (!onLinkChain) { toast.error(`Switch to ${CHAIN_NAME[linkChainId]} first`); return; }
    const ok = await triggerRelease(escrowId);
    if (ok) setTick((n) => n + 1);
  }, [onLinkChain, linkChainId, triggerRelease, escrowId]);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(
      () => toast.success("Link copied"),
      () => toast.error("Copy failed"),
    );
  }, []);

  return (
    <main className="min-h-dvh bg-[#F9FAFB] px-4 py-8 flex justify-center">
      <div className="w-full max-w-lg space-y-4">
        <button
          onClick={() => navigate("/app")}
          className="text-sm text-[var(--text-primary)]/60 inline-flex items-center gap-1.5 hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={15} /> Blank
        </button>

        <div className="rounded-2xl bg-white border border-black/5 p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2">
              <ShieldCheck size={18} className="text-emerald-600" />
              <h1 className="font-semibold text-[var(--text-primary)] text-[15px] leading-none m-0" style={{ fontFamily: "'Outfit', sans-serif" }}>
                Conditional invoice
              </h1>
            </div>
            {escrow && (
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${statusLabel(escrow.status).tone}`}>
                {statusLabel(escrow.status).label}
              </span>
            )}
          </div>

          {loading && (
            <div className="py-10 flex justify-center text-[var(--text-primary)]/50">
              <Loader2 className="animate-spin" size={22} />
            </div>
          )}

          {!loading && loadError && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
              {loadError}
            </div>
          )}

          {!loading && !loadError && escrow && condition && (
            <>
              <p className="text-[var(--text-primary)] text-[15px] leading-relaxed">
                {escrow.description || "Conditional payment"}
              </p>

              <div className="rounded-xl bg-[#F9FAFB] border border-black/5 divide-y divide-black/5 text-sm">
                <Row label="Amount">
                  <span className="inline-flex items-center gap-1.5 text-[var(--text-primary)]/80">
                    <Lock size={13} /> Encrypted
                  </span>
                </Row>
                <Row label="Payer">{truncateAddress(escrow.depositor)}</Row>
                <Row label="Recipient">{truncateAddress(escrow.beneficiary)}</Row>
                <Row label="Auto-release">
                  <span className="inline-flex items-center gap-1.5">
                    <Calendar size={13} />
                    {new Date(Number(condition.autoReleaseDeadline) * 1000).toLocaleDateString()}
                  </span>
                </Row>
                <Row label="Approved">
                  {condition.isApproved ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-700">
                      <CheckCircle2 size={13} /> Yes
                    </span>
                  ) : condition.deadlinePassed ? (
                    <span className="inline-flex items-center gap-1.5 text-indigo-700">
                      <Clock size={13} /> Deadline passed
                    </span>
                  ) : (
                    <span className="text-[var(--text-primary)]/50">Pending</span>
                  )}
                </Row>
              </div>

              {!onArb && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
                  Conditional invoices run on Arbitrum Sepolia.
                </div>
              )}

              {active && onArb && !onLinkChain && (
                <button
                  onClick={() => setActiveChain(linkChainId as SupportedChainId)}
                  className="w-full h-11 rounded-2xl bg-[var(--text-primary)] text-white font-medium hover:bg-black"
                >
                  Switch to {CHAIN_NAME[linkChainId]}
                </button>
              )}

              {active && onArb && onLinkChain && (
                <div className="space-y-2">
                  {isPayer && !condition.isApproved && (
                    <button
                      onClick={onApprove}
                      disabled={state.isProcessing}
                      className="w-full h-11 rounded-2xl bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      {state.isProcessing && <Loader2 size={16} className="animate-spin" />}
                      Approve release
                    </button>
                  )}
                  {releasable && (
                    <button
                      onClick={onRelease}
                      disabled={state.isProcessing}
                      className="w-full h-11 rounded-2xl bg-[var(--text-primary)] text-white font-medium hover:bg-black disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      {state.isProcessing && <Loader2 size={16} className="animate-spin" />}
                      Release funds to recipient
                    </button>
                  )}
                  {!isPayer && !isRecipient && !releasable && (
                    <p className="text-sm text-[var(--text-primary)]/50 text-center">
                      Waiting for the payer to approve, or the auto-release deadline.
                    </p>
                  )}
                  {isPayer && !condition.isApproved && (
                    <p className="text-xs text-[var(--text-primary)]/50 text-center">
                      Approve to release now, or it auto-releases to the recipient after the deadline.
                    </p>
                  )}
                </div>
              )}

              {escrow.status === ESCROW_STATUS.Released && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-800 inline-flex items-center gap-2">
                  <CheckCircle2 size={15} /> Released to the recipient.
                </div>
              )}

              <button
                onClick={copyLink}
                className="w-full h-10 rounded-2xl bg-white border border-black/10 text-sm text-[var(--text-primary)]/80 hover:bg-black/5 inline-flex items-center justify-center gap-2"
              >
                <ExternalLink size={14} /> Copy share link
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[var(--text-primary)]/50">{label}</span>
      <span className="text-[var(--text-primary)] font-medium tabular-nums">{children}</span>
    </div>
  );
}

// ─── Authed create form ─────────────────────────────────────────────────────

export function ConditionalInvoiceCreate() {
  const navigate = useNavigate();
  const { contracts, activeChainId, setActiveChain } = useChain();
  const { createConditionalInvoice, state } = useEncryptedEscrow();

  const resolver = contracts.InvoiceApprovalResolver as `0x${string}`;
  const onArb = activeChainId === ARB_SEPOLIA_ID && !!resolver && resolver !== ZERO;

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("7");
  const [description, setDescription] = useState("");

  const submit = useCallback(async () => {
    const deadlineSeconds = Math.floor(Date.now() / 1000) + Math.max(1, Number(days || "1")) * 86400;
    const id = await createConditionalInvoice({
      beneficiary: recipient.trim() as `0x${string}`,
      vault: contracts.FHERC20Vault_USDC as `0x${string}`,
      amountTokens: amount,
      decimals: 6,
      description: description.trim(),
      deadlineSeconds,
    });
    if (id !== null) {
      navigate(`/conditional-invoice/${activeChainId}/${id}`);
    }
  }, [days, createConditionalInvoice, recipient, contracts.FHERC20Vault_USDC, amount, description, navigate, activeChainId]);

  const busy = state.isProcessing;
  const canSubmit = onArb && !busy && /^0x[a-fA-F0-9]{40}$/.test(recipient.trim()) && Number(amount) > 0;

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]" style={{ fontFamily: "'Outfit', sans-serif" }}>
          Conditional invoice
        </h1>
        <p className="text-sm text-[var(--text-primary)]/60 mt-1">
          Escrow an encrypted payment that releases when you approve, or
          automatically after a deadline. Built on Reineira's release-rule
          standard, on Arbitrum Sepolia.
        </p>
      </div>

      {!onArb && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
          <Lock size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium text-amber-700">Arbitrum Sepolia only</div>
            <div className="text-[var(--text-primary)]/70 mt-0.5">
              Conditional invoices are deployed on Arbitrum Sepolia. Switch chains to create one.
            </div>
            <button
              onClick={() => setActiveChain(ARB_SEPOLIA_ID)}
              className="mt-2 h-9 px-4 rounded-xl bg-[var(--text-primary)] text-white text-sm font-medium hover:bg-black"
            >
              Switch to Arbitrum Sepolia
            </button>
          </div>
        </div>
      )}

      <div className="rounded-2xl bg-white border border-black/5 p-5 space-y-4">
        <Field label="Recipient address">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            disabled={!onArb}
            className="w-full h-11 px-3 rounded-xl border border-black/10 bg-[#F9FAFB] text-sm font-mono disabled:opacity-50"
          />
        </Field>
        <Field label="Amount (USDC)">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="100"
            inputMode="decimal"
            disabled={!onArb}
            className="w-full h-11 px-3 rounded-xl border border-black/10 bg-[#F9FAFB] text-sm tabular-nums disabled:opacity-50"
          />
        </Field>
        <Field label="Auto-release after (days)">
          <input
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="7"
            inputMode="numeric"
            disabled={!onArb}
            className="w-full h-11 px-3 rounded-xl border border-black/10 bg-[#F9FAFB] text-sm tabular-nums disabled:opacity-50"
          />
        </Field>
        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this for?"
            maxLength={512}
            disabled={!onArb}
            className="w-full h-11 px-3 rounded-xl border border-black/10 bg-[#F9FAFB] text-sm disabled:opacity-50"
          />
        </Field>

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full h-11 rounded-2xl bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center justify-center gap-2"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {busy ? (STEP_LABEL[state.step] ?? "Creating…") : "Create conditional invoice"}
        </button>
        {state.step === "error" && state.error && (
          <p className="text-sm text-red-600">{state.error}</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-[var(--text-primary)]/70">{label}</span>
      {children}
    </label>
  );
}
