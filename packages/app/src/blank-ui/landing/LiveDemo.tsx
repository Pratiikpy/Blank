import { useState, useCallback, useEffect } from "react";
import { useAccount, useConnect } from "wagmi";
import {
  Wallet,
  Droplet,
  Lock,
  Eye,
  CheckCircle2,
  Loader2,
  ExternalLink,
  ArrowRight,
} from "lucide-react";
import { useShield } from "@/hooks/useShield";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { useCofheConnection } from "@/lib/cofhe-shim";
import { useChain } from "@/providers/ChainProvider";
import "./live-demo.css";

// ──────────────────────────────────────────────────────────────────
//  LiveDemo — the embedded "try it now" flow on the landing page.
//
//  Four steps (Lendi-pattern, condensed):
//   1. Connect wallet
//   2. Faucet: mint 10K test USDC
//   3. Shield: deposit 50 USDC into the encrypted vault
//   4. Reveal: only YOU can see your encrypted balance
//
//  Reuses the production hooks (useShield, useEncryptedBalance) so
//  the demo path runs the same code as the real app — what you see
//  here is what you get inside /app.
// ──────────────────────────────────────────────────────────────────

type StepKey = "connect" | "faucet" | "shield" | "reveal";

const SHIELD_AMOUNT = "50";

export function LiveDemo() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connectPending } = useConnect();
  const { activeChain } = useChain();
  const { connected: cofheReady } = useCofheConnection();
  const balance = useEncryptedBalance();
  const {
    mintTestTokens,
    shield,
    publicBalance,
    isMinting,
    step: shieldStep,
    txHash,
  } = useShield();

  const [activeStep, setActiveStep] = useState<StepKey>("connect");
  const [faucetTxHash, setFaucetTxHash] = useState<`0x${string}` | null>(null);
  const [revealVisible, setRevealVisible] = useState(false);
  const [fheSyncTimedOut, setFheSyncTimedOut] = useState(false);

  // Reset demo state when wallet disconnects — no stale tx hashes or step progress.
  useEffect(() => {
    if (!isConnected) {
      setActiveStep("connect");
      setFaucetTxHash(null);
      setRevealVisible(false);
    }
  }, [isConnected]);

  // Auto-advance on wallet connection (proper effect so timers are cleaned up
  // and multiple timeouts don't queue when the tab re-renders while hidden).
  useEffect(() => {
    if (!isConnected || activeStep !== "connect") return;
    if (typeof document !== "undefined" && document.hidden) return;
    const id = setTimeout(() => setActiveStep("faucet"), 600);
    return () => clearTimeout(id);
  }, [isConnected, activeStep]);

  // FHE sync timeout — after 30s of !cofheReady, surface an actionable hint.
  useEffect(() => {
    if (cofheReady) {
      setFheSyncTimedOut(false);
      return;
    }
    const id = setTimeout(() => setFheSyncTimedOut(true), 30_000);
    return () => clearTimeout(id);
  }, [cofheReady]);

  const handleConnect = useCallback(() => {
    const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (injected) connect({ connector: injected });
  }, [connect, connectors]);

  const handleFaucet = useCallback(async () => {
    const hash = await mintTestTokens();
    if (hash) {
      setFaucetTxHash(hash);
      setTimeout(() => setActiveStep("shield"), 800);
    }
  }, [mintTestTokens]);

  const handleShield = useCallback(async () => {
    const hash = await shield(SHIELD_AMOUNT);
    if (hash) {
      setTimeout(() => setActiveStep("reveal"), 800);
    }
  }, [shield]);

  const handleReveal = useCallback(async () => {
    setRevealVisible(true);
    if (!balance.isRevealed) {
      balance.toggleReveal();
    }
  }, [balance]);

  // Computed flags
  const faucetDone = faucetTxHash !== null || publicBalance > 0;
  const shieldDone = shieldStep === "success" || (txHash && publicBalance < 10_000);

  const explorerTx = (hash: string | null) =>
    hash ? `${activeChain.explorerUrl}/tx/${hash}` : null;

  return (
    <section className="ld-section" aria-label="Live demo">
      <div className="ld-eyebrow">Live demo · {activeChain.shortName}</div>
      <h2 className="ld-title">See it work in 60 seconds.</h2>
      <p className="ld-lead">
        Real testnet. Real encryption. Same code as the production app.
        Each step is a real on-chain transaction — your balance only
        appears when <em>you</em> reveal it.
      </p>

      <div className="ld-flow">
        {/* Step 1 — Connect wallet */}
        <DemoStep
          n={1}
          title="Connect a wallet"
          icon={<Wallet size={20} />}
          active={activeStep === "connect"}
          done={isConnected}
        >
          {!isConnected ? (
            <button
              onClick={handleConnect}
              disabled={connectPending}
              className="ld-btn ld-btn--primary"
              aria-label="Connect wallet"
            >
              {connectPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Connecting…
                </>
              ) : (
                <>
                  Connect wallet <ArrowRight size={14} />
                </>
              )}
            </button>
          ) : (
            <div className="ld-status">
              <CheckCircle2 size={14} /> Connected · {address?.slice(0, 6)}…{address?.slice(-4)}
              {!cofheReady && (
                <span className="ld-hint">
                  {" "}
                  ·{" "}
                  {fheSyncTimedOut
                    ? "FHE sync timed out — reload page"
                    : "syncing FHE…"}
                </span>
              )}
            </div>
          )}
        </DemoStep>

        {/* Step 2 — Faucet */}
        <DemoStep
          n={2}
          title="Mint 10,000 test USDC"
          icon={<Droplet size={20} />}
          active={activeStep === "faucet"}
          done={faucetDone}
          locked={!isConnected}
        >
          {!faucetDone ? (
            <button
              onClick={handleFaucet}
              disabled={isMinting || !isConnected}
              className="ld-btn ld-btn--primary"
              aria-label="Mint test USDC"
            >
              {isMinting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Minting…
                </>
              ) : (
                <>
                  Open faucet <ArrowRight size={14} />
                </>
              )}
            </button>
          ) : (
            <div className="ld-status">
              <CheckCircle2 size={14} /> {publicBalance.toLocaleString()} USDC available
              {faucetTxHash && (
                <a href={explorerTx(faucetTxHash)!} target="_blank" rel="noopener noreferrer" className="ld-tx-link">
                  <ExternalLink size={12} /> tx
                </a>
              )}
            </div>
          )}
        </DemoStep>

        {/* Step 3 — Shield */}
        <DemoStep
          n={3}
          title={`Shield ${SHIELD_AMOUNT} USDC into the encrypted vault`}
          icon={<Lock size={20} />}
          active={activeStep === "shield"}
          done={shieldDone === true}
          locked={!faucetDone}
        >
          {!shieldDone ? (
            <button
              onClick={handleShield}
              disabled={!faucetDone || shieldStep === "approving" || shieldStep === "shielding"}
              className="ld-btn ld-btn--primary"
              aria-label="Shield USDC"
            >
              {shieldStep === "approving" ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Approving…
                </>
              ) : shieldStep === "shielding" ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Encrypting…
                </>
              ) : (
                <>
                  Shield {SHIELD_AMOUNT} USDC <ArrowRight size={14} />
                </>
              )}
            </button>
          ) : (
            <div className="ld-status">
              <CheckCircle2 size={14} /> Shielded. Public balance now{" "}
              {publicBalance.toLocaleString()} USDC
              {txHash && (
                <a href={explorerTx(txHash)!} target="_blank" rel="noopener noreferrer" className="ld-tx-link">
                  <ExternalLink size={12} /> tx
                </a>
              )}
            </div>
          )}
        </DemoStep>

        {/* Step 4 — Reveal */}
        <DemoStep
          n={4}
          title="Only YOU can decrypt your balance"
          icon={<Eye size={20} />}
          active={activeStep === "reveal"}
          done={revealVisible && balance.isRevealed && !!balance.formatted}
          locked={!shieldDone}
        >
          {!revealVisible ? (
            <button
              onClick={handleReveal}
              disabled={!shieldDone}
              className="ld-btn ld-btn--primary"
              aria-label="Reveal encrypted balance"
            >
              Reveal my encrypted balance <ArrowRight size={14} />
            </button>
          ) : (
            <div className="ld-reveal">
              <div className="ld-reveal-row">
                <span className="ld-reveal-label">On-chain (anyone can read):</span>
                <code className="ld-reveal-cipher">
                  ████████████████████████ <span className="ld-reveal-tag">encrypted</span>
                </code>
              </div>
              <div className="ld-reveal-row">
                <span className="ld-reveal-label">Decrypted (only you):</span>
                <code className="ld-reveal-plain">
                  {balance.isLoading
                    ? "Decrypting…"
                    : balance.isRevealed && balance.formatted
                      ? `${balance.formatted} USDC`
                      : "Click reveal again"}
                </code>
              </div>
              <p className="ld-reveal-caption">
                That's the whole point. The blockchain stored your balance —
                but it can't read it. Only your wallet can decrypt the value.
              </p>
            </div>
          )}
        </DemoStep>
      </div>
    </section>
  );
}

// ─── Internal: a single step row ────────────────────────────────────

interface DemoStepProps {
  n: number;
  title: string;
  icon: React.ReactNode;
  active: boolean;
  done: boolean;
  locked?: boolean;
  children: React.ReactNode;
}

function DemoStep({ n, title, icon, active, done, locked, children }: DemoStepProps) {
  return (
    <div
      className={
        "ld-step" +
        (active ? " is-active" : "") +
        (done ? " is-done" : "") +
        (locked ? " is-locked" : "")
      }
    >
      <div className="ld-step-num">{done ? <CheckCircle2 size={16} /> : n}</div>
      <div className="ld-step-icon">{icon}</div>
      <div className="ld-step-body">
        <h3 className="ld-step-title">{title}</h3>
        <div className="ld-step-action">{children}</div>
      </div>
    </div>
  );
}
