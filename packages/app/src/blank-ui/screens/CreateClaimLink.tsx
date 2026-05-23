import { useState, useMemo, useEffect, useCallback } from "react";
import { Link2, Mail, AtSign, Lock, Copy, Check, AlertCircle, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import { isAddress, type Address } from "viem";

import { useClaimLinks, type CreateLinkInput } from "@/hooks/useClaimLinks";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { MODE, type LinkMode } from "@/lib/claim-links";
import { cn } from "@/lib/cn";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";
import { ensClient } from "@/lib/ens-client";

// Pre-set expiry windows. Sender can pick "1 day" through "30 days".
const EXPIRY_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

// On-chain link record used by the "Your sent links" section.
interface SentLinkRecord {
  id: bigint;
  sender: `0x${string}`;
  vault: `0x${string}`;
  mode: number;
  boundAddress: `0x${string}`;
  createdAt: bigint;
  expiryTimestamp: bigint;
  claimed: boolean;
  refunded: boolean;
  note: string;
  claimer: `0x${string}`;
  claimedAt: bigint;
}

type SentLinkStatus = "claimable" | "claimed" | "refunded" | "expired";

function deriveStatus(record: SentLinkRecord): SentLinkStatus {
  if (record.claimed) return "claimed";
  if (record.refunded) return "refunded";
  if (Number(record.expiryTimestamp) * 1000 < Date.now()) return "expired";
  return "claimable";
}

export default function CreateClaimLink() {
  const { contracts, activeChain } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const { state, pipeline, createLink, refund, fetchSentLinks, fetchLink, reset } = useClaimLinks();

  const [mode, setMode] = useState<LinkMode>(MODE.EmailBound);
  const [amount, setAmount] = useState("");
  const [email, setEmail] = useState("");
  const [boundAddress, setBoundAddress] = useState("");
  const [note, setNote] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(EXPIRY_OPTIONS[1].seconds);

  // §1.14 C7: ENS / Basenames resolution. When the user types something
  // ending in .eth (or .base.eth), look it up via the mainnet ensClient
  // (CCIP-Read handles Basenames automatically). The placeholder
  // "0x... or alice.eth" was previously a lie because validation only
  // accepted hex. Now it's true.
  const [ensResolution, setEnsResolution] = useState<{
    state: "idle" | "resolving" | "resolved" | "not-found" | "error";
    address: Address | null;
    name: string | null;
  }>({ state: "idle", address: null, name: null });

  const looksLikeEnsName = (s: string): boolean => /\.eth$/i.test(s.trim());

  useEffect(() => {
    if (mode !== MODE.AddressBound) {
      setEnsResolution({ state: "idle", address: null, name: null });
      return;
    }
    const trimmed = boundAddress.trim();
    if (!trimmed) {
      setEnsResolution({ state: "idle", address: null, name: null });
      return;
    }
    if (isAddress(trimmed)) {
      // Already a hex address; no ENS lookup needed.
      setEnsResolution({ state: "idle", address: null, name: null });
      return;
    }
    if (!looksLikeEnsName(trimmed)) {
      setEnsResolution({ state: "idle", address: null, name: null });
      return;
    }
    // Debounce ENS lookups to avoid hammering the mainnet RPC on every
    // keystroke. 350ms is short enough to feel snappy, long enough that
    // typing "alice.eth" character by character only fires one lookup.
    let cancelled = false;
    setEnsResolution((prev) => ({ ...prev, state: "resolving" }));
    const handle = setTimeout(async () => {
      try {
        const resolved = await ensClient.getEnsAddress({ name: trimmed });
        if (cancelled) return;
        if (resolved && isAddress(resolved)) {
          setEnsResolution({ state: "resolved", address: resolved as Address, name: trimmed });
        } else {
          setEnsResolution({ state: "not-found", address: null, name: trimmed });
        }
      } catch {
        if (!cancelled) {
          setEnsResolution({ state: "error", address: null, name: trimmed });
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [mode, boundAddress]);

  // Resolved hex address to use for the on-chain call. Falls back to
  // the raw input when it's already hex.
  const effectiveBoundAddress: Address | null = useMemo(() => {
    if (mode !== MODE.AddressBound) return null;
    const trimmed = boundAddress.trim();
    if (isAddress(trimmed)) return trimmed as Address;
    if (ensResolution.state === "resolved" && ensResolution.address) {
      return ensResolution.address;
    }
    return null;
  }, [mode, boundAddress, ensResolution]);

  const validation = useMemo(() => {
    if (!amount || Number.parseFloat(amount) <= 0) return "Enter an amount above zero";
    if (mode === MODE.EmailBound) {
      // §1.14 C12: tighter regex than the old `indexOf("@") < 1` check,
      // which accepted "a@", "@b", "a@b" (no TLD). Still permissive
      // enough for international TLDs (no length cap on parts).
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return "Enter a valid email";
      }
    }
    if (mode === MODE.AddressBound) {
      if (!boundAddress.trim()) return "Enter a valid address or ENS name";
      // Mid-resolution: block submit but don't show this as a validation
      // error (the UI shows a "Resolving…" hint instead — distinct from
      // a permanent error like "ENS not found").
      if (ensResolution.state === "resolving") return "Resolving ENS name…";
      if (ensResolution.state === "not-found") return "ENS name didn't resolve to an address";
      if (ensResolution.state === "error") return "Couldn't reach ENS resolver";
      if (!effectiveBoundAddress) return "Enter a valid address or ENS name";
    }
    return null;
  }, [amount, mode, email, boundAddress, ensResolution, effectiveBoundAddress]);

  const handleCreate = async () => {
    if (validation) {
      toast.error(validation);
      return;
    }
    const input: CreateLinkInput =
      mode === MODE.Bearer
        ? { mode: MODE.Bearer }
        : mode === MODE.EmailBound
          ? { mode: MODE.EmailBound, email }
          : {
              mode: MODE.AddressBound,
              // §1.14 C7: when input was an ENS name, use the resolved
              // hex address (validation already gated on resolution
              // success, so effectiveBoundAddress is non-null here).
              boundAddress: (effectiveBoundAddress ?? (boundAddress as Address)) as `0x${string}`,
            };

    await createLink({
      vault: contracts.FHERC20Vault_USDC,
      amountTokens: amount,
      decimals: 6,
      note,
      expirySeconds,
      input,
    });
  };

  const copyUrl = async () => {
    if (!state.shareableUrl) return;
    await navigator.clipboard.writeText(state.shareableUrl);
    toast.success("Link copied");
  };

  // §1.15 B3 — "Your sent links" section. Fetches the user's sent
  // linkIds from the contract + reads each link's state in parallel.
  // Refreshes after a successful create + on the user's demand.
  const [sentLinks, setSentLinks] = useState<SentLinkRecord[]>([]);
  const [loadingSent, setLoadingSent] = useState(false);
  const [refundingId, setRefundingId] = useState<bigint | null>(null);
  const [sentLinksRefreshedAt, setSentLinksRefreshedAt] = useState<number | null>(null);

  const refreshSentLinks = useCallback(async () => {
    if (!effectiveAddress) return;
    setLoadingSent(true);
    try {
      const ids = await fetchSentLinks(effectiveAddress as `0x${string}`);
      const records = await Promise.all(ids.map((id) => fetchLink(id)));
      const filtered = records.filter((r): r is SentLinkRecord => r !== null);
      // Newest first.
      filtered.sort((a, b) => Number(b.createdAt - a.createdAt));
      setSentLinks(filtered);
      setSentLinksRefreshedAt(Date.now());
    } finally {
      setLoadingSent(false);
    }
  }, [effectiveAddress, fetchSentLinks, fetchLink]);

  useEffect(() => {
    refreshSentLinks();
  }, [refreshSentLinks]);

  // Refresh after a successful create so the new link appears in the list.
  useEffect(() => {
    if (state.step === "success") refreshSentLinks();
  }, [state.step, refreshSentLinks]);

  const handleRefund = useCallback(
    async (linkId: bigint) => {
      setRefundingId(linkId);
      try {
        const ok = await refund(Number(linkId));
        if (ok) await refreshSentLinks();
      } finally {
        setRefundingId(null);
      }
    },
    [refund, refreshSentLinks],
  );

  const copySentLink = useCallback(
    async (linkId: bigint) => {
      // The full claim URL needs the secret in the URL fragment, which
      // only existed at create time (we don't store it). The sender can
      // still find their original link in their browser/email/etc; this
      // button copies the explorer URL as a fallback identifier.
      const explorerUrl = `${activeChain.explorerUrl}/address/${contracts.ClaimLinks}`;
      await navigator.clipboard.writeText(`Link #${linkId.toString()} on ${activeChain.name}: ${explorerUrl}`);
      toast.success("Link identifier copied");
    },
    [activeChain, contracts.ClaimLinks],
  );

  // ─── Success screen ───────────────────────────────────────────────
  if (state.step === "success" && state.shareableUrl) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="glass-card-static rounded-[2rem] p-10 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-6">
            <Check size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-2xl font-heading font-semibold mb-3">Link ready</h2>
          <p className="text-[var(--text-secondary)] mb-6">
            Share this URL with the recipient. The amount stays encrypted until they claim it.
          </p>
          <div
            data-testid="claim-link-share-url"
            className="bg-[var(--surface-2)] rounded-2xl p-4 mb-4 break-all text-sm font-mono text-left"
          >
            {state.shareableUrl}
          </div>
          <button
            onClick={copyUrl}
            className="inline-flex items-center gap-2 px-6 h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors mb-3"
          >
            <Copy size={18} /> Copy link
          </button>
          <div className="text-sm text-[var(--text-secondary)] mt-2">
            Expires {new Date(Date.now() + expirySeconds * 1000).toLocaleString()}.
            If unclaimed, you can refund from the Claim Links tab.
          </div>
          <button
            onClick={reset}
            className="mt-6 text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Create another link
          </button>
        </div>
      </div>
    );
  }

  // ─── Form screen ──────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto">
      <div className="glass-card-static rounded-[2rem] p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
            <Link2 size={24} className="text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-heading font-semibold">Send by link</h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Encrypted. Refundable if unclaimed.
            </p>
          </div>
        </div>

        {/* Mode picker */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Who can claim it?</label>
          <div className="grid grid-cols-3 gap-2">
            <ModePill
              active={mode === MODE.Bearer}
              onClick={() => setMode(MODE.Bearer)}
              icon={<Link2 size={16} />}
              label="Anyone"
              hint="Open link"
            />
            <ModePill
              active={mode === MODE.EmailBound}
              onClick={() => setMode(MODE.EmailBound)}
              icon={<Mail size={16} />}
              label="Email"
              hint="Default"
            />
            <ModePill
              active={mode === MODE.AddressBound}
              onClick={() => setMode(MODE.AddressBound)}
              icon={<AtSign size={16} />}
              label="Address"
              hint="One wallet"
            />
          </div>
        </div>

        {/* Conditional second-factor input */}
        {mode === MODE.EmailBound && (
          <Field
            label="Recipient email"
            icon={<Mail size={16} />}
            value={email}
            onChange={setEmail}
            placeholder="alice@example.com"
            type="email"
          />
        )}
        {mode === MODE.AddressBound && (
          <div>
            <Field
              label="Recipient address"
              icon={<AtSign size={16} />}
              value={boundAddress}
              onChange={setBoundAddress}
              placeholder="0x… or alice.eth"
            />
            {ensResolution.state === "resolving" && (
              <p className="text-xs text-[var(--text-secondary)] mt-1 mb-3 flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                Resolving {ensResolution.name ?? "ENS name"}…
              </p>
            )}
            {ensResolution.state === "resolved" && ensResolution.address && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1 mb-3 flex items-center gap-1.5">
                <Check size={11} />
                Resolved to <span className="font-mono">{ensResolution.address.slice(0, 6)}…{ensResolution.address.slice(-4)}</span>
              </p>
            )}
            {ensResolution.state === "not-found" && (
              <p className="text-xs text-red-600 mt-1 mb-3 flex items-center gap-1.5">
                <AlertCircle size={11} />
                {ensResolution.name} doesn't have a primary address set on ENS
              </p>
            )}
            {ensResolution.state === "error" && (
              <p className="text-xs text-amber-700 mt-1 mb-3 flex items-center gap-1.5">
                <AlertCircle size={11} />
                Couldn't reach the ENS resolver. Paste a 0x address instead.
              </p>
            )}
          </div>
        )}

        {/* Amount */}
        <Field
          label="Amount (USDC)"
          value={amount}
          onChange={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
          placeholder="10.00"
          type="text"
        />

        {/* Optional note */}
        <Field
          label="Note (optional)"
          value={note}
          onChange={setNote}
          placeholder="Lunch tab"
        />

        {/* Expiry */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Expires after</label>
          <div className="grid grid-cols-3 gap-2">
            {EXPIRY_OPTIONS.map((opt) => (
              <button
                key={opt.seconds}
                onClick={() => setExpirySeconds(opt.seconds)}
                aria-pressed={expirySeconds === opt.seconds}
                className={cn(
                  "h-12 rounded-xl border-2 text-sm font-medium transition-all",
                  expirySeconds === opt.seconds
                    ? "bg-[#1D1D1F] border-[#1D1D1F] text-white shadow-sm"
                    : "bg-white border-black/10 text-[var(--text-primary)] hover:border-black/30 hover:bg-black/[0.02]",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-2 flex items-center gap-1">
            <Lock size={12} /> If unclaimed by then, you can refund yourself.
          </p>
        </div>

        {/* Wave 4 task #245 — real-step FHE pipeline progress, driven
            by the SDK's onStep callback for the 5 encrypt phases plus
            our own submit/confirm markers. Replaces the old single-line
            spinner with a transparent multi-step view. */}
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
          {state.isProcessing ? "Creating…" : "Create link"}
        </button>
      </div>

      {/* §1.15 B3 — Your sent links. Closes the "you can refund from
          the Claim Links tab" promise that previously pointed at a
          non-existent tab. Sender can refund any of their own links
          that haven't been claimed yet. */}
      {effectiveAddress && (
        <div className="glass-card-static rounded-[2rem] p-6 sm:p-8 mt-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-lg font-heading font-semibold">Your sent links</h2>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                On-chain link state. Refund expired links, track claims, and copy a link reference.
              </p>
              {sentLinksRefreshedAt && (
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Checked {new Date(sentLinksRefreshedAt).toLocaleTimeString()}.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={refreshSentLinks}
              disabled={loadingSent}
              className="h-9 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] text-xs flex items-center gap-1.5 disabled:opacity-50"
              aria-label="Refresh sent links"
            >
              <RefreshCw size={11} className={loadingSent ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {loadingSent && sentLinks.length === 0 ? (
            <div className="text-center py-6 text-[var(--text-secondary)] text-sm">
              <Loader2 size={20} className="animate-spin inline mr-2 opacity-60" />
              Loading sent links…
            </div>
          ) : sentLinks.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-tertiary)] text-sm">
              <Link2 size={28} className="mx-auto mb-2 opacity-30" />
              <p>You haven't sent any links yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sentLinks.map((link) => {
                const status = deriveStatus(link);
                const statusColor =
                  status === "claimable"
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"
                    : status === "claimed"
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : status === "refunded"
                        ? "bg-slate-100 text-slate-700 dark:bg-slate-500/10 dark:text-slate-300"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
                // The contract requires `block.timestamp >= expiryTimestamp`
                // for refundLink; only show the Refund CTA on expired
                // links. Claimable links can't be cancel-refunded early
                // (audit A14 flagged this; "cancel" is a follow-up
                // contract change, not in scope here).
                const canRefund = status === "expired";
                return (
                  <div
                    key={link.id.toString()}
                    className="rounded-2xl bg-white/50 dark:bg-white/[0.03] border border-black/5 dark:border-white/5 p-4 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs text-[var(--text-tertiary)]">
                          #{link.id.toString()}
                        </span>
                        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide", statusColor)}>
                          {status}
                        </span>
                      </div>
                      {link.note && (
                        <p className="text-sm text-[var(--text-primary)] mb-1 truncate">{link.note}</p>
                      )}
                      <p className="text-[11px] text-[var(--text-tertiary)]">
                        Expires {new Date(Number(link.expiryTimestamp) * 1000).toLocaleDateString()}
                        {status === "claimed" && link.claimer !== "0x0000000000000000000000000000000000000000" && (
                          <> · claimed by <span className="font-mono">{link.claimer.slice(0, 6)}…{link.claimer.slice(-4)}</span></>
                        )}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)] mt-1">
                        {status === "claimable" && "Waiting for the recipient to claim."}
                        {status === "claimed" && "Claim complete. Funds are with the recipient."}
                        {status === "refunded" && "Refund complete. The link can no longer be claimed."}
                        {status === "expired" && "Expired and ready to refund."}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => copySentLink(link.id)}
                        className="h-8 px-3 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] text-[11px] flex items-center gap-1.5"
                        aria-label={`Copy link ${link.id}`}
                      >
                        <Copy size={10} /> Copy
                      </button>
                      {canRefund && (
                        <button
                          type="button"
                          onClick={() => handleRefund(link.id)}
                          disabled={refundingId === link.id}
                          className="h-8 px-3 rounded-lg bg-[#1D1D1F] hover:bg-black text-white text-[11px] flex items-center gap-1.5 disabled:opacity-50"
                          aria-label={`Refund link ${link.id}`}
                        >
                          {refundingId === link.id ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <RotateCcw size={10} />
                          )}
                          Refund
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── small primitives ─────────────────────────────────────────────────

function ModePill(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
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
  type?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium mb-2">{props.label}</label>
      <div className="relative">
        {props.icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]">
            {props.icon}
          </div>
        )}
        <input
          type={props.type || "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          className={cn(
            "w-full h-12 rounded-xl border border-[var(--border)] bg-transparent text-base",
            "focus:border-[var(--border-strong)] focus:outline-none transition-colors",
            props.icon ? "pl-10 pr-3" : "px-3",
          )}
        />
      </div>
    </div>
  );
}
