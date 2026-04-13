import { useState, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, SUPPORTED_CHAIN_ID, type EncryptedInput } from "@/lib/constants";
import { PaymentHubAbi } from "@/lib/abis";
import { useCofheEncrypt } from "@/lib/cofhe-shim";
import { insertActivity } from "@/lib/supabase";
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
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { unifiedWrite } = useUnifiedWrite();
  const { encryptInputsAsync } = useCofheEncrypt();

  const [step, setStep] = useState<AgentStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastAttestation, setLastAttestation] = useState<AgentAttestation | null>(null);

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
            chainId: SUPPORTED_CHAIN_ID,
            paymentHubAddress: CONTRACTS.PaymentHub,
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
    [address],
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
      try {
        // Ensure the PaymentHub has vault allowance (one-time per session per hub)
        if (!isVaultApproved(CONTRACTS.PaymentHub)) {
          setStep("approving");
          await ensureVaultApproval(
            unifiedWrite,
            CONTRACTS.FHERC20Vault_USDC,
            CONTRACTS.PaymentHub,
          );
          markVaultApproved(CONTRACTS.PaymentHub);
        }

        setStep("encrypting");
        const [encAmount] = await encryptInputsAsync([Encryptable.uint64(attestation.amount)]);

        setStep("sending");
        const hash = await unifiedWrite({
          address: CONTRACTS.PaymentHub,
          abi: PaymentHubAbi,
          functionName: "sendPaymentAsAgent",
          args: [
            to,
            CONTRACTS.FHERC20Vault_USDC,
            encAmount as unknown as EncryptedInput,
            note,
            attestation.agent,
            attestation.nonce,
            BigInt(attestation.expiry),
            attestation.signature,
          ],
          gas: BigInt(5_000_000),
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") throw new Error("Transaction reverted on-chain");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: to.toLowerCase(),
          activity_type: "agent_payment",
          contract_address: CONTRACTS.PaymentHub,
          note: note || `Agent ${attestation.agent.slice(0, 6)}…${attestation.agent.slice(-4)}`,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        setStep("success");
        toast.success("Agent payment submitted on-chain!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent payment failed";
        if (msg.includes("allowance") || msg.includes("approve")) {
          clearVaultApproval(CONTRACTS.PaymentHub);
        }
        setStep("error");
        setError(msg);
        toast.error(msg);
        return null;
      }
    },
    [address, publicClient, unifiedWrite, encryptInputsAsync],
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
    derive,
    submit,
    reset,
  };
}
