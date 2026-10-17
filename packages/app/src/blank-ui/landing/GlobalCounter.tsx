import { useEffect, useState, useCallback } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain } from "wagmi";
import { Lock, Loader2 } from "lucide-react";
import { useChain } from "@/providers/ChainProvider";
import { PaymentReceiptsAbi } from "@/lib/abis";
import { useCofheDecryptForView, useCofheConnection } from "@/lib/cofhe-shim";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { log } from "@/lib/log";
import toast from "react-hot-toast";
import "./global-counter.css";

// ─────────────────────────────────────────────────────────────────────
//  GlobalCounter — landing-page "$X moved encrypted" counter.
//
//  Reads PaymentReceipts.getGlobalVolumeHandle() and getGlobalTxCountHandle()
//  on the active chain. Those return a daily public snapshot of the live
//  totals (a live public total would leak each payment as the difference of
//  two reads). The snapshot is the zero handle until the first
//  publishGlobalSnapshot call, and anyone may publish a new one once per
//  SNAPSHOT_INTERVAL. When it is missing or stale, the viewer can publish it.
//
//  Polls every 30s. Falls back to a dash if the cofhe SDK isn't ready or the
//  decrypt fails (e.g. wallet not connected, RPC blip).
// ─────────────────────────────────────────────────────────────────────

const POLL_MS = 30_000;
const TOKEN_DECIMALS = 6;
/** Matches PaymentReceipts.SNAPSHOT_INTERVAL (1 day). */
const SNAPSHOT_INTERVAL_S = 86_400;

export function GlobalCounter() {
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { activeChain, activeChainId, contracts, availableChains, setActiveChain } = useChain();
  const { connected: cofheReady } = useCofheConnection();
  const { decryptForView } = useCofheDecryptForView();
  const { unifiedWriteAndWait } = useUnifiedWrite();

  // Force the public client onto the *active* chain (the tab the user
  // selected), not whatever the wallet happens to be on. Otherwise we
  // call Base Sepolia's contract address against Eth Sepolia's RPC.
  const publicClient = usePublicClient({ chainId: activeChainId });

  const chainMismatch = isConnected && walletChainId !== activeChainId;

  const [volume, setVolume] = useState<bigint | null>(null);
  const [txCount, setTxCount] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  /** Unix seconds of the last public snapshot; 0 = none yet; null = unknown. */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    // Decryption goes through the cofhe SDK, which is bound to the
    // wallet's chain. If the wallet is on the wrong chain, skip the
    // decrypt entirely — the UI will render the "switch wallet" CTA.
    if (chainMismatch) {
      setLoading(false);
      return;
    }
    try {
      // Pre-snapshot deployments lack the view; keep the counter working.
      const lastAt = await (publicClient.readContract({
        address: contracts.PaymentReceipts,
        abi: PaymentReceiptsAbi,
        functionName: "lastSnapshotAt",
      }) as Promise<bigint>).catch(() => null);
      setSnapshotAt(lastAt === null ? null : Number(lastAt));

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

      // Zero handle = no snapshot published yet. Show that, not a spinner.
      if (!volHandle || !cntHandle) {
        setVolume(null);
        setTxCount(null);
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
      log.warn("globalCounter.refresh.failed", err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [publicClient, decryptForView, contracts, chainMismatch]);

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

  const nowS = Math.floor(Date.now() / 1000);
  const noSnapshot = snapshotAt === 0;
  const snapshotStale = snapshotAt !== null && (snapshotAt === 0 || nowS >= snapshotAt + SNAPSHOT_INTERVAL_S);

  const publishSnapshot = useCallback(async () => {
    if (publishing) return;
    setPublishing(true);
    const toastId = toast.loading("Publishing today's totals...");
    try {
      await unifiedWriteAndWait({
        address: contracts.PaymentReceipts,
        abi: PaymentReceiptsAbi,
        functionName: "publishGlobalSnapshot",
        args: [],
        gas: BigInt(1_000_000),
      });
      toast.success("Totals published", { id: toastId });
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.includes("too soon") ? "Already published in the last 24 hours" : "Could not publish totals", { id: toastId });
    } finally {
      setPublishing(false);
    }
  }, [publishing, unifiedWriteAndWait, contracts, refresh]);

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
            ) : chainMismatch ? (
              <span className="gc-hint">Switch wallet to {activeChain.name}</span>
            ) : loading && volumeUSD === null ? (
              <Loader2 size={28} className="animate-spin opacity-30" />
            ) : noSnapshot ? (
              <span className="gc-hint">No totals published yet</span>
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
              <span className="gc-dash">—</span>
            ) : chainMismatch ? (
              <span className="gc-hint">Switch wallet to {activeChain.name}</span>
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

      {isConnected && !chainMismatch && snapshotStale && (
        <button
          type="button"
          className="gc-switch-cta"
          onClick={publishSnapshot}
          disabled={publishing}
        >
          {publishing ? "Publishing..." : noSnapshot ? "Publish the first totals" : "Publish today's totals"}
        </button>
      )}

      {chainMismatch && (
        <button
          type="button"
          className="gc-switch-cta"
          onClick={() => switchChain({ chainId: activeChainId })}
        >
          Switch wallet to {activeChain.name}
        </button>
      )}

      <p className="gc-caption">
        <Lock size={13} className="inline-block -mt-0.5 mr-1 opacity-60" />
        Per-transaction amounts are encrypted on-chain. The totals are
        published at most once a day via <code>FHE.allowGlobal</code>, so a
        difference between two snapshots covers a whole day, not one payment.
        {snapshotAt !== null && snapshotAt > 0 && (
          <> Last published {new Date(snapshotAt * 1000).toLocaleString()}.</>
        )}
        {!isConnected && (
          <span className="gc-hint"> · Connect a wallet to see live data.</span>
        )}
      </p>
    </section>
  );
}
