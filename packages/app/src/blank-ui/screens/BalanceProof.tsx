import { useState } from "react";
import { Link } from "react-router-dom";
import { useProofOfBalance, type BalanceProofRecord } from "@/hooks/useProofOfBalance";

/**
 * Retired balance proof screen.
 *
 * ProofOfBalance proved a number the prover typed in, not their vault
 * balance, so creating proofs is retired on-chain. New balance proofs live on
 * /app/proofs (PaymentReceipts.proveBalanceAbove reads the vault balance).
 * This screen keeps old links working: it points there and can still look up
 * records made before retirement, labelled as such.
 */
export default function BalanceProof() {
  const { deployed, fetchProof } = useProofOfBalance();
  const [lookupId, setLookupId] = useState<string>("");
  const [lookupResult, setLookupResult] = useState<BalanceProofRecord | null>(null);
  const [lookupMiss, setLookupMiss] = useState(false);
  const [looking, setLooking] = useState(false);

  const handleLookup = async () => {
    if (!/^\d+$/.test(lookupId.trim())) {
      setLookupResult(null);
      setLookupMiss(true);
      return;
    }
    setLooking(true);
    const proof = await fetchProof(BigInt(lookupId.trim()));
    setLooking(false);
    setLookupResult(proof);
    setLookupMiss(proof === null);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8" data-testid="balance-proof-screen">
      <header>
        <h1 className="text-3xl font-semibold">Balance proof</h1>
        <p className="text-sm text-[var(--text-primary)]/70 mt-2">
          Balance proofs now read your shielded vault balance directly, so the
          verdict is about funds you hold, not a number you typed.
        </p>
      </header>

      <section className="rounded-2xl border border-black/5 bg-white p-6 space-y-3" data-testid="balance-proof-moved">
        <h2 className="text-lg font-semibold">Create a balance proof</h2>
        <p className="text-sm text-[var(--text-primary)]/70">
          Pick a threshold. The chain checks your encrypted vault balance against it
          and stores only the yes or no.
        </p>
        <Link
          to="/app/proofs?kind=balance"
          className="inline-flex items-center justify-center h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium"
          data-testid="go-to-proofs"
        >
          Open Encrypted Proofs
        </Link>
      </section>

      {deployed && (
        <section className="rounded-2xl border border-black/5 bg-white p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Look up an old proof</h2>
            <p className="text-xs text-[var(--text-primary)]/60 mt-1">
              Proofs made with the retired contract used a balance the prover entered.
              They are shown for reference and do not prove funds.
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="Proof ID"
              className="flex-1 min-w-0 rounded-xl border border-black/10 px-3 py-2"
              data-testid="lookup-input"
            />
            <button
              onClick={handleLookup}
              disabled={looking || !lookupId.trim()}
              className="h-11 px-5 rounded-xl bg-black/5 font-medium whitespace-nowrap shrink-0 disabled:opacity-40"
              data-testid="lookup-button"
            >
              {looking ? "Looking up..." : "Look up"}
            </button>
          </div>
          {lookupMiss && (
            <p className="text-sm text-[var(--text-primary)]/60" data-testid="lookup-miss">
              No proof with that ID on this chain.
            </p>
          )}
          {lookupResult && (
            <div className="text-sm space-y-1 bg-black/5 rounded-xl p-4" data-testid="lookup-result">
              <p>Prover: <code className="text-xs break-all">{lookupResult.prover}</code></p>
              <p>Threshold: ${(Number(lookupResult.thresholdMicroUSD) / 1_000_000).toLocaleString()}</p>
              <p>Created: {new Date(Number(lookupResult.createdAt) * 1000).toLocaleString()}</p>
              <p>Verdict: {lookupResult.revealed ? (
                lookupResult.revealedValue ? "met (self-reported balance)" : "not met (self-reported balance)"
              ) : (
                "never revealed"
              )}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
