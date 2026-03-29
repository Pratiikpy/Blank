import { useState, useCallback } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { GiftMoneyAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

// ─── Gift creation rate limiting (#58) ──────────────────────────────
const GIFT_RATE_KEY = "blank_gift_timestamps";
const GIFT_MAX_PER_HOUR = 5;

// ─── Step Machine ───────────────────────────────────────────────────

export type GiftStep =
  | "input"
  | "approving"
  | "encrypting"
  | "confirming"
  | "sending"
  | "success"
  | "error";

export interface GiftMoneyState {
  step: GiftStep;
  isProcessing: boolean;
  error: string | null;
  txHash: string | null;
  encryptionProgress: number;
}

const initialState: GiftMoneyState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  encryptionProgress: 0,
};

async function ensureVaultApproval(
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
  vaultAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
) {
  const toastId = toast.loading("First time! Approving encrypted transfers...");
  try {
    await writeContractAsync({
      address: vaultAddress,
      abi: FHERC20VaultAbi,
      functionName: "approvePlaintext",
      args: [spenderAddress, MAX_UINT64],
    });
    toast.success("Approval granted!", { id: toastId });
  } catch (err) {
    toast.error("Approval failed", { id: toastId });
    throw err;
  }
}

/**
 * Compute random splits off-chain for a given total amount and recipient count.
 * Returns an array of string amounts (in token units, e.g., "2.500000")
 * that sum exactly to the total. Uses a "cut the rope" algorithm:
 * generate N-1 random cut points, sort them, and take differences.
 *
 * All shares have a minimum floor of 0.01 tokens to avoid zero-value gifts.
 */
export function computeRandomSplits(totalAmount: string, recipientCount: number): string[] {
  const total = parseFloat(totalAmount);
  if (recipientCount <= 0 || total <= 0) return [];
  if (recipientCount === 1) return [totalAmount];

  const MIN_SHARE = 0.01;
  const minTotal = MIN_SHARE * recipientCount;
  if (total < minTotal) {
    // If total is too small for minimum shares, split equally
    const equal = (total / recipientCount).toFixed(6);
    return Array(recipientCount).fill(equal);
  }

  // Allocate minimum to each, then randomly distribute the remainder
  const remainder = total - minTotal;
  const cuts: number[] = [];
  for (let i = 0; i < recipientCount - 1; i++) {
    cuts.push(Math.random() * remainder);
  }
  cuts.sort((a, b) => a - b);

  const shares: number[] = [];
  let prev = 0;
  for (let i = 0; i < cuts.length; i++) {
    shares.push(MIN_SHARE + (cuts[i] - prev));
    prev = cuts[i];
  }
  shares.push(MIN_SHARE + (remainder - prev));

  // Fix floating point: ensure shares sum exactly to total
  const sumShares = shares.reduce((a, b) => a + b, 0);
  const diff = total - sumShares;
  shares[shares.length - 1] += diff;

  return shares.map((s) => Math.max(0, s).toFixed(6));
}

/**
 * Compute equal splits off-chain for a given total amount and recipient count.
 * Last recipient gets any remainder to ensure exact sum.
 */
export function computeEqualSplits(totalAmount: string, recipientCount: number): string[] {
  const total = parseFloat(totalAmount);
  if (recipientCount <= 0 || total <= 0) return [];
  if (recipientCount === 1) return [totalAmount];

  const perPerson = Math.floor((total / recipientCount) * 1_000_000) / 1_000_000;
  const shares = Array(recipientCount).fill(perPerson.toFixed(6));

  // Give remainder to last person
  const allocated = perPerson * (recipientCount - 1);
  const lastShare = total - allocated;
  shares[recipientCount - 1] = lastShare.toFixed(6);

  return shares as string[];
}

export function useGiftMoney() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<GiftMoneyState>(initialState);

  // ─── Create Gift Envelope ───────────────────────────────────────────

  const createGift = useCallback(
    async (
      vault: string,
      shares: string[],
      recipients: string[],
      note: string
    ) => {
      if (!address || !connected) return;
      if (state.isProcessing) return; // Already submitting
      if (shares.length === 0 || shares.length !== recipients.length) {
        toast.error("Shares and recipients must match");
        return;
      }

      // Rate limiting: max 5 gifts per hour (#58)
      try {
        const now = Date.now();
        const raw = localStorage.getItem(GIFT_RATE_KEY);
        const timestamps: number[] = raw ? JSON.parse(raw).filter((t: number) => now - t < 3_600_000) : [];
        if (timestamps.length >= GIFT_MAX_PER_HOUR) {
          toast.error("Gift limit reached (5 per hour). Please wait before creating more.");
          return;
        }
      } catch {}

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        setState((s) => ({ ...s, step: "approving", isProcessing: true, error: null }));

        const vaultAddress = vault as `0x${string}`;
        const giftMoneyAddress = CONTRACTS.GiftMoney as `0x${string}`;

        // Ensure GiftMoney contract is approved to transferFrom on the vault
        if (!isVaultApproved(CONTRACTS.GiftMoney)) {
          await ensureVaultApproval(writeContractAsync, vaultAddress, giftMoneyAddress);
          markVaultApproved(CONTRACTS.GiftMoney);
        }

        // Encrypt each share individually
        setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

        const encryptedShares = await encryptInputsAsync(
          shares.map((s) => Encryptable.uint64(parseUnits(s, 6)))
        );

        setState((s) => ({ ...s, step: "confirming", encryptionProgress: 100 }));

        // Submit the transaction
        setState((s) => ({ ...s, step: "sending" }));

        const hash = await writeContractAsync({
          address: giftMoneyAddress,
          abi: GiftMoneyAbi,
          functionName: "createEnvelope",
          args: [
            vaultAddress,
            recipients as `0x${string}`[],
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encryptedShares as unknown as EncryptedInput[],
            note,
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const giftReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (giftReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        setState((s) => ({
          ...s,
          step: "success",
          isProcessing: false,
          txHash: hash,
        }));

        // Record gift creation timestamp for rate limiting
        try {
          const now = Date.now();
          const raw = localStorage.getItem(GIFT_RATE_KEY);
          const timestamps: number[] = raw ? JSON.parse(raw).filter((t: number) => now - t < 3_600_000) : [];
          timestamps.push(now);
          localStorage.setItem(GIFT_RATE_KEY, JSON.stringify(timestamps));
        } catch {}

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        // Sync to Supabase for each recipient (unique tx_hash per recipient
        // since insertActivity upserts on tx_hash)
        for (const recipient of recipients) {
          await insertActivity({
            tx_hash: `${hash}_${recipient.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: recipient.toLowerCase(),
            activity_type: "gift_created",
            contract_address: giftMoneyAddress,
            note,
            token_address: CONTRACTS.TestUSDC,
            block_number: Number(giftReceipt.blockNumber),
          });
        }

        toast.success("Gift envelope created!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create gift";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.GiftMoney);
        }
        setState((s) => ({
          ...s,
          step: "error",
          isProcessing: false,
          error: msg,
        }));
        toast.error(msg);
      }
    },
    [address, connected, state.isProcessing, encryptInputsAsync, writeContractAsync, publicClient]
  );

  // ─── Claim (Open) Gift ──────────────────────────────────────────────

  const claimGift = useCallback(
    async (envelopeId: number) => {
      if (!address || !connected) return;
      if (state.isProcessing) return; // Already submitting

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        setState((s) => ({ ...s, step: "sending", isProcessing: true, error: null }));

        const giftMoneyAddress = CONTRACTS.GiftMoney as `0x${string}`;

        const hash = await writeContractAsync({
          address: giftMoneyAddress,
          abi: GiftMoneyAbi,
          functionName: "claimGift",
          args: [BigInt(envelopeId)],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const claimReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (claimReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        setState((s) => ({
          ...s,
          step: "success",
          isProcessing: false,
          txHash: hash,
        }));

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "gift_claimed",
          contract_address: giftMoneyAddress,
          note: `Opened gift envelope #${envelopeId}`,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(claimReceipt.blockNumber),
        });

        toast.success("Gift opened!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to open gift";
        setState((s) => ({
          ...s,
          step: "error",
          isProcessing: false,
          error: msg,
        }));
        toast.error(msg);
      }
    },
    [address, connected, state.isProcessing, writeContractAsync, publicClient]
  );

  // ─── Reset ──────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    createGift,
    claimGift,
    computeRandomSplits,
    computeEqualSplits,
    reset,
  };
}
