import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertCircle,
  ShieldCheck,
  ArrowRight,
  Twitter,
} from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { useQualificationProof, type ProofRecord } from "@/hooks/useQualificationProof";
import { useChain } from "@/providers/ChainProvider";
import "./landing.css";
import "./how-it-works.css";
import "./verify.css";

// ───────────────────────────────────────────────────────────────────
//  Verify — public page that resolves /verify/:proofId
//
//  Three states:
//   1. Proof is already published on-chain → show verdict immediately.
//   2. Proof exists but not published yet → show "Publish on-chain" CTA
//      that anyone (with a connected wallet) can click to finalize.
//   3. Proof not found / invalid id → 404-ish error.
// ───────────────────────────────────────────────────────────────────

export default function Verify() {
  const { proofId: proofIdStr } = useParams<{ proofId: string }>();
  const { isConnected } = useAccount();
  const { activeChain } = useChain();
  const { fetchProof, publishProof, step } = useQualificationProof();

  const [proof, setProof] = useState<ProofRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rpcError, setRpcError] = useState<string | null>(null);

  const proofIdBigInt = (() => {
    try {
      return proofIdStr ? BigInt(proofIdStr) : null;
    } catch {
      return null;
    }
  })();

  const refresh = useCallback(async () => {
    if (proofIdBigInt === null) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const p = await fetchProof(proofIdBigInt);
      setRpcError(null);
      if (!p) {
        setNotFound(true);
      } else {
        setProof(p);
        setNotFound(false);
      }
    } catch {
      setRpcError("Network error — try again");
      setNotFound(false);
      setProof(null);
    }
    setLoading(false);
  }, [proofIdBigInt, fetchProof]);

  useEffect(() => {
    setProof(null);
    setNotFound(false);
    setRpcError(null);
    setLoading(true);
    refresh();
  }, [refresh]);

  const handlePublish = useCallback(async () => {
    if (proofIdBigInt === null) return;
    const ok = await publishProof(proofIdBigInt);
    if (ok) await refresh();
  }, [proofIdBigInt, publishProof, refresh]);

  const verifying = step === "decrypting" || step === "publishing";

  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-page-hero">
          <div className="ll-section-kicker">Encrypted proof</div>
          <h1 className="ll-section-title">
            {loading
              ? "Loading proof..."
              : rpcError
                ? "Network error"
                : notFound
                  ? "Proof not found"
                  : proof?.isReady
                    ? proof.isTrue
                      ? "Verified ✓"
                      : "Not verified ✗"
                    : "Pending verification"}
          </h1>
        </section>

        <section className="ll-section verify-section">
          {loading && (
            <div className="verify-state">
              <Loader2 size={36} className="animate-spin opacity-40" />
              <p>Reading proof from chain…</p>
            </div>
          )}

          {!loading && rpcError && (
            <div className="verify-state">
              <AlertCircle size={36} className="text-red-500" />
              <p>{rpcError}</p>
              <p className="verify-hint">
                We couldn't reach <strong>{activeChain.name}</strong> to read
                this proof. Check your connection and try again.
              </p>
              <button className="ll-btn ll-btn--ghost" onClick={refresh}>
                Retry
              </button>
            </div>
          )}

          {!loading && !rpcError && notFound && (
            <div className="verify-state">
              <AlertCircle size={36} className="text-red-500" />
              <p>
                Proof <code>{proofIdStr}</code> doesn't exist on{" "}
                <strong>{activeChain.name}</strong>.
              </p>
              <p className="verify-hint">
                Check the link, or switch to the chain where the proof was
                created. Each proof lives on a single chain.
              </p>
              <Link to="/" className="ll-btn ll-btn--ghost">
                Back to Blank
              </Link>
            </div>
          )}

          {!loading && !rpcError && !notFound && proof && (
            <div className="verify-card">
              <div
                className={
                  "verify-verdict " +
                  (!proof.isReady
                    ? "is-pending"
                    : proof.isTrue
                      ? "is-true"
                      : "is-false")
                }
              >
                {!proof.isReady ? (
                  <Clock size={40} />
                ) : proof.isTrue ? (
                  <CheckCircle2 size={40} />
                ) : (
                  <XCircle size={40} />
                )}
                <div className="verify-verdict-text">
                  <div className="verify-claim">
                    Income ≥ $
                    {(Number(proof.threshold) / 1_000_000).toLocaleString()}
                  </div>
                  <div className="verify-status">
                    {!proof.isReady
                      ? "Not yet published — anyone can finalize on-chain"
                      : proof.isTrue
                        ? "Confirmed by Fhenix Threshold Network"
                        : "Disproven by Fhenix Threshold Network"}
                  </div>
                </div>
              </div>

              <div className="verify-meta">
                <div>
                  <span className="verify-meta-label">Prover</span>
                  <code className="verify-meta-value">{proof.prover}</code>
                </div>
                <div>
                  <span className="verify-meta-label">Block</span>
                  <a
                    className="verify-meta-value"
                    href={`${activeChain.explorerUrl}/block/${proof.blockNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{proof.blockNumber.toString()}
                  </a>
                </div>
                <div>
                  <span className="verify-meta-label">Created</span>
                  <span className="verify-meta-value">
                    {new Date(Number(proof.timestamp) * 1000).toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="verify-meta-label">Network</span>
                  <span className="verify-meta-value">{activeChain.name}</span>
                </div>
              </div>

              {!proof.isReady && (
                <div className="verify-publish">
                  {!isConnected ? (
                    <p className="verify-hint">
                      Connect a wallet to publish the verdict on-chain. Anyone
                      can do this — no special permission needed. Gas: ~0.0001 ETH.
                    </p>
                  ) : (
                    <button
                      className="ll-btn ll-btn--hero ll-btn--ink"
                      onClick={handlePublish}
                      disabled={verifying}
                    >
                      {verifying ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          {step === "decrypting" ? "Decrypting..." : "Publishing..."}
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={16} /> Verify on-chain
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}

              {proof.isReady && (
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                    proof.isTrue
                      ? `Verified on-chain via @blank: this proof of "income ≥ $${(Number(proof.threshold) / 1_000_000).toLocaleString()}" is TRUE — without revealing the actual amount. ${window.location.href}`
                      : `Verified on-chain via @blank: this proof is FALSE — and no amount was leaked. Just the boolean answer. ${window.location.href}`,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ll-btn ll-btn--hero"
                  style={{ background: "#0f1419", color: "white" }}
                >
                  <Twitter size={14} /> Share on X
                </a>
              )}

              <div className="verify-actions">
                <Link to="/how-it-works" className="ll-btn ll-btn--ghost">
                  How does this work?
                </Link>
                <Link to="/app/proofs" className="ll-btn ll-btn--ink">
                  Create your own proof <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          )}
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
