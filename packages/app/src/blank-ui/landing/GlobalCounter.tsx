import { useEffect, useState, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { Lock, Loader2 } from "lucide-react";
import { CONTRACTS, ACTIVE_CHAIN } from "@/lib/constants";
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
          address: CONTRACTS.PaymentReceipts,
          abi: PaymentReceiptsAbi,
          functionName: "getGlobalVolumeHandle",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: CONTRACTS.PaymentReceipts,
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
  }, [publicClient, decryptForView]);

  useEffect(() => {
    if (!cofheReady) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, cofheReady]);

  const volumeUSD =
    volume !== null ? Number(volume) / 10 ** TOKEN_DECIMALS : null;

  return (
    <section className="gc-section" aria-label="Live encrypted volume">
      <div className="gc-eyebrow">Live · {ACTIVE_CHAIN.shortName}</div>

      <div className="gc-numbers">
        <div className="gc-stat">
          <div className="gc-stat-label">Encrypted USDC moved through Blank</div>
          <div className="gc-stat-value">
            {loading && volumeUSD === null ? (
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
          <div className="gc-stat-label">Receipts issued</div>
          <div className="gc-stat-value">
            {loading && txCount === null ? (
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
