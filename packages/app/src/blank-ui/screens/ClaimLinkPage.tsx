import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Link2, Mail, Lock, AlertCircle, Loader2, CheckCircle2, Clock } from "lucide-react";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useClaimLinks } from "@/hooks/useClaimLinks";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { MODE, type LinkMode, parseClaimUrl } from "@/lib/claim-links";
import { CONTRACTS_BY_CHAIN, type SupportedChainId } from "@/lib/constants";
import { ClaimLinksAbi } from "@/lib/abis";
import { FhePipelineProgress } from "@/components/payment/FhePipelineProgress";
import { classifyLoadError, type ClassifiedLoadError } from "@/lib/load-error";

interface OnChainLink {
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

const MODE_LABEL: Record<LinkMode, string> = {
  [MODE.Bearer]: "Open link. Anyone can claim",
  [MODE.EmailBound]: "Email-protected link",
  [MODE.AddressBound]: "Address-protected link",
};

export default function ClaimLinkPage() {
  const params = useParams<{ chainId: string; linkId: string }>();
  const chainId = params.chainId ? Number(params.chainId) : NaN;
  const linkId = params.linkId ? Number(params.linkId) : NaN;
  const publicClient = usePublicClient({ chainId });

  // Parse the URL fragment for mode + secret. We re-build a synthetic URL
  // from the current location so parseClaimUrl can do its thing in one place.
  const parsed = useMemo(() => {
    if (typeof window === "undefined") return null;
    return parseClaimUrl(window.location.href);
  }, []);

  const [onChain, setOnChain] = useState<OnChainLink | null>(null);
  const [loadError, setLoadError] = useState<ClassifiedLoadError | null>(null);
  // Bumping reloadKey re-runs the on-chain read. Used by the retry CTA
  // on transient errors. The classifier defaults unknown errors to
  // transient so users always have a path forward on infra issues.
  const [reloadKey, setReloadKey] = useState(0);
  const [email, setEmail] = useState("");
  const { state, pipeline, claim } = useClaimLinks();
  // Passkey-aware address resolution: passkey-only users have no wagmi
  // address but still have a smart-account address. Use the same hook
  // every other screen uses so AddressBound links behave consistently.
  const { effectiveAddress } = useEffectiveAddress();

  // Load the on-chain link metadata. Re-runs when reloadKey bumps (the
  // retry CTA on transient errors triggers this).
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setOnChain(null);
    // Reject non-integers AND non-finite. BigInt(1.5) throws a
    // RangeError which the catch-block below classifies as transient
    // ("retry?") — surfacing wrong-shape URLs as permanent errors up
    // here is the correct user signal.
    if (
      !Number.isFinite(chainId) ||
      !Number.isFinite(linkId) ||
      !Number.isInteger(chainId) ||
      !Number.isInteger(linkId) ||
      linkId < 0 ||
      chainId < 0
    ) {
      setLoadError({
        kind: "permanent",
        headline: "Invalid link",
        hint: "The chain id or link id in the URL isn't a valid positive integer.",
        rawCause: "",
      });
      return;
    }
    if (!(chainId in CONTRACTS_BY_CHAIN)) {
      setLoadError({
        kind: "permanent",
        headline: "Unsupported chain",
        hint: "Blank only supports Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia for now.",
        rawCause: "",
      });
      return;
    }
    const contracts = CONTRACTS_BY_CHAIN[chainId as SupportedChainId];
    if (!contracts.ClaimLinks || contracts.ClaimLinks === "0x0000000000000000000000000000000000000000") {
      setLoadError({
        kind: "permanent",
        headline: "Claim links not available on this chain yet",
        hint: "This chain doesn't have the ClaimLinks contract deployed.",
        rawCause: "",
      });
      return;
    }
    if (!publicClient) return;

    (async () => {
      try {
        const result = await publicClient.readContract({
          address: contracts.ClaimLinks,
          abi: ClaimLinksAbi,
          functionName: "getLink",
          args: [BigInt(linkId)],
        });
        if (cancelled) return;
        const [
          sender, vault, mode, boundAddress, createdAt, expiryTimestamp,
          claimed, refunded, note, claimer, claimedAt,
        ] = result as readonly [
          `0x${string}`, `0x${string}`, number, `0x${string}`, bigint, bigint,
          boolean, boolean, string, `0x${string}`, bigint,
        ];
        if (sender === "0x0000000000000000000000000000000000000000") {
          setLoadError({
            kind: "permanent",
            headline: "Link not found",
            hint: "Check the chain you're on, or the link id in the URL.",
            rawCause: "",
          });
          return;
        }
        setOnChain({ sender, vault, mode, boundAddress, createdAt, expiryTimestamp, claimed, refunded, note, claimer, claimedAt });
      } catch (err) {
        if (cancelled) return;
        setLoadError(classifyLoadError(err, { resourceName: "Link" }));
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, linkId, publicClient, reloadKey]);

  const status = useMemo(() => {
    if (!onChain) return "loading";
    if (onChain.claimed) return "claimed";
    if (onChain.refunded) return "refunded";
    if (Number(onChain.expiryTimestamp) * 1000 < Date.now()) return "expired";
    return "claimable";
  }, [onChain]);

  // AddressBound links are locked to a specific wallet on chain. Without
  // a pre-check, a different connected wallet would click Claim, eat
  // FHE encryption + gas, then revert with an opaque ClaimLinks error.
  // Fail fast with a clear message instead. Bearer + EmailBound modes
  // are unaffected (bound to a secret or email, not an address).
  const wrongWallet = useMemo(() => {
    if (!onChain || !parsed) return false;
    if (parsed.mode !== MODE.AddressBound) return false;
    if (!effectiveAddress) return false;
    return effectiveAddress.toLowerCase() !== onChain.boundAddress.toLowerCase();
  }, [onChain, parsed, effectiveAddress]);

  const handleClaim = async () => {
    if (!parsed) {
      toast.error("Invalid link. Secret missing");
      return;
    }
    if (parsed.mode === MODE.EmailBound && !email) {
      toast.error("Enter your email to claim");
      return;
    }
    if (wrongWallet && onChain) {
      const short = `${onChain.boundAddress.slice(0, 6)}…${onChain.boundAddress.slice(-4)}`;
      toast.error(`This link is locked to wallet ${short}. Connect that wallet to claim.`);
      return;
    }
    await claim({
      linkId: parsed.linkId,
      mode: parsed.mode,
      secret: parsed.secret,
      email: parsed.mode === MODE.EmailBound ? email : undefined,
    });
  };

  // ─── render states ────────────────────────────────────────────────

  // Order matters: a missing #fragment is a more specific UX error than
  // "Link not found" (the user has a broken URL, not a wrong linkId), so
  // surface it FIRST regardless of whether the on-chain lookup also failed.
  if (!parsed) {
    return (
      <CenterCard>
        <IconBubble color="bg-amber-50" icon={<AlertCircle size={32} className="text-amber-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Missing secret</h1>
        <p className="text-[var(--text-secondary)]">
          This link is missing its secret part (the # at the end). Make sure you opened the
          full URL exactly as it was sent.
        </p>
      </CenterCard>
    );
  }

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
          <a
            href="/"
            className="inline-block px-6 h-12 leading-[3rem] rounded-2xl border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
          >
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

  if (status === "loading") {
    return (
      <CenterCard>
        <Loader2 size={32} className="animate-spin text-[var(--text-secondary)] mb-4" />
        <p className="text-[var(--text-secondary)]">Loading link…</p>
      </CenterCard>
    );
  }

  if (status === "claimed") {
    return (
      <CenterCard>
        <IconBubble color="bg-emerald-50" icon={<CheckCircle2 size={32} className="text-emerald-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Already claimed</h1>
        <p className="text-[var(--text-secondary)]">
          Someone has already claimed this link. Each link can be used only once.
        </p>
      </CenterCard>
    );
  }
  if (status === "refunded") {
    return (
      <CenterCard>
        <IconBubble color="bg-slate-100" icon={<Lock size={32} className="text-slate-500" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Link refunded</h1>
        <p className="text-[var(--text-secondary)]">
          The sender pulled the funds back. Ask them for a new one.
        </p>
      </CenterCard>
    );
  }
  if (status === "expired") {
    return (
      <CenterCard>
        <IconBubble color="bg-amber-50" icon={<Clock size={32} className="text-amber-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Link expired</h1>
        <p className="text-[var(--text-secondary)]">
          The claim window passed. The sender can refund the funds and create a new link.
        </p>
      </CenterCard>
    );
  }

  // claimable
  if (state.step === "success") {
    return (
      <CenterCard>
        <IconBubble color="bg-emerald-50" icon={<CheckCircle2 size={32} className="text-emerald-600" />} />
        <h1 className="text-2xl font-heading font-semibold mb-3">Claimed</h1>
        <p className="text-[var(--text-secondary)] mb-6">
          The encrypted balance is now in your account.
        </p>
        <a href="/app" className="inline-block px-6 h-12 leading-[3rem] rounded-2xl bg-[#1D1D1F] text-white font-medium">
          Open Blank
        </a>
      </CenterCard>
    );
  }

  return (
    <CenterCard>
      <IconBubble color="bg-blue-50" icon={<Link2 size={32} className="text-blue-600" />} />
      <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] mb-2">
        {MODE_LABEL[parsed.mode]}
      </div>
      <h1 className="text-2xl font-heading font-semibold mb-3">You have a private payment</h1>
      {onChain?.note && (
        <p className="text-[var(--text-secondary)] mb-2">"{onChain.note}"</p>
      )}
      <p className="text-sm text-[var(--text-secondary)] mb-6">
        From <span className="font-mono">{onChain?.sender.slice(0, 6)}…{onChain?.sender.slice(-4)}</span>.
        Amount stays encrypted until you claim.
      </p>

      {parsed.mode === MODE.EmailBound && (
        <div className="mb-4 text-left">
          <label className="block text-sm font-medium mb-2 text-[var(--text-secondary)]">
            <Mail size={14} className="inline mr-1" /> Confirm your email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full h-12 rounded-xl border border-[var(--border)] bg-transparent px-3 focus:border-[var(--border-strong)] focus:outline-none"
          />
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Only the email the sender used will succeed.
          </p>
        </div>
      )}

      {wrongWallet && onChain && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 text-amber-700 text-sm text-left" role="alert" aria-label="Wrong wallet">
          <strong className="block mb-1">This link is locked to a different wallet.</strong>
          Connect{" "}
          <span className="font-mono">{onChain.boundAddress.slice(0, 6)}…{onChain.boundAddress.slice(-4)}</span>
          {" "}to claim.
        </div>
      )}

      {pipeline.phase !== "idle" && (
        <div className="mb-4 text-left">
          <FhePipelineProgress state={pipeline} compact />
        </div>
      )}

      {state.error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-700 text-sm text-left">
          {state.error}
        </div>
      )}

      <button
        onClick={handleClaim}
        disabled={state.isProcessing || wrongWallet}
        className="w-full h-14 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black transition-colors disabled:opacity-40"
      >
        {state.isProcessing ? "Claiming…" : "Claim private payment"}
      </button>
      <p className="text-xs text-[var(--text-secondary)] mt-3">
        Expires {onChain ? new Date(Number(onChain.expiryTimestamp) * 1000).toLocaleString() : ""}.
      </p>
    </CenterCard>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center px-6">
      <div className="glass-card-static rounded-[2rem] p-10 max-w-md w-full text-center">
        {children}
      </div>
    </div>
  );
}

function IconBubble({ color, icon }: { color: string; icon: React.ReactNode }) {
  return (
    <div className={`w-16 h-16 rounded-2xl ${color} flex items-center justify-center mx-auto mb-6`}>
      {icon}
    </div>
  );
}
