import { useState, useCallback, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { PaymentHubAbi } from "@/lib/abis";
import { useCofheEncrypt } from "@/lib/cofhe-shim";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64 } from "@/lib/constants";
import { useUnifiedWrite } from "./useUnifiedWrite";

// ────────────────────────────────────────────────────────────────────
//  useAgentPayment — derive a payment amount via server-side Claude,
//  sign it with the platform agent key, and submit on-chain with
//  cryptographically-attestable provenance.
//
//  Two-stage flow exposed to the UI:
//   1. derive(template, context) → returns { amount, agent, nonce, expiry,
//      signature, raw } so the UI can show the user what the agent
//      proposed BEFORE they sign anything (advisory, user-final).
//   2. submit(to, attestation) → encrypts amount, calls sendPaymentAsAgent.
//      Contract verifies ECDSA, emits AgentPaymentSubmission event.
//
//  Trust model: the agent address is published; anyone watching the chain
//  can verify which agent attested to which submission. The frontend can
//  cheat the displayed `raw` text but cannot cheat the on-chain agent
//  address — that's the whole point of doing the signing server-side.
// ────────────────────────────────────────────────────────────────────

export type AgentTemplate = "payroll_line" | "expense_share";
export type AgentStep = "idle" | "deriving" | "approving" | "encrypting" | "sending" | "success" | "error";

export interface AgentAttestation {
  amount: bigint;
  agent: `0x${string}`;
  nonce: `0x${string}`;
  expiry: number;
  signature: `0x${string}`;
  raw: string;
  template: AgentTemplate;
  /** Provider that produced the number (kimi | anthropic). Undefined on legacy responses. */
  provider?: string;
  /** Model id (e.g. "moonshotai/kimi-k2-instruct"). Undefined on legacy responses. */
  model?: string;
}

async function ensureVaultApproval(
  unifiedWrite: ReturnType<typeof useUnifiedWrite>["unifiedWrite"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
) {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    await unifiedWrite({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
      gas: BigInt(5_000_000),
    });
    toast.success("Approval granted!", { id: toastId });
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

export function useAgentPayment() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const { encryptInputsAsync } = useCofheEncrypt();

  const [step, setStep] = useState<AgentStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastAttestation, setLastAttestation] = useState<AgentAttestation | null>(null);

  // Block-timestamp reference for expiry math. The contract compares the
  // attestation expiry against `block.timestamp`, not the user's wall clock —
  // a skewed client clock can make a still-valid attestation look expired
  // (or vice versa). Fetch the latest block timestamp on mount and every
  // 10s so the UI countdown + pre-submit check track the chain, not local time.
  const [blockTimestamp, setBlockTimestamp] = useState<number | null>(null);
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    const fetchTs = async () => {
      try {
        const block = await publicClient.getBlock({ blockTag: "latest" });
        if (!cancelled) setBlockTimestamp(Number(block.timestamp));
      } catch {
        /* noop — stale timestamp is fine for countdown display */
      }
    };
    fetchTs();
    const id = setInterval(fetchTs, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [publicClient]);

  // Stage 1: ask the server to derive an amount and produce a signed attestation.
  // Returns null on any failure — `error` state is populated.
  const derive = useCallback(
    async (template: AgentTemplate, context: string): Promise<AgentAttestation | null> => {
      if (!address) {
        toast.error("Connect your wallet first");
        return null;
      }
      setStep("deriving");
      setError(null);
      const toastId = toast.loading("Asking the agent to derive amount...");
      try {
        const res = await fetch("/api/agent/derive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: address,
            template,
            context,
            chainId: activeChainId,
            paymentHubAddress: contracts.PaymentHub,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        const attestation: AgentAttestation = {
          amount: BigInt(data.amount),
          agent: data.agent as `0x${string}`,
          nonce: data.nonce as `0x${string}`,
          expiry: Number(data.expiry),
          signature: data.signature as `0x${string}`,
          raw: String(data.raw ?? ""),
          template,
          provider: data.provider,
          model: data.model,
        };
        setLastAttestation(attestation);
        toast.success("Agent derived amount — review and submit", { id: toastId });
        setStep("idle");
        return attestation;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent derivation failed";
        setStep("error");
        setError(msg);
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [address, activeChainId, contracts],
  );

  // Stage 2: encrypt the attested amount and submit on-chain.
  const submit = useCallback(
    async (to: `0x${string}`, attestation: AgentAttestation, note: string): Promise<`0x${string}` | null> => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return null;
      }
      if (to.toLowerCase() === address.toLowerCase()) {
        toast.error("Recipient must be different from sender");
        return null;
      }
      // Block-timestamp-aware expiry guard: the contract checks the
      // attestation against `block.timestamp`, not local wall-clock time.
      // Refuse to submit if we're within 30s of on-chain expiry (covers
      // block time + tx inclusion lag + a small safety buffer).
      const referenceTs = blockTimestamp ?? Math.floor(Date.now() / 1000);
      if (attestation.expiry - referenceTs <= 30) {
        toast.error("Attestation about to expire — re-derive");
        return null;
      }
      try {
        // Ensure the PaymentHub has vault allowance (one-time per session per hub)
        if (!isVaultApproved(contracts.PaymentHub)) {
          setStep("approving");
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC,
            contracts.PaymentHub,
          );
          markVaultApproved(contracts.PaymentHub);
        }

        setStep("encrypting");
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(attestation.amount)]);

        setStep("sending");
        const agentPayResult = await unifiedWriteAndWait({
          address: contracts.PaymentHub,
          abi: PaymentHubAbi,
          functionName: "sendPaymentAsAgent",
          args: [
            to,
            contracts.FHERC20Vault_USDC,
            encAmount as unknown as EncryptedInput,
            note,
            attestation.agent,
            attestation.nonce,
            BigInt(attestation.expiry),
            attestation.signature,
          ],
          gas: BigInt(5_000_000),
        });
        const hash = agentPayResult.hash;
        const receipt = agentPayResult.receipt
          ? agentPayResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") throw new Error("Transaction reverted on-chain");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: to.toLowerCase(),
          activity_type: ACTIVITY_TYPES.AGENT_PAYMENT,
          contract_address: contracts.PaymentHub,
          note: note || `Agent ${attestation.agent.slice(0, 6)}…${attestation.agent.slice(-4)}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStep("success");
        toast.success("Agent payment submitted on-chain!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent payment failed";
        if (msg.includes("allowance") || msg.includes("approve")) {
          clearVaultApproval(contracts.PaymentHub);
        }
        setStep("error");
        setError(msg);
        toast.error(msg);
        return null;
      }
    },
    [address, publicClient, unifiedWrite, unifiedWriteAndWait, encryptInputsAsync, contracts, blockTimestamp],
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
    setLastAttestation(null);
  }, []);

  return {
    step,
    error,
    lastAttestation,
    blockTimestamp,
    derive,
    submit,
    reset,
  };
}
