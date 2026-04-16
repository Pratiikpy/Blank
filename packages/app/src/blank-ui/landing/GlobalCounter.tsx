import { useEffect, useState, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { Lock, Loader2 } from "lucide-react";
import { useChain } from "@/providers/ChainProvider";
import { PaymentReceiptsAbi } from "@/lib/abis";
import { useCofheDecryptForView, useCofheConnection } from "@/lib/cofhe-shim";
import "./global-counter.css";

// ─────────────────────────────────────────────────────────────────────
//  GlobalCounter — landing-page "$X moved encrypted" counter.
//
//  Reads PaymentReceipts.getGlobalVolumeHandle() and getGlobalTxCountHandle()
//  on the active chain, decrypts both publicly via FHE.allowGlobal (no
//  permit required — the SDK plumbing creates one transparently for the
//  connected wallet, but the values themselves are public).
//
//  Polls every 30s. Falls back to "—" if cofhe SDK isn't ready or the
//  decrypt fails (e.g. wallet not connected, RPC blip).
// ─────────────────────────────────────────────────────────────────────

const POLL_MS = 30_000;
const TOKEN_DECIMALS = 6;

export function GlobalCounter() {
  const publicClient = usePublicClient();
  const { isConnected } = useAccount();
  const { activeChain, activeChainId, contracts, availableChains, setActiveChain } = useChain();
  const { connected: cofheReady } = useCofheConnection();
  const { decryptForView } = useCofheDecryptForView();

  const [volume, setVolume] = useState<bigint | null>(null);
  const [txCount, setTxCount] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      const [volHandle, cntHandle] = await Promise.all([
        publicClient.readContract({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getGlobalVolumeHandle",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: contracts.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getGlobalTxCountHandle",
        }) as Promise<bigint>,
      ]);

      // Both handles must be non-zero — they are after init.
      if (!volHandle || !cntHandle) {
        setLoading(false);
        return;
      }

      // Decrypt both in parallel. If either fails, leave the counter dashed.
      const [vol, cnt] = await Promise.all([
        decryptForView(volHandle, "uint64"),
        decryptForView(cntHandle, "uint64"),
      ]);

      if (typeof vol === "bigint") setVolume(vol);
      if (typeof cnt === "bigint") setTxCount(cnt);
    } catch (err) {
      // Network/RPC error — keep prior value, just stop the spinner
      console.warn("[GlobalCounter] refresh failed:", err);
    } finally {
      setLoading(false);
    }
  }, [publicClient, decryptForView, contracts]);

  // Reset displayed values on chain switch so stale numbers from the
  // previous chain don't briefly show before the new chain's read lands.
  useEffect(() => {
    setVolume(null);
    setTxCount(null);
    setLoading(true);
  }, [activeChainId]);

  useEffect(() => {
    if (!cofheReady) return;
    if (!publicClient || !isConnected) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, cofheReady, publicClient, isConnected, activeChainId]);

  const volumeUSD =
    volume !== null ? Number(volume) / 10 ** TOKEN_DECIMALS : null;

  return (
    <section className="gc-section" aria-label="Live encrypted volume">
      <div className="gc-eyebrow">Live · {activeChain.shortName}</div>

      {/* #243: cross-chain switcher — each chain has its own PaymentReceipts
          contract + cofhe network, so we can't aggregate them in one read.
          Instead, let the viewer flip between chains. setActiveChain re-runs
          the effect below, refreshing the displayed counter. */}
      {availableChains.length > 1 && (
        <div className="gc-chain-tabs" role="tablist" aria-label="Select chain">
          {availableChains.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === activeChainId}
              className={`gc-chain-tab${c.id === activeChainId ? " is-active" : ""}`}
              onClick={() => {
                if (c.id !== activeChainId) setActiveChain(c.id);
              }}
            >
              {c.shortName}
            </button>
          ))}
        </div>
      )}

      <div className="gc-numbers">
        <div className="gc-stat">
          <div className="gc-stat-label">Encrypted USDC moved on {activeChain.name}</div>
          <div className="gc-stat-value">
            {!isConnected ? (
              <span className="gc-hint">Connect to view live counter</span>
            ) : loading && volumeUSD === null ? (
              <Loader2 size={28} className="animate-spin opacity-30" />
            ) : volumeUSD !== null ? (
              <>
                <span className="gc-currency">$</span>
                {volumeUSD.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </>
            ) : (
              <span className="gc-dash">—</span>
            )}
          </div>
        </div>

        <div className="gc-divider" aria-hidden />

        <div className="gc-stat">
          <div className="gc-stat-label">Receipts issued on {activeChain.name}</div>
          <div className="gc-stat-value">
            {!isConnected ? (
              <span className="gc-hint">Connect to view live counter</span>
            ) : loading && txCount === null ? (
              <Loader2 size={28} className="animate-spin opacity-30" />
            ) : txCount !== null ? (
              <>{Number(txCount).toLocaleString()}</>
            ) : (
              <span className="gc-dash">—</span>
            )}
          </div>
        </div>
      </div>

      <p className="gc-caption">
        <Lock size={13} className="inline-block -mt-0.5 mr-1 opacity-60" />
        Per-transaction amounts are encrypted on-chain. The aggregate is
        published publicly via <code>FHE.allowGlobal</code> — anyone can
        verify the total without learning any individual amount.
        {!isConnected && (
          <span className="gc-hint"> · Connect a wallet to see live data.</span>
        )}
      </p>
    </section>
  );
}
