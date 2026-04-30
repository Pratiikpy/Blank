// Drives the CCTP V2 burn-and-mint flow as a single React state machine.
//
// Lifecycle:
//   idle
//     ↓  (user fills the form and clicks "Bridge")
//   approving  →  burning  →  polling  →  readyToClaim
//                                              ↓  (user clicks "Switch & Claim")
//                                         switching → minting → complete
//
// Errors at any step land in `error` with the failing step preserved in
// `step` so the UI can render a "Retry from <step>" affordance. The bridge
// transaction hashes are kept in `txHashes` so the user can open them on
// a block explorer at every stage.
//
// Source-chain burn requires the active wagmi chain to match the source.
// Destination claim requires the user (or the AA layer) to switch chains.
// We never auto-switch on Phase 1 — only the explicit `claim()` call calls
// `setActiveChain`. ChainProvider is reload-free since Layer 4, so the
// switch propagates via React re-render rather than a page reload.

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import {
  STORAGE_KEYS,
  getStoredJson,
  setStoredJson,
  removeStored,
} from "@/lib/storage";
import {
  CCTP_DOMAIN,
  TokenMessengerV2Abi,
  MessageTransmitterV2Abi,
  pollAttestation,
  planBridge,
  type BridgeQuote,
} from "@/lib/cctp";
import {
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  type SupportedChainId,
} from "@/lib/constants";

export type BridgeStep =
  | "idle"
  | "approving"
  | "burning"
  | "polling"
  | "readyToClaim"
  | "switching"
  | "minting"
  | "complete"
  | "error";

export interface BridgeTxHashes {
  approve?: Hex;
  burn?: Hex;
  mint?: Hex;
}

export interface BridgeStartArgs {
  sourceChain: SupportedChainId;
  destChain: SupportedChainId;
  amountUnits: bigint;
  speed?: "fast" | "finalized";
  /** Override the recipient — defaults to the user's effective address.
   *  AA accounts share the same address across chains so the default is
   *  almost always what you want. */
  recipient?: Address;
}

/** Persisted bridge state — what we save to localStorage so a tab close
 *  during the ~15-min Iris attestation poll doesn't strand the user. The
 *  schema is minimal: enough to re-derive the plan via `planBridge()` and
 *  re-poll Iris for the attestation, OR jump straight to claim if the
 *  attestation already landed before the user closed the tab. */
export interface PersistedBridge {
  /** Source chain ID — burn happened here. */
  sourceChainId: SupportedChainId;
  /** Destination chain ID — mint happens here. */
  destChainId: SupportedChainId;
  /** Burn USDC amount in 6-decimal units (stringified bigint for JSON). */
  amountUnits: string;
  /** Recipient on the destination chain (defaults to user's AA). */
  recipient: Address;
  /** Speed used at burn — re-supplied to `planBridge` on resume. */
  speed: "fast" | "finalized";
  /** Burn tx hash — Iris key. */
  burnTxHash: Hex;
  /** Approve tx hash, if it happened in this run (may be undefined when
   *  the AA already had infinite allowance to TokenMessenger). */
  approveTxHash?: Hex;
  /** Attestation IF it was resolved before the tab closed; otherwise null. */
  attestation?: { message: Hex; attestation: Hex };
  /** Unix-ms timestamp the burn was submitted at. */
  startedAt: number;
}

export interface UseBridgeUSDCReturn {
  step: BridgeStep;
  error: string | null;
  txHashes: BridgeTxHashes;
  /** Live status string from the Iris poller (`pending_confirmations`,
   *  `complete`, `propagating`, etc.). Surfaces directly on the UI. */
  attestationStatus: string | null;
  /** Resolved {message, attestation} once the poll completes. Stays set
   *  through `claim()` so the user can retry the mint without re-bridging. */
  attestation: { message: Hex; attestation: Hex } | null;
  /** The plan currently being executed — UI uses it to render a quote. */
  quote: BridgeQuote | null;
  /** Phase 1: approve + burn + start polling. Resolves once the
   *  attestation is ready and `step === "readyToClaim"`. */
  start: (args: BridgeStartArgs) => Promise<void>;
  /** Phase 2: switch destination chain (if needed) + receiveMessage.
   *  Idempotent — safe to retry on transient mint failures. */
  claim: () => Promise<void>;
  /** Reset the state machine back to idle and abort any in-flight poll.
   *  Also clears any persisted "resumable" record from localStorage. */
  reset: () => void;
  /** Persisted bridge from a previous session that's still incomplete.
   *  Surface a "Resume bridge" banner on `/app/bridge` mount when this
   *  is non-null. NULL means there's nothing to resume. */
  resumable: PersistedBridge | null;
  /** Pick up a previously-persisted bridge: re-poll attestation if needed,
   *  or jump straight to readyToClaim if the saved record already has it. */
  resume: () => Promise<void>;
}

const MAX_ALLOWANCE = (1n << 256n) - 1n;

/** Reverse map of the CCTP_DOMAIN export — small enough to inline rather
 *  than building dynamically. Update both maps in lockstep when CCTP V2
 *  support lands on a new chain. */
const CCTP_DOMAIN_TO_CHAIN: Record<number, SupportedChainId> = {
  0: ETH_SEPOLIA_ID,
  6: BASE_SEPOLIA_ID,
};

export function useBridgeUSDC(): UseBridgeUSDCReturn {
  const { effectiveAddress } = useEffectiveAddress();
  const { setActiveChain, activeChainId } = useChain();
  const { unifiedWriteAndWait } = useUnifiedWrite();

  const [step, setStep] = useState<BridgeStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<BridgeTxHashes>({});
  const [attestationStatus, setAttestationStatus] = useState<string | null>(null);
  const [attestation, setAttestation] = useState<
    { message: Hex; attestation: Hex } | null
  >(null);
  const [quote, setQuote] = useState<BridgeQuote | null>(null);

  // Poll cancellation — must survive across renders so reset() can abort
  // a poll initiated by an earlier start().
  const abortRef = useRef<AbortController | null>(null);
  const sourcePublicClient = usePublicClient({ chainId: activeChainId });

  // Phase 7 / blueprint follow-up: persist bridge state across tab close
  // so a 15-min Iris poll doesn't strand the user on reload. Read-once
  // on mount; the resume() method lets the UI explicitly opt in to
  // hydrating the saved record (we don't auto-hydrate because the user
  // may have intentionally left).
  const [resumable, setResumable] = useState<PersistedBridge | null>(null);
  useEffect(() => {
    if (!effectiveAddress) {
      setResumable(null);
      return;
    }
    const key = STORAGE_KEYS.pendingBridge(effectiveAddress.toLowerCase());
    const saved = getStoredJson<PersistedBridge | null>(key, null);
    setResumable(saved && saved.burnTxHash ? saved : null);
  }, [effectiveAddress]);

  /** Persist the in-flight bridge so a tab-close mid-poll doesn't lose state. */
  const savePending = useCallback(
    (entry: PersistedBridge) => {
      if (!effectiveAddress) return;
      const key = STORAGE_KEYS.pendingBridge(effectiveAddress.toLowerCase());
      setStoredJson(key, entry);
      setResumable(entry);
    },
    [effectiveAddress],
  );

  /** Drop the persisted record. Called on `complete` and from `reset()`. */
  const clearPending = useCallback(() => {
    if (!effectiveAddress) return;
    const key = STORAGE_KEYS.pendingBridge(effectiveAddress.toLowerCase());
    removeStored(key);
    setResumable(null);
  }, [effectiveAddress]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep("idle");
    setError(null);
    setTxHashes({});
    setAttestationStatus(null);
    setAttestation(null);
    setQuote(null);
    clearPending();
  }, [clearPending]);

  const start = useCallback(
    async (args: BridgeStartArgs) => {
      if (!effectiveAddress) {
        toast.error("Connect a wallet first");
        return;
      }
      if (!sourcePublicClient) {
        toast.error("RPC unavailable on the active chain — try again");
        return;
      }
      if (args.sourceChain !== activeChainId) {
        toast.error("Switch to the source chain before starting the bridge");
        return;
      }

      let plan: BridgeQuote;
      try {
        plan = planBridge({
          sourceChain: args.sourceChain,
          destChain: args.destChain,
          recipient: (args.recipient ?? effectiveAddress) as Address,
          amountUnits: args.amountUnits,
          speed: args.speed,
        });
      } catch (planErr) {
        setError(planErr instanceof Error ? planErr.message : String(planErr));
        setStep("error");
        return;
      }

      setQuote(plan);
      setError(null);
      setAttestationStatus(null);
      setAttestation(null);
      setTxHashes({});

      try {
        // ── Step 1: approve TokenMessengerV2 ────────────────────────
        // Use MAX allowance so re-bridges don't pay gas to re-approve. CCTP
        // burns exactly the amount we pass to depositForBurn, so a max
        // allowance has no over-spend risk inside the contract.
        setStep("approving");
        const approveTx = await unifiedWriteAndWait({
          address: plan.sourceUsdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [plan.sourceTokenMessenger, MAX_ALLOWANCE],
          gas: BigInt(120_000),
        });
        setTxHashes((h) => ({ ...h, approve: approveTx.hash }));

        // ── Step 2: depositForBurn ──────────────────────────────────
        setStep("burning");
        const burnResult = await unifiedWriteAndWait({
          address: plan.sourceTokenMessenger,
          abi: TokenMessengerV2Abi,
          functionName: "depositForBurn",
          args: [
            plan.amountUnits,
            plan.destDomain,
            plan.mintRecipient32,
            plan.sourceUsdc,
            plan.destinationCaller32,
            plan.maxFee,
            plan.minFinalityThreshold,
          ],
          gas: BigInt(300_000),
        });
        const burnTxHash = burnResult.hash;
        setTxHashes((h) => ({ ...h, burn: burnTxHash }));

        // Persist the burn so a tab close doesn't strand the user mid-poll.
        // We save BEFORE polling because the poll is the long-running
        // step — if it gets killed (Iris times out, network drops, user
        // closes tab), the saved record lets us pick up where we left off.
        savePending({
          sourceChainId: args.sourceChain,
          destChainId: args.destChain,
          amountUnits: args.amountUnits.toString(),
          recipient: (args.recipient ?? effectiveAddress) as Address,
          speed: args.speed ?? "fast",
          burnTxHash,
          approveTxHash: approveTx.hash,
          startedAt: Date.now(),
        });

        // ── Step 3: poll Iris for the attestation ───────────────────
        const controller = new AbortController();
        abortRef.current = controller;
        setStep("polling");
        const result = await pollAttestation({
          sourceDomain: CCTP_DOMAIN[args.sourceChain],
          txHash: burnTxHash,
          signal: controller.signal,
          onProgress: setAttestationStatus,
        });
        setAttestation(result);
        setStep("readyToClaim");
        // Update persisted record with the resolved attestation so a
        // tab close at this point lets the user click "Resume" → straight
        // to claim, no second poll.
        savePending({
          sourceChainId: args.sourceChain,
          destChainId: args.destChain,
          amountUnits: args.amountUnits.toString(),
          recipient: (args.recipient ?? effectiveAddress) as Address,
          speed: args.speed ?? "fast",
          burnTxHash,
          approveTxHash: approveTx.hash,
          attestation: result,
          startedAt: Date.now(),
        });
      } catch (err) {
        if (abortRef.current?.signal.aborted) {
          // User-initiated cancel — already handled by reset().
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setStep("error");
      }
    },
    [
      effectiveAddress,
      sourcePublicClient,
      activeChainId,
      unifiedWriteAndWait,
      savePending,
    ],
  );

  /** Phase 7 / blueprint follow-up: hydrate state from a persisted bridge.
   *  Two paths:
   *    1. Saved record has the attestation already → skip polling, go
   *       straight to readyToClaim. The user just needs to tap Continue.
   *    2. Saved record has only the burn tx hash → re-poll Iris from
   *       scratch (it remembers the burn forever, so the same tx hash
   *       still resolves to the same attestation).
   *
   *  We do NOT auto-call claim() — the user explicitly opted in by
   *  tapping Resume, but the chain switch is still their decision. */
  const resume = useCallback(async () => {
    if (!resumable || !effectiveAddress) return;
    setError(null);
    setAttestationStatus(null);
    setTxHashes({
      approve: resumable.approveTxHash,
      burn: resumable.burnTxHash,
    });
    let plan: BridgeQuote;
    try {
      plan = planBridge({
        sourceChain: resumable.sourceChainId,
        destChain: resumable.destChainId,
        recipient: resumable.recipient,
        amountUnits: BigInt(resumable.amountUnits),
        speed: resumable.speed,
      });
    } catch (planErr) {
      setError(planErr instanceof Error ? planErr.message : String(planErr));
      setStep("error");
      return;
    }
    setQuote(plan);

    if (resumable.attestation) {
      setAttestation(resumable.attestation);
      setStep("readyToClaim");
      return;
    }

    // No attestation persisted yet — re-poll Iris.
    const controller = new AbortController();
    abortRef.current = controller;
    setStep("polling");
    try {
      const result = await pollAttestation({
        sourceDomain: CCTP_DOMAIN[resumable.sourceChainId],
        txHash: resumable.burnTxHash,
        signal: controller.signal,
        onProgress: setAttestationStatus,
      });
      setAttestation(result);
      setStep("readyToClaim");
      savePending({ ...resumable, attestation: result });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }, [resumable, effectiveAddress, savePending]);

  const claim = useCallback(async () => {
    if (!quote || !attestation) {
      toast.error("Bridge not ready to claim");
      return;
    }
    if (!effectiveAddress) {
      toast.error("Connect a wallet first");
      return;
    }
    setError(null);

    const destChainId = CCTP_DOMAIN_TO_CHAIN[quote.destDomain];
    if (!destChainId) {
      setError(`Unknown destination domain ${quote.destDomain}`);
      setStep("error");
      return;
    }

    if (activeChainId !== destChainId) {
      try {
        setStep("switching");
        setActiveChain(destChainId);
        // Give ChainProvider a tick to propagate the switch to wagmi.
        await new Promise((r) => setTimeout(r, 200));
      } catch (switchErr) {
        setError(switchErr instanceof Error ? switchErr.message : String(switchErr));
        setStep("error");
        return;
      }
    }

    try {
      setStep("minting");
      const mintTx = await unifiedWriteAndWait({
        address: quote.destMessageTransmitter,
        abi: MessageTransmitterV2Abi,
        functionName: "receiveMessage",
        args: [attestation.message, attestation.attestation],
        gas: BigInt(300_000),
      });
      setTxHashes((h) => ({ ...h, mint: mintTx.hash }));
      setStep("complete");
      // Bridge fully landed — persisted record is no longer useful.
      clearPending();
      toast.success("USDC bridged");
    } catch (mintErr) {
      setError(mintErr instanceof Error ? mintErr.message : String(mintErr));
      setStep("error");
    }
  }, [quote, attestation, effectiveAddress, activeChainId, setActiveChain, unifiedWriteAndWait]);

  return {
    step,
    error,
    txHashes,
    attestationStatus,
    attestation,
    quote,
    start,
    claim,
    reset,
    resumable,
    resume,
  };
}
