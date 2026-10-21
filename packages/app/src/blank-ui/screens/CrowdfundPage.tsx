// Wave 4 task #257 — Public crowdfund campaign page (/fund/:chainId/:id).

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { usePublicClient } from "wagmi";
import {
  Megaphone, AlertCircle, Loader2, CheckCircle2, Clock,
  XCircle,
} from "lucide-react";

import { useCrowdfund } from "@/hooks/useCrowdfund";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { CONTRACTS_BY_CHAIN, type SupportedChainId } from "@/lib/constants";
import { EncryptedCrowdfundAbi } from "@/lib/abis";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";
import { cn } from "@/lib/cn";
import { classifyLoadError, type ClassifiedLoadError } from "@/lib/load-error";

const STATUS_OPEN = 0;
const STATUS_CLOSED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDING = 3;

// ContributionState: 0 Counted (also every pre-gate contribution), 1 PendingFunding, 2 Void.
const CONTRIBUTION_PENDING = 1;
const CONTRIBUTION_VOID = 2;

const CONTRIBUTED_EVENT = {
  type: "event",
  name: "Contributed",
  inputs: [
    { name: "campaignId", type: "uint256", indexed: true },
    { name: "contributor", type: "address", indexed: true },
    { name: "contributionIndex", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

interface MyContribution {
  index: number;
  refunded: boolean;
  /** claimRefund ran and its payout check is not published yet. */
  refundInFlight: boolean;
  /** Funding check never passed: nothing was locked, so nothing can be refunded. */
  unfunded: boolean;
}

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
  const {
    state, pipeline, contribute, closeCampaign, claimRelease, claimRefund,
    finishClosing, finishContribution, finishRefund,
  } = useCrowdfund();
  const { effectiveAddress } = useEffectiveAddress();

  const [onChain, setOnChain] = useState<OnChainCampaign | null>(null);
  const [contributionCount, setContributionCount] = useState(0);
  // Caller's contribution indices for this campaign (refunding phase only).
  // Replaces a window.prompt() that asked the user to type an index —
  // wrong taps cost gas + revealed the typed integer. §1.7 WAVE4_HALF_BAKED
  // #9.
  const [myContribs, setMyContribs] = useState<MyContribution[]>([]);
  const [myContribsLoaded, setMyContribsLoaded] = useState(false);
  // The viewer's contributions still waiting for their funding check. They do
  // not count until it is published, and anyone can publish it.
  const [myPending, setMyPending] = useState<number[]>([]);
  const [loadError, setLoadError] = useState<ClassifiedLoadError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [amount, setAmount] = useState("");
  const [releasePaid, setReleasePaid] = useState(false);

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
      setLoadError({ kind: "permanent", headline: "Unsupported chain", hint: "Blank only supports Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia for now.", rawCause: "" });
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

        // One release per campaign. Older deploys lack the getter; treat a
        // failed read as "unknown" and let the contract decide.
        try {
          const paid = await publicClient.readContract({
            address: contracts.EncryptedCrowdfund,
            abi: EncryptedCrowdfundAbi,
            functionName: "releasePaid",
            args: [BigInt(campaignId)],
          });
          if (!cancelled) setReleasePaid(Boolean(paid));
        } catch {
          if (!cancelled) setReleasePaid(false);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(classifyLoadError(err, { resourceName: "Campaign" }));
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, campaignId, publicClient, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setMyContribsLoaded(false);
    setMyContribs([]);
    setMyPending([]);
    if (
      !publicClient ||
      !onChain ||
      !effectiveAddress ||
      contributionCount <= 0 ||
      !(chainId in CONTRACTS_BY_CHAIN)
    ) {
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[chainId as SupportedChainId];
    if (!contracts.EncryptedCrowdfund) return;
    const me = effectiveAddress.toLowerCase();
    const cf = contracts.EncryptedCrowdfund;
    // Both views are missing on a contract from before the funding gate; a
    // failed read then means the contribution is counted and nothing is in flight.
    const readState = async (index: number) => {
      const [st, inFlight] = await Promise.allSettled([
        publicClient.readContract({ address: cf, abi: EncryptedCrowdfundAbi, functionName: "contributionState", args: [BigInt(campaignId), BigInt(index)] }),
        publicClient.readContract({ address: cf, abi: EncryptedCrowdfundAbi, functionName: "refundInFlight", args: [BigInt(campaignId), BigInt(index)] }),
      ]);
      return {
        state: st.status === "fulfilled" ? Number(st.value) || 0 : 0,
        refundInFlight: inFlight.status === "fulfilled" && inFlight.value === true,
      };
    };

    const refunding = onChain.status === STATUS_REFUNDING || (onChain.resultPublished && !onChain.goalMet);
    if (!refunding) {
      if (me === onChain.creator.toLowerCase()) return; // creators cannot contribute
      // Not refundable yet: only look for contributions stuck PendingFunding, via
      // the Contributed events of this contributor (one call, no per-index walk).
      (async () => {
        try {
          const logs = await publicClient.getLogs({
            address: cf,
            event: CONTRIBUTED_EVENT,
            args: { campaignId: BigInt(campaignId), contributor: effectiveAddress as `0x${string}` },
            fromBlock: "earliest",
            toBlock: "latest",
          });
          const pending: number[] = [];
          for (const log of logs) {
            const index = Number(log.args.contributionIndex);
            if ((await readState(index)).state === CONTRIBUTION_PENDING) pending.push(index);
          }
          if (!cancelled) setMyPending(pending);
        } catch {
          // No log access: the contribution can still be finished from the refund list later.
        }
      })();
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const collected: MyContribution[] = [];
        for (let i = 0; i < contributionCount; i++) {
          const result = (await publicClient.readContract({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "getContribution",
            args: [BigInt(campaignId), BigInt(i)],
          })) as readonly [`0x${string}`, boolean];
          if (cancelled) return;
          if (result[0].toLowerCase() === me) {
            const gate = await readState(i);
            collected.push({
              index: i,
              refunded: result[1],
              refundInFlight: gate.refundInFlight,
              unfunded: gate.state === CONTRIBUTION_VOID,
            });
          }
        }
        if (!cancelled) {
          setMyContribs(collected);
          setMyContribsLoaded(true);
        }
      } catch {
        if (!cancelled) setMyContribsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, onChain, effectiveAddress, contributionCount, chainId, campaignId, reloadKey]);

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
  if ((state.step === "success" || state.step === "funding") && state.funding === "pending" && state.lastContributionIndex != null) {
    const index = state.lastContributionIndex;
    return (
      <CenterCard>
        <IconBubble color="bg-amber-50" icon={<Clock size={32} className="text-amber-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Confirming your contribution</h1>
        <p className="text-[var(--text-secondary)] mb-6" data-testid="contribution-pending">
          Contribution #{index} is on-chain, but it does not count until your private balance is checked once.
          Finish that check now, or come back to this page later.
        </p>
        {state.error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 text-amber-800 text-sm text-left">{state.error}</div>
        )}
        <button
          onClick={() => finishContribution(campaignId, index)}
          disabled={state.isProcessing}
          className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
        >
          {state.isProcessing ? "Confirming…" : "Finish contribution"}
        </button>
      </CenterCard>
    );
  }
  if (state.step === "success") {
    return (
      <CenterCard>
        <IconBubble color="bg-emerald-50" icon={<CheckCircle2 size={32} className="text-emerald-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Contribution submitted</h1>
        <p className="text-[var(--text-secondary)] mb-6">
          {state.funding === "funded"
            ? "Your encrypted contribution is on-chain and counted. Only you can decrypt your amount."
            : "Your encrypted contribution is on-chain. Only you can decrypt your amount."}
        </p>
        <a href="/app" className="inline-block px-6 h-12 leading-[3rem] rounded-2xl bg-[#1D1D1F] text-white font-medium">
          Open Blank
        </a>
      </CenterCard>
    );
  }

  const viewerIsCreator =
    !!effectiveAddress && effectiveAddress.toLowerCase() === onChain.creator.toLowerCase();
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
        {" "}Nobody can decrypt the goal or the running total while the campaign is open.
        {" "}At close, only the yes/no goal result is published and only the creator can read the total.
      </p>

      {phase === "open" && (
        <ContributeForm
          remaining={remaining}
          days={days}
          hours={hours}
          amount={amount}
          setAmount={setAmount}
          isProcessing={state.isProcessing}
          confirming={state.step === "funding"}
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
          onClick={async () => { if (await closeCampaign(campaignId)) setReloadKey((k) => k + 1); }}
          icon={<Clock size={14} />}
        />
      )}

      {phase === "needsPublish" && (
        <SimpleAction
          headline="Closed, verdict not published"
          body="The encrypted goal comparison finished on-chain. Its yes/no result has to be decrypted and published once before the creator can release the pool or contributors can claim refunds. Anyone can do this."
          ctaLabel="Finish closing"
          isProcessing={state.isProcessing}
          onClick={async () => { if (await finishClosing(campaignId)) setReloadKey((k) => k + 1); }}
          icon={<Clock size={14} />}
        />
      )}

      {phase === "released" && releasePaid && (
        <div
          data-testid="crowdfund-released"
          className="text-left px-4 py-3 rounded-xl bg-emerald-50 text-emerald-700 text-sm flex items-start gap-2"
        >
          <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
          <span>Goal met. The creator has received the pool.</span>
        </div>
      )}

      {phase === "released" && !releasePaid && viewerIsCreator && (
        <SimpleAction
          headline="Goal met. Campaign succeeded"
          body="You can pull the entire pool once. After that the campaign is settled."
          ctaLabel="Claim the pool"
          isProcessing={state.isProcessing}
          onClick={async () => { if (await claimRelease(campaignId)) setReloadKey((k) => k + 1); }}
          icon={<CheckCircle2 size={14} className="text-emerald-600" />}
        />
      )}

      {phase === "released" && !releasePaid && !viewerIsCreator && (
        <div className="text-left px-4 py-3 rounded-xl bg-emerald-50 text-emerald-700 text-sm flex items-start gap-2">
          <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
          <span>
            Goal met. The creator can now claim the pool. Your reward is whatever the creator
            listed when launching the campaign.
          </span>
        </div>
      )}

      {phase !== "refunding" && myPending.length > 0 && (
        <div data-testid="my-pending-contribs" className="mt-4 space-y-2 text-left">
          <div className="px-4 py-3 rounded-xl bg-amber-50 text-amber-800 text-sm">
            {myPending.length === 1 ? "A contribution of yours is" : "Some contributions of yours are"} waiting for the funding
            check and not counted yet.
          </div>
          {myPending.map((index) => (
            <button
              key={index}
              onClick={async () => { if (await finishContribution(campaignId, index)) setReloadKey((k) => k + 1); }}
              disabled={state.isProcessing}
              className="w-full h-12 px-4 rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] disabled:opacity-40 flex items-center justify-between text-sm"
            >
              <span>Contribution #{index}</span>
              <span className="text-xs text-[var(--text-primary)] font-medium">
                {state.isProcessing ? "Confirming…" : "Finish"}
              </span>
            </button>
          ))}
        </div>
      )}

      {phase === "refunding" && (
        <div className="text-left">
          <div className="px-4 py-3 rounded-xl bg-amber-50 text-amber-700 mb-4 text-sm flex items-start gap-2">
            <XCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Goal not met. Each contributor can pull their amount back.</span>
          </div>
          {!effectiveAddress ? (
            <div className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
              Connect your wallet to see your contributions.
            </div>
          ) : !myContribsLoaded ? (
            <div className="w-full h-12 rounded-2xl border border-[var(--border)] flex items-center justify-center text-sm text-[var(--text-secondary)]">
              <Loader2 size={14} className="animate-spin mr-2" /> Checking your contributions…
            </div>
          ) : myContribs.length === 0 ? (
            <div className="w-full px-4 py-3 rounded-2xl border border-[var(--border)] text-sm text-[var(--text-secondary)] text-center">
              You didn't contribute to this campaign.
            </div>
          ) : (
            <div className="space-y-2" data-testid="my-contribs-list">
              <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                Your contributions
              </div>
              {myContribs.map((c) => {
                const inactive = c.refunded || c.unfunded;
                return (
                  <button
                    key={c.index}
                    onClick={async () => {
                      if (c.refundInFlight) await finishRefund(campaignId, c.index);
                      else await claimRefund(campaignId, c.index);
                      setReloadKey((k) => k + 1);
                    }}
                    disabled={state.isProcessing || inactive}
                    title={c.unfunded ? "This contribution never locked funds, so there is nothing to refund" : undefined}
                    className="w-full h-12 px-4 rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] disabled:opacity-40 flex items-center justify-between text-sm"
                  >
                    <span>Contribution #{c.index}</span>
                    <span className={cn("text-xs", inactive ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)] font-medium")}>
                      {c.refunded
                        ? "Refunded"
                        : c.unfunded
                          ? "Not funded"
                          : c.refundInFlight
                            ? state.isProcessing ? "Confirming…" : "Finish refund"
                            : state.isProcessing ? "Refunding…" : "Refund"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
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
  confirming?: boolean;
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
        {props.isProcessing ? (props.confirming ? "Confirming funding…" : "Submitting…") : "Contribute privately"}
      </button>
      <p className="text-xs text-[var(--text-secondary)] mt-3">
        Your contribution is FHE-encrypted before it leaves your browser. Nobody, not even the creator, sees the amount.
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
