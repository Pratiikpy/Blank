// Wave 4 task #257 — Public crowdfund campaign page (/fund/:chainId/:id).

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import {
  Megaphone, AlertCircle, Loader2, CheckCircle2, Clock,
  XCircle,
} from "lucide-react";

import { useCrowdfund } from "@/hooks/useCrowdfund";
import { CONTRACTS_BY_CHAIN, type SupportedChainId } from "@/lib/constants";
import { EncryptedCrowdfundAbi } from "@/lib/abis";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";
import { cn } from "@/lib/cn";
import { classifyLoadError, type ClassifiedLoadError } from "@/lib/load-error";

const STATUS_OPEN = 0;
const STATUS_CLOSED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDING = 3;

interface OnChainCampaign {
  creator: `0x${string}`;
  vault: `0x${string}`;
  deadline: bigint;
  status: number;
  goalMet: boolean;
  resultPublished: boolean;
  title: string;
  descriptionCidHash: `0x${string}`;
  createdAt: bigint;
}

export default function CrowdfundPage() {
  const params = useParams<{ chainId: string; campaignId: string }>();
  const chainId = params.chainId ? Number(params.chainId) : NaN;
  const campaignId = params.campaignId ? Number(params.campaignId) : NaN;
  const publicClient = usePublicClient({ chainId });
  const { state, pipeline, contribute, closeCampaign, claimRelease, claimRefund } = useCrowdfund();

  const [onChain, setOnChain] = useState<OnChainCampaign | null>(null);
  const [contributionCount, setContributionCount] = useState(0);
  const [loadError, setLoadError] = useState<ClassifiedLoadError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [amount, setAmount] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setOnChain(null);
    if (
      !Number.isFinite(chainId) ||
      !Number.isFinite(campaignId) ||
      !Number.isInteger(chainId) ||
      !Number.isInteger(campaignId) ||
      chainId < 0 ||
      campaignId < 0
    ) {
      // Same hardening as ClaimLinkPage + StorefrontPage: reject 1.5,
      // negatives, 1e21. BigInt() on a non-integer throws RangeError
      // which the catch-block classifier turns into a transient
      // "retry?" error — wrong UX signal for malformed URLs.
      setLoadError({ kind: "permanent", headline: "Invalid URL", hint: "The chain id or campaign id in the URL isn't a valid positive integer.", rawCause: "" });
      return;
    }
    if (!(chainId in CONTRACTS_BY_CHAIN)) {
      setLoadError({ kind: "permanent", headline: "Unsupported chain", hint: "Blank only supports Ethereum Sepolia and Base Sepolia for now.", rawCause: "" });
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[chainId as SupportedChainId];
    if (!contracts.EncryptedCrowdfund || contracts.EncryptedCrowdfund === "0x0000000000000000000000000000000000000000") {
      setLoadError({ kind: "permanent", headline: "Crowdfund not deployed on this chain yet", hint: "This chain doesn't have the EncryptedCrowdfund contract deployed.", rawCause: "" });
      return;
    }
    if (!publicClient) return;

    (async () => {
      try {
        const result = await publicClient.readContract({
          address: contracts.EncryptedCrowdfund,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCampaign",
          args: [BigInt(campaignId)],
        });
        if (cancelled) return;
        const [creator, vault, deadline, status, goalMet, resultPublished, title, descriptionCidHash, createdAt] = result as readonly [
          `0x${string}`, `0x${string}`, bigint, number, boolean, boolean, string, `0x${string}`, bigint,
        ];
        if (creator === "0x0000000000000000000000000000000000000000") {
          setLoadError({ kind: "permanent", headline: "Campaign not found", hint: "Check the chain you're on, or the campaign id in the URL.", rawCause: "" });
          return;
        }
        setOnChain({ creator, vault, deadline, status, goalMet, resultPublished, title, descriptionCidHash, createdAt });

        const count = await publicClient.readContract({
          address: contracts.EncryptedCrowdfund,
          abi: EncryptedCrowdfundAbi,
          functionName: "getContributionCount",
          args: [BigInt(campaignId)],
        });
        if (!cancelled) setContributionCount(Number(count));
      } catch (err) {
        if (cancelled) return;
        setLoadError(classifyLoadError(err, { resourceName: "Campaign" }));
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, campaignId, publicClient, reloadKey]);

  const phase = useMemo(() => {
    if (!onChain) return "loading";
    const now = Math.floor(Date.now() / 1000);
    const deadline = Number(onChain.deadline);
    if (onChain.status === STATUS_OPEN && now < deadline) return "open";
    if (onChain.status === STATUS_OPEN && now >= deadline) return "needsClose";
    if (onChain.status === STATUS_CLOSED && !onChain.resultPublished) return "needsPublish";
    if (onChain.status === STATUS_RELEASED || (onChain.resultPublished && onChain.goalMet)) return "released";
    if (onChain.status === STATUS_REFUNDING || (onChain.resultPublished && !onChain.goalMet)) return "refunding";
    return "unknown";
  }, [onChain]);

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
        <p className="text-[var(--text-secondary)]">Loading campaign…</p>
      </CenterCard>
    );
  }
  if (state.step === "success") {
    return (
      <CenterCard>
        <IconBubble color="bg-emerald-50" icon={<CheckCircle2 size={32} className="text-emerald-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Contribution submitted</h1>
        <p className="text-[var(--text-secondary)] mb-6">Your encrypted contribution is on-chain. Amount stays private until the campaign closes.</p>
        <a href="/app" className="inline-block px-6 h-12 leading-[3rem] rounded-2xl bg-[#1D1D1F] text-white font-medium">
          Open Blank
        </a>
      </CenterCard>
    );
  }

  const remaining = Math.max(0, Number(onChain.deadline) - Math.floor(Date.now() / 1000));
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);

  return (
    <CenterCard>
      <IconBubble color="bg-violet-50" icon={<Megaphone size={32} className="text-violet-600" />} />
      <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] mb-2">
        Encrypted crowdfund
      </div>
      <h1 className="text-2xl font-heading font-semibold mb-3">{onChain.title}</h1>
      <p className="text-sm text-[var(--text-secondary)] mb-6">
        From <span className="font-mono">{onChain.creator.slice(0, 6)}…{onChain.creator.slice(-4)}</span> ·
        {" "}{contributionCount} contribution{contributionCount === 1 ? "" : "s"} so far.
        {" "}Goal + total raised stay encrypted until the deadline.
      </p>

      {phase === "open" && (
        <ContributeForm
          remaining={remaining}
          days={days}
          hours={hours}
          amount={amount}
          setAmount={setAmount}
          isProcessing={state.isProcessing}
          onSubmit={() => contribute({
            campaignId,
            vault: onChain.vault,
            amountTokens: amount,
            decimals: 6,
          })}
        />
      )}

      {phase === "needsClose" && (
        <SimpleAction
          headline="Deadline reached"
          body="Anyone can finalize the campaign. Once closed, the goal-met verdict is published."
          ctaLabel="Close campaign"
          isProcessing={state.isProcessing}
          onClick={() => closeCampaign(campaignId)}
          icon={<Clock size={14} />}
        />
      )}

      {phase === "needsPublish" && (
        <SimpleAction
          headline="Decrypting the goal-met answer"
          body="The encrypted comparison finished on-chain. Fhenix is decrypting the verdict (goal hit or missed). This usually takes 10-30 seconds. Refresh after a moment."
          ctaLabel="Refresh"
          isProcessing={false}
          onClick={() => location.reload()}
        />
      )}

      {phase === "released" && (
        <SimpleAction
          headline="Goal met. Campaign succeeded"
          body="The creator can pull the entire pool. The reward you'll receive is whatever the creator listed when launching the campaign."
          ctaLabel="Creator: claim release"
          isProcessing={state.isProcessing}
          onClick={() => claimRelease(campaignId)}
          icon={<CheckCircle2 size={14} className="text-emerald-600" />}
        />
      )}

      {phase === "refunding" && (
        <div className="text-left">
          <div className="px-4 py-3 rounded-xl bg-amber-50 text-amber-700 mb-4 text-sm flex items-start gap-2">
            <XCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Goal not met. Each contributor can pull their amount back.</span>
          </div>
          <button
            onClick={() => {
              const raw = prompt("Your contribution index (check your wallet history):");
              if (raw === null) return; // user cancelled
              const trimmed = raw.trim();
              if (trimmed === "") {
                toast.error("Contribution index required");
                return;
              }
              const idx = Number.parseInt(trimmed, 10);
              if (!Number.isFinite(idx) || idx < 0 || String(idx) !== trimmed) {
                toast.error("Contribution index must be a non-negative integer");
                return;
              }
              claimRefund(campaignId, idx);
            }}
            disabled={state.isProcessing}
            className="w-full h-12 rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] disabled:opacity-40"
          >
            Refund my contribution
          </button>
        </div>
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

function ContributeForm(props: {
  remaining: number;
  days: number;
  hours: number;
  amount: string;
  setAmount: (v: string) => void;
  isProcessing: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="text-left">
      <div className="flex items-center gap-2 mb-4 text-sm text-[var(--text-secondary)]">
        <Clock size={14} />
        <span>{props.days > 0 ? `${props.days}d ` : ""}{props.hours}h left to contribute</span>
      </div>
      <label className="block text-sm font-medium mb-2">Your contribution (USDC)</label>
      <input
        type="text"
        value={props.amount}
        onChange={(e) => props.setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="any amount"
        className="w-full h-12 rounded-xl border border-[var(--border)] bg-transparent px-3 focus:border-[var(--border-strong)] focus:outline-none"
      />
      <button
        onClick={props.onSubmit}
        disabled={props.isProcessing || !props.amount || Number.parseFloat(props.amount) <= 0}
        className="mt-4 w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
      >
        {props.isProcessing ? "Submitting…" : "Contribute privately"}
      </button>
      <p className="text-xs text-[var(--text-secondary)] mt-3">
        Your contribution is FHE-encrypted before it leaves your browser. Nobody — not even the creator — sees the amount.
      </p>
    </div>
  );
}

function SimpleAction(props: {
  headline: string;
  body: string;
  ctaLabel: string;
  isProcessing: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="text-left">
      <div className="flex items-center gap-2 mb-2 text-sm font-medium text-[var(--text-primary)]">
        {props.icon}
        <span>{props.headline}</span>
      </div>
      <p className="text-sm text-[var(--text-secondary)] mb-4">{props.body}</p>
      <button
        onClick={props.onClick}
        disabled={props.isProcessing}
        className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
      >
        {props.isProcessing ? "Processing…" : props.ctaLabel}
      </button>
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="glass-card-static rounded-[2rem] p-10 max-w-md w-full text-center">{children}</div>
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
