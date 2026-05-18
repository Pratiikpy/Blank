// Public invoice page. URL: /app/invoice/:chainId/:invoiceId.
//
// Roles handled:
//   * Vendor — read-only summary + "Copy link" to share, plus the proof
//              row when the invoice is Paid.
//   * Client — funds the escrow (payInvoiceEscrow), then finalizes
//              (releaseInvoiceEscrow). On match, vendor is paid; on
//              mismatch, the client is refunded automatically.
//   * Bystander — sees the public surface only. No pay/finalize actions.
//
// Privacy boundary intentional:
//   public:  vendor + client addresses (truncated), description, due
//            date, status, transaction hashes
//   private: invoice amount (encrypted in BusinessHub.amount)
//
// Chain handling: if the link is for a chain that isn't currently active,
// we show a one-button switcher rather than reading the wrong contract.

import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { usePublicClient } from "wagmi";
import { ArrowLeft, ExternalLink, Calendar, FileText, Loader2, ShieldCheck, Wallet } from "lucide-react";
import toast from "react-hot-toast";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { useInvoiceEscrow } from "@/hooks/useInvoiceEscrow";
import { BusinessHubAbi } from "@/lib/abis";
import {
  CONTRACTS_BY_CHAIN,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
  getExplorerTxUrl,
} from "@/lib/constants";
import { truncateAddress } from "@/lib/address";
import { InvoiceStatusBadge } from "@/blank-ui/components/InvoiceStatusBadge";
import { CopyInvoiceLink } from "@/blank-ui/components/CopyInvoiceLink";
import { fetchInvoiceActivities, type ActivityRow } from "@/lib/supabase";

interface OnChainInvoice {
  vendor: `0x${string}`;
  client: `0x${string}`;
  vault: `0x${string}`;
  amount: bigint; // encrypted handle — never shown
  description: string;
  dueDate: bigint;
  status: number;
}

const POLL_INTERVAL_MS = 8_000;

export default function InvoicePage() {
  const params = useParams<{ chainId: string; invoiceId: string }>();
  const navigate = useNavigate();
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId, setActiveChain } = useChain();

  const linkChainId = useMemo(() => Number(params.chainId), [params.chainId]);
  const invoiceId = useMemo(() => Number(params.invoiceId), [params.invoiceId]);
  const isLinkChainSupported =
    linkChainId === ETH_SEPOLIA_ID || linkChainId === BASE_SEPOLIA_ID;
  const onActiveChain = linkChainId === activeChainId;

  // Always use the link's chain when reading the invoice — even if the
  // user hasn't switched yet. They'll see the correct invoice and can
  // switch via the prompt before paying.
  const publicClient = usePublicClient({
    chainId: isLinkChainSupported ? linkChainId : undefined,
  });

  const [invoice, setInvoice] = useState<OnChainInvoice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [payAmount, setPayAmount] = useState("");

  const { payEscrow, releaseEscrow, isPaying, isReleasing } = useInvoiceEscrow();

  // Read the invoice on mount + every poll tick (so status updates after
  // pay/finalize without a page reload).
  useEffect(() => {
    if (!publicClient || !isLinkChainSupported || !Number.isFinite(invoiceId)) {
      setLoading(false);
      setLoadError(!isLinkChainSupported ? "Unsupported chain in link" : "Invalid invoice id");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const contracts = CONTRACTS_BY_CHAIN[linkChainId as SupportedChainId];
        if (!contracts) throw new Error("BusinessHub not deployed on this chain");
        const r = (await publicClient.readContract({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "getInvoice",
          args: [BigInt(invoiceId)],
        })) as readonly [
          `0x${string}`,
          `0x${string}`,
          `0x${string}`,
          bigint,
          string,
          bigint,
          number,
        ];
        if (cancelled) return;
        setInvoice({
          vendor: r[0],
          client: r[1],
          vault: r[2],
          amount: r[3],
          description: r[4],
          dueDate: r[5],
          status: r[6],
        });
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Couldn't load invoice";
        // Only surface as a hard error on the FIRST load. Polls failing
        // silently is fine — the previously-loaded invoice stays on screen.
        setLoadError((prev) => prev ?? msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, linkChainId, invoiceId, isLinkChainSupported, tick]);

  // Re-poll while the invoice is in a transient state (Pending or
  // PaymentPending) so the UI catches the status change without a manual
  // refresh after payEscrow / releaseEscrow.
  useEffect(() => {
    if (!invoice) return;
    if (invoice.status !== 0 && invoice.status !== 3) return;
    const id = setInterval(() => setTick((t) => t + 1), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [invoice]);

  // Hydrate activity feed for proof-of-payment panel. Tx hashes + paid
  // timestamp come from Supabase rows the hooks (useInvoiceEscrow /
  // useBusinessHub) wrote at fund / finalize time. Polls along with the
  // on-chain status so newly-finalized invoices show their proof
  // immediately.
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  useEffect(() => {
    if (!isLinkChainSupported || !Number.isFinite(invoiceId)) return;
    let cancelled = false;
    fetchInvoiceActivities(linkChainId, invoiceId).then((rows) => {
      if (!cancelled) setActivities(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [linkChainId, invoiceId, isLinkChainSupported, tick]);

  // Pull out the most useful events for the proof panel. Order is
  // chronological (fetchInvoiceActivities sorts ascending), so the
  // first-funded / first-paid timestamp is the canonical one.
  const fundedActivity = useMemo(
    () =>
      activities.find(
        (a) =>
          a.activity_type === "invoice_payment" ||
          (a.note ?? "").toLowerCase().includes("funded escrow"),
      ) ?? null,
    [activities],
  );
  const paidActivity = useMemo(
    () =>
      activities.find(
        (a) => a.activity_type === "invoice_paid" || a.activity_type === "invoice_finalized",
      ) ?? null,
    [activities],
  );

  // ── Loading & error states ───────────────────────────────────────
  if (!Number.isFinite(invoiceId) || !Number.isInteger(invoiceId) || invoiceId < 0) {
    // Reject 1.5, 1e21, "abc", negatives. Otherwise BigInt(invoiceId)
    // at line 96 throws RangeError caught only by the load effect and
    // surfaced as a generic load error instead of the right UX signal.
    return <Frame><CardError title="Invalid link" body="The invoice id in this URL isn't a valid positive integer." /></Frame>;
  }
  if (!isLinkChainSupported) {
    return <Frame><CardError title="Unsupported chain" body={`Chain ${linkChainId} isn't supported by Blank.`} /></Frame>;
  }
  if (loading && !invoice) {
    return (
      <Frame>
        <div className="flex items-center justify-center py-16 text-[var(--text-primary)]/50">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading invoice…
        </div>
      </Frame>
    );
  }
  if (!invoice) {
    return <Frame><CardError title="Invoice not found" body={loadError ?? "This invoice doesn't exist on-chain."} /></Frame>;
  }

  // ── Render ────────────────────────────────────────────────────────
  const me = effectiveAddress?.toLowerCase();
  const isVendor = me === invoice.vendor.toLowerCase();
  const isClient = me === invoice.client.toLowerCase();

  const dueDateStr =
    invoice.dueDate > 0n
      ? new Date(Number(invoice.dueDate) * 1000).toLocaleDateString()
      : "—";

  return (
    <Frame>
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 text-[var(--text-primary)]/60 text-sm mb-6 hover:text-[var(--text-primary)] transition-colors"
      >
        <ArrowLeft size={16} />
        Back
      </button>

      <div className="rounded-[2rem] glass-card p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-[var(--text-primary)]/40 font-medium mb-1">
              Invoice #{invoiceId}
            </p>
            <h1 className="text-2xl font-heading font-medium text-[var(--text-primary)] truncate">
              {invoice.description || "Untitled invoice"}
            </h1>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <InvoiceStatusBadge status={invoice.status} />
            {isVendor && (
              <CopyInvoiceLink chainId={linkChainId} invoiceId={invoiceId} variant="icon" />
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <Field label="From" value={truncateAddress(invoice.vendor)} mono />
          <Field label="To" value={truncateAddress(invoice.client)} mono />
          <Field
            label="Due"
            value={dueDateStr}
            icon={<Calendar size={14} className="text-[var(--text-primary)]/40" />}
          />
          <Field
            label="Amount"
            value="Encrypted (FHE)"
            icon={<FileText size={14} className="text-[var(--text-primary)]/40" />}
            italic
          />
        </div>

        <p className="text-xs text-[var(--text-primary)]/40 italic">
          Amount is encrypted on-chain. Only the vendor and client can see it.
        </p>
      </div>

      {/* Action panel — adapts to status + role */}
      {!onActiveChain && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-6 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900">
              This invoice is on a different chain.
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              Switch to chain {linkChainId} to interact with it.
            </p>
          </div>
          <button
            onClick={() => setActiveChain(linkChainId as 11155111 | 84532)}
            className="shrink-0 h-9 px-4 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700"
          >
            Switch
          </button>
        </div>
      )}

      {/* Pending — client can fund the escrow */}
      {invoice.status === 0 && isClient && onActiveChain && (
        <div className="rounded-2xl glass-card p-6">
          <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-2">
            Pay this invoice
          </h3>
          <p className="text-sm text-[var(--text-primary)]/60 mb-4">
            Funds will be held in escrow until you finalize. If the encrypted
            amount you pay doesn't match the invoice, you'll be refunded
            automatically. No vendor approval required.
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="Amount in USDC"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              disabled={isPaying}
              className="flex-1 h-12 px-4 rounded-xl bg-white/60 border border-black/10 outline-none focus:border-black/20 dark:bg-white/10 dark:border-white/10"
            />
            <button
              disabled={isPaying || !payAmount}
              onClick={async () => {
                const hash = await payEscrow(invoiceId, payAmount);
                if (hash) {
                  setPayAmount("");
                  setTick((t) => t + 1);
                }
              }}
              className="h-12 px-5 rounded-xl bg-[var(--text-primary)] text-white font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {isPaying ? <Loader2 size={16} className="animate-spin" /> : null}
              {isPaying ? "Funding…" : "Pay via escrow"}
            </button>
          </div>
        </div>
      )}

      {/* Pending but vendor view — show share affordance */}
      {invoice.status === 0 && isVendor && (
        <div className="rounded-2xl glass-card p-6">
          <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-2">
            Share this invoice
          </h3>
          <p className="text-sm text-[var(--text-primary)]/60 mb-4">
            Send this link to the client. They'll be able to pay via escrow
            without needing a Blank account or your address.
          </p>
          <CopyInvoiceLink chainId={linkChainId} invoiceId={invoiceId} variant="full" />
        </div>
      )}

      {/* PaymentPending — client finalizes */}
      {invoice.status === 3 && isClient && onActiveChain && (
        <div className="rounded-2xl glass-card p-6">
          <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-2">
            Finalize the payment
          </h3>
          <p className="text-sm text-[var(--text-primary)]/60 mb-4">
            Funds are in escrow. Finalizing decrypts the match check
            off-chain and releases to the vendor (or refunds you if the
            amount didn't match).
          </p>
          <button
            disabled={isReleasing}
            onClick={async () => {
              const r = await releaseEscrow(invoiceId);
              if (r) {
                toast.success(r.matched ? "Vendor paid" : "Refunded to you");
                setTick((t) => t + 1);
              }
            }}
            className="h-12 px-5 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {isReleasing ? <Loader2 size={16} className="animate-spin" /> : null}
            {isReleasing ? "Finalizing…" : "Finalize"}
          </button>
        </div>
      )}

      {/* PaymentPending — vendor view */}
      {invoice.status === 3 && isVendor && (
        <div className="rounded-2xl glass-card p-6">
          <p className="text-sm text-[var(--text-primary)]/60">
            Funds are in escrow. The client will finalize to release them
            to your wallet.
          </p>
        </div>
      )}

      {/* Paid — proof view */}
      {invoice.status === 1 && (
        <div className="rounded-2xl glass-card p-6" data-testid="proof-of-payment">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={18} className="text-emerald-600" />
            <h3 className="text-lg font-heading font-medium text-[var(--text-primary)]">
              Proof of payment
            </h3>
          </div>
          <p className="text-sm text-[var(--text-primary)]/60 mb-4">
            This invoice was settled via FHE-encrypted escrow. The amount
            stays private; the on-chain receipt is public.
          </p>

          {/* Receipt fields — pulled from the activity feed so we can
              link to the actual settlement tx, not just say "trust us". */}
          <div className="space-y-3 mb-4">
            <ReceiptRow label="Paid on" value={paidActivity ? formatTs(paidActivity.created_at) : "—"} />
            <ReceiptRow label="Vendor" value={truncateAddress(invoice.vendor)} mono />
            <ReceiptRow label="Client" value={truncateAddress(invoice.client)} mono />
            {paidActivity?.tx_hash && (
              <ReceiptRow
                label="Settlement tx"
                value={
                  <a
                    href={getExplorerTxUrl(paidActivity.tx_hash, linkChainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[var(--text-primary)] hover:underline inline-flex items-center gap-1"
                    data-testid="settlement-tx-link"
                  >
                    {paidActivity.tx_hash.slice(0, 10)}…{paidActivity.tx_hash.slice(-8)}
                    <ExternalLink size={12} />
                  </a>
                }
              />
            )}
            {fundedActivity?.tx_hash && fundedActivity.tx_hash !== paidActivity?.tx_hash && (
              <ReceiptRow
                label="Funding tx"
                value={
                  <a
                    href={getExplorerTxUrl(fundedActivity.tx_hash, linkChainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[var(--text-primary)]/60 hover:underline inline-flex items-center gap-1"
                  >
                    {fundedActivity.tx_hash.slice(0, 10)}…{fundedActivity.tx_hash.slice(-8)}
                    <ExternalLink size={12} />
                  </a>
                }
              />
            )}
          </div>

          {/* Share / save affordances. The same /app/invoice/... link
              is the receipt — no separate route needed; both parties
              can return to it as long as it's bookmarked. */}
          <div className="flex flex-wrap gap-2">
            <CopyInvoiceLink chainId={linkChainId} invoiceId={invoiceId} variant="full" />
            <button
              type="button"
              onClick={() => window.print()}
              className="h-9 px-3 rounded-lg bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-[var(--text-primary)] text-sm font-medium transition-colors flex items-center gap-2"
            >
              <FileText size={14} />
              Print receipt
            </button>
          </div>
        </div>
      )}

      {/* Cancelled / refunded */}
      {invoice.status === 2 && (
        <div className="rounded-2xl glass-card p-6">
          <p className="text-sm text-[var(--text-primary)]/60">
            This invoice was cancelled or refunded. No funds remain in
            escrow.
          </p>
        </div>
      )}

      {/* Disputed */}
      {invoice.status === 4 && (
        <div className="rounded-2xl glass-card p-6">
          <p className="text-sm text-[var(--text-primary)]/60 mb-2">
            This invoice was paid via the legacy direct-transfer path with
            a mismatched amount. The vendor must call <code>refundDisputedInvoice</code> to
            return the funds. The option is available in their Business Tools.
          </p>
          <a
            href="/app/business"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--text-primary)]/70 hover:text-[var(--text-primary)]"
          >
            Open Business Tools <ExternalLink size={12} />
          </a>
        </div>
      )}

      {/* Unauth visitor — show clear "connect to pay" CTA. The page is
          public so anyone with the link can view it; only the named
          client can fund the escrow. */}
      {!effectiveAddress && invoice.status === 0 && (
        <div className="rounded-2xl glass-card p-6" data-testid="connect-to-pay">
          <div className="flex items-center gap-2 mb-2">
            <Wallet size={18} className="text-[var(--text-primary)]/60" />
            <h3 className="text-lg font-heading font-medium text-[var(--text-primary)]">
              You're viewing as a guest
            </h3>
          </div>
          <p className="text-sm text-[var(--text-primary)]/60 mb-4">
            To pay this invoice, sign in with the wallet at{" "}
            <code className="font-mono text-xs">{truncateAddress(invoice.client)}</code>.
            The amount is encrypted on-chain. Only the vendor and that
            client can see it.
          </p>
          <a
            href="/app"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--text-primary)] text-white font-medium text-sm hover:opacity-90 transition-opacity"
          >
            Connect a wallet
          </a>
        </div>
      )}

      {/* Bystander view — authenticated but neither vendor nor client */}
      {effectiveAddress && !isVendor && !isClient && invoice.status === 0 && (
        <div className="rounded-2xl glass-card p-6" data-testid="bystander">
          <p className="text-sm text-[var(--text-primary)]/60">
            You're viewing this invoice as a bystander. Only the named
            client (<code className="font-mono">{truncateAddress(invoice.client)}</code>)
            can pay it.
          </p>
        </div>
      )}
    </Frame>
  );
}

// ─── Layout helpers ──────────────────────────────────────────────────

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl mx-auto px-4 sm:px-8 py-8">{children}</div>;
}

function CardError({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[2rem] glass-card p-8 text-center">
      <h2 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">
        {title}
      </h2>
      <p className="text-sm text-[var(--text-primary)]/60">{body}</p>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  italic,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  italic?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 p-4">
      <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1.5 flex items-center gap-1.5">
        {icon}
        {label}
      </p>
      <p
        className={`text-sm text-[var(--text-primary)] ${mono ? "font-mono" : ""} ${italic ? "italic text-[var(--text-primary)]/60" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

// Receipt-style row — label on the left, value (link or text) on the right.
// Used in the proof-of-payment panel.
function ReceiptRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-[var(--text-primary)]/50">{label}</span>
      <span
        className={`text-[var(--text-primary)] truncate ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
