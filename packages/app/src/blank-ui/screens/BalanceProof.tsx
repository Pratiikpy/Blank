import { useState } from "react";
import { useProofOfBalance, type BalanceProofRecord } from "@/hooks/useProofOfBalance";
import { useChain } from "@/providers/ChainProvider";

/**
 * Wave 5 Block 10 — Balance proof screen.
 *
 * Lets the user prove "my encrypted balance ≥ threshold" without
 * revealing the balance value. Two stages:
 *   1. Create: encrypt balance, submit createProof(InEuint64, threshold)
 *   2. Reveal: fetch decrypt signature from TN, submit revealProof
 *
 * The plaintext balance never reaches the chain — only the boolean verdict.
 */
export default function BalanceProof() {
  const { contracts } = useChain();
  const { step, error, createProof, revealProof, fetchProof, reset } = useProofOfBalance();
  const [balance, setBalance] = useState<string>("");
  const [threshold, setThreshold] = useState<string>("");
  const [lastProofId, setLastProofId] = useState<bigint | null>(null);
  const [lookupId, setLookupId] = useState<string>("");
  const [lookupResult, setLookupResult] = useState<BalanceProofRecord | null>(null);

  const contractDeployed =
    contracts.ProofOfBalance &&
    contracts.ProofOfBalance !== "0x0000000000000000000000000000000000000000";

  const handleCreate = async () => {
    const b = parseFloat(balance);
    const t = parseFloat(threshold);
    if (isNaN(b) || isNaN(t)) return;
    const id = await createProof(b, t);
    if (id !== null) setLastProofId(id);
  };

  const handleReveal = async (id: bigint) => {
    const ok = await revealProof(id);
    if (ok) {
      const fresh = await fetchProof(id);
      setLookupResult(fresh);
    }
  };

  const handleLookup = async () => {
    if (!lookupId) return;
    try {
      const id = BigInt(lookupId);
      const proof = await fetchProof(id);
      setLookupResult(proof);
    } catch {
      setLookupResult(null);
    }
  };

  if (!contractDeployed) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-3xl font-semibold mb-4">Balance proof</h1>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <p className="text-amber-900 font-medium">Not deployed on this chain</p>
          <p className="text-amber-700 text-sm mt-2">
            Switch to Ethereum Sepolia, Base Sepolia, or Arbitrum Sepolia to use balance proofs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8" data-testid="balance-proof-screen">
      <header>
        <h1 className="text-3xl font-semibold">Balance proof</h1>
        <p className="text-sm text-[var(--text-primary)]/70 mt-2">
          Prove your balance meets a threshold. The amount stays private. Only
          the yes/no verdict gets published.
        </p>
      </header>

      <section className="rounded-2xl border border-black/5 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold">Create a proof</h2>

        <div className="space-y-3">
          <label className="block text-sm">
            Your balance (USDC)
            <input
              type="number"
              min="0"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder="5000"
              className="mt-1 block w-full rounded-xl border border-black/10 px-3 py-2"
              data-testid="balance-input"
            />
          </label>
          <label className="block text-sm">
            Threshold to prove (USDC)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="1000"
              className="mt-1 block w-full rounded-xl border border-black/10 px-3 py-2"
              data-testid="threshold-input"
            />
          </label>
        </div>

        <button
          onClick={handleCreate}
          disabled={step === "encrypting" || step === "creating" || !balance || !threshold}
          className="w-full h-12 rounded-2xl bg-[var(--text-primary)] text-white font-medium disabled:opacity-40"
          data-testid="create-proof-button"
        >
          {step === "encrypting" && "Encrypting balance..."}
          {step === "creating" && "Creating proof..."}
          {(step === "idle" || step === "success" || step === "error") && "Create proof"}
          {(step === "decrypting" || step === "revealing") && "Working..."}
        </button>

        {lastProofId !== null && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm" data-testid="last-proof-id">
            <p className="font-medium text-emerald-900">Proof #{lastProofId.toString()} created</p>
            <button
              onClick={() => handleReveal(lastProofId)}
              disabled={step === "decrypting" || step === "revealing"}
              className="mt-2 h-9 px-4 rounded-xl bg-emerald-600 text-white text-sm disabled:opacity-40"
              data-testid="reveal-proof-button"
            >
              {step === "decrypting" && "Decrypting..."}
              {step === "revealing" && "Publishing..."}
              {step !== "decrypting" && step !== "revealing" && "Reveal verdict"}
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-900" data-testid="proof-error">
            {error}
            <button onClick={reset} className="ml-2 underline text-red-700">dismiss</button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-black/5 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold">Look up a proof</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            placeholder="Proof ID"
            className="flex-1 rounded-xl border border-black/10 px-3 py-2"
            data-testid="lookup-input"
          />
          <button
            onClick={handleLookup}
            className="h-11 px-5 rounded-xl bg-black/5 font-medium whitespace-nowrap shrink-0"
            data-testid="lookup-button"
          >
            Look up
          </button>
        </div>
        {lookupResult && (
          <div className="text-sm space-y-1 bg-black/5 rounded-xl p-4" data-testid="lookup-result">
            <p>Prover: <code className="text-xs">{lookupResult.prover}</code></p>
            <p>Threshold: ${(Number(lookupResult.thresholdMicroUSD) / 1_000_000).toLocaleString()}</p>
            <p>Created: {new Date(Number(lookupResult.createdAt) * 1000).toLocaleString()}</p>
            <p>Status: {lookupResult.revealed ? (
              <span className={lookupResult.revealedValue ? "text-emerald-700 font-semibold" : "text-red-700 font-semibold"}>
                {lookupResult.revealedValue ? "TRUE (meets threshold)" : "FALSE (below threshold)"}
              </span>
            ) : (
              <span className="text-amber-700 font-semibold">Pending reveal</span>
            )}</p>
          </div>
        )}
      </section>
    </div>
  );
}
