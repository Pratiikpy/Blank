import { useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { GiftMoneyAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { insertActivitiesFanout } from "@/lib/activity-fanout";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";

// ─── Gift creation rate limiting (#58) ──────────────────────────────
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
      gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
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
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();

  const [state, setState] = useState<GiftMoneyState>(initialState);

  // ─── Create Gift Envelope ───────────────────────────────────────────

  const createGift = useCallback(
    async (
      vault: string,
      shares: string[],
      recipients: string[],
      note: string,
      expiryTimestamp: number = 0
    ) => {
      if (!address || !connected) return;
      if (state.isProcessing) return; // Already submitting
      if (shares.length === 0 || shares.length !== recipients.length) {
        toast.error("Shares and recipients must match");
        return;
      }

      // Rate limiting: max 5 gifts per hour (#58)
      {
        const now = Date.now();
        const stored = getStoredJson<number[]>(STORAGE_KEYS.giftRateLimit(), []);
        const timestamps = stored.filter((t: number) => now - t < 3_600_000);
        if (timestamps.length >= GIFT_MAX_PER_HOUR) {
          toast.error("Gift limit reached (5 per hour). Please wait before creating more.");
          return;
        }
      }

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        setState((s) => ({ ...s, step: "approving", isProcessing: true, error: null }));

        const vaultAddress = vault as `0x${string}`;
        const giftMoneyAddress = contracts.GiftMoney as `0x${string}`;

        // Ensure GiftMoney contract is approved to transferFrom on the vault
        if (!isVaultApproved(contracts.GiftMoney)) {
          await ensureVaultApproval(unifiedWrite, vaultAddress, giftMoneyAddress);
          markVaultApproved(contracts.GiftMoney);
        }

        // Validate all share amounts before encrypting
        for (const s of shares) {
          if (!s || s.trim() === "") {
            toast.error("All gift share amounts must be filled in");
            setState((s) => ({ ...s, step: "input", isProcessing: false }));
            return;
          }
        }

        // Encrypt each share individually
        setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

        const encryptedShares = await encryptInputsAsync(
          shares.map((s) => Encryptable.uint64(parseUnits(s, 6)))
        );

        setState((s) => ({ ...s, step: "confirming", encryptionProgress: 100 }));

        // Submit the transaction
        setState((s) => ({ ...s, step: "sending" }));

        const writeResult = await unifiedWriteAndWait({
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
            BigInt(expiryTimestamp),
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = writeResult.hash;

        // AA path: relayer's receipt is in writeResult.receipt — no chain
        // poll needed. EOA path: receipt is undefined, so poll the chain
        // (wagmi-injected publicClient is fine for an EOA-side write since
        // there's no relayer-vs-frontend RPC race in that case).
        type ReceiptShape = {
          status: "success" | "reverted";
          blockNumber: bigint;
          logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        };
        let giftReceipt: ReceiptShape;
        if (writeResult.receipt) {
          giftReceipt = {
            status: writeResult.receipt.status,
            blockNumber: writeResult.receipt.blockNumber,
            logs: writeResult.receipt.logs as ReceiptShape["logs"],
          };
        } else {
          const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          giftReceipt = {
            status: r.status,
            blockNumber: r.blockNumber,
            logs: r.logs as ReceiptShape["logs"],
          };
        }
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
        {
          const now = Date.now();
          const stored = getStoredJson<number[]>(STORAGE_KEYS.giftRateLimit(), []);
          const timestamps = stored.filter((t: number) => now - t < 3_600_000);
          timestamps.push(now);
          setStoredJson(STORAGE_KEYS.giftRateLimit(), timestamps);
        }

        // Extract envelope ID from the contract event logs
        const envelopeId = extractEventId(giftReceipt.logs, contracts.GiftMoney);
        const envelopeNote = envelopeId
          ? `[envelope:${envelopeId}] ${note || "Gift envelope"}`
          : note || "Gift envelope";

        // Sync to Supabase for each recipient + the sender-copy row, all in
        // parallel via Promise.allSettled so a single row failure doesn't halt
        // sync for the remaining rows. Unique tx_hash per row (recipient
        // address or `_sender`) since insertActivity upserts on tx_hash.
        await insertActivitiesFanout(
          [
            ...recipients.map((recipient) => ({
              tx_hash: `${hash}_${recipient.toLowerCase()}`,
              user_from: address.toLowerCase(),
              user_to: recipient.toLowerCase(),
              activity_type: ACTIVITY_TYPES.GIFT_CREATED,
              contract_address: giftMoneyAddress,
              note: envelopeNote,
              token_address: contracts.TestUSDC,
              block_number: Number(giftReceipt.blockNumber),
            })),
            {
              tx_hash: `${hash}_sender`,
              user_from: address.toLowerCase(),
              user_to: address.toLowerCase(),
              activity_type: ACTIVITY_TYPES.GIFT_CREATED,
              contract_address: giftMoneyAddress,
              note: envelopeNote,
              token_address: contracts.TestUSDC,
              block_number: Number(giftReceipt.blockNumber),
            },
          ],
          { userToastOnFailure: true, context: "gift-create" },
        );

        // #253: broadcasts must fire AFTER insertActivitiesFanout completes —
        // if they fired earlier, the cross-tab listener would refetch while
        // the inserts were still in flight and miss the new rows.
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Gift envelope created!");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create gift";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.GiftMoney);
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
    [address, connected, state.isProcessing, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
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

        const giftMoneyAddress = contracts.GiftMoney as `0x${string}`;

        // unifiedWriteAndWait returns the relay-side receipt (tx.wait() already
        // happened server-side) — skip the unreliable public-RPC poll that
        // caused claim-never-lands timeouts under testnet RPC throttling.
        const claimResult = await unifiedWriteAndWait({
          address: giftMoneyAddress,
          abi: GiftMoneyAbi,
          functionName: "claimGift",
          args: [BigInt(envelopeId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = claimResult.hash;
        const claimReceipt = claimResult.receipt
          ? claimResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
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
          activity_type: ACTIVITY_TYPES.GIFT_CLAIMED,
          contract_address: giftMoneyAddress,
          note: `Opened gift envelope #${envelopeId}`,
          token_address: contracts.TestUSDC,
          block_number: Number(claimReceipt.blockNumber),
        });

        // #90: claimGift previously emitted no broadcast, so the user's own
        // Received-Gifts list kept the claimed envelope visible until reload.
        broadcastAction("activity_added");
        broadcastAction("balance_changed");
        invalidateBalanceQueries();

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
    [address, connected, state.isProcessing, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  // ─── Deactivate Envelope ─────────────────────────────────────────────

  const deactivateEnvelope = useCallback(
    async (envelopeId: number) => {
      if (!address || !connected) return;
      if (state.isProcessing) return;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        setState((s) => ({ ...s, step: "sending", isProcessing: true, error: null }));

        const giftMoneyAddress = contracts.GiftMoney as `0x${string}`;

        const deactivateResult = await unifiedWriteAndWait({
          address: giftMoneyAddress,
          abi: GiftMoneyAbi,
          functionName: "deactivateEnvelope",
          args: [BigInt(envelopeId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = deactivateResult.hash;
        const receipt = deactivateResult.receipt
          ? deactivateResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        setState((s) => ({
          ...s,
          step: "success",
          isProcessing: false,
          txHash: hash,
        }));

        // #196: persist a typed activity row so the sender (and any past
        // recipients tailing the feed) can audit envelope-state changes.
        // The deactivation is an admin action by the sender on their own
        // envelope, so user_to == user_from (same as the sender-copy row
        // pattern used in createGift).
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.GIFT_DEACTIVATED,
          contract_address: giftMoneyAddress,
          note: `Deactivated envelope #${envelopeId}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        // #126: deactivate previously only broadcast activity. While it
        // doesn't transfer tokens, the sender's balance-view may still need
        // to refetch if envelope refunds affect vault ledger.
        broadcastAction("activity_added");
        broadcastAction("balance_changed");
        invalidateBalanceQueries();
        toast.success("Envelope deactivated");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to deactivate envelope";
        setState((s) => ({
          ...s,
          step: "error",
          isProcessing: false,
          error: msg,
        }));
        toast.error(msg);
      }
    },
    [address, connected, state.isProcessing, unifiedWrite, publicClient, contracts]
  );

  // ─── Set Expiry ────────────────────────────────────────────────────

  const setExpiry = useCallback(
    async (envelopeId: number, expiryTimestamp: number) => {
      if (!address || !connected) return;
      if (state.isProcessing) return;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        setState((s) => ({ ...s, step: "sending", isProcessing: true, error: null }));

        const giftMoneyAddress = contracts.GiftMoney as `0x${string}`;

        const hash = await unifiedWrite({
          address: giftMoneyAddress,
          abi: GiftMoneyAbi,
          functionName: "setExpiry",
          args: [BigInt(envelopeId), BigInt(expiryTimestamp)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        setState((s) => ({
          ...s,
          step: "success",
          isProcessing: false,
          txHash: hash,
        }));

        // #196: persist a typed activity row + cross-tab broadcast so this
        // admin action shows up in the sender's feed and propagates to other
        // tabs. expiryTimestamp == 0 means "no expiry" (per contract).
        const expiryNote =
          expiryTimestamp === 0
            ? `Cleared expiry on envelope #${envelopeId}`
            : `Updated envelope #${envelopeId} expiry to ${new Date(
                expiryTimestamp * 1000,
              ).toISOString()}`;
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.GIFT_EXPIRY_CHANGED,
          contract_address: giftMoneyAddress,
          note: expiryNote,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        toast.success("Expiry updated");
        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to set expiry";
        setState((s) => ({
          ...s,
          step: "error",
          isProcessing: false,
          error: msg,
        }));
        toast.error(msg);
      }
    },
    [address, connected, state.isProcessing, unifiedWrite, publicClient, contracts]
  );

  // ─── Reset ──────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    createGift,
    claimGift,
    deactivateEnvelope,
    setExpiry,
    computeRandomSplits,
    computeEqualSplits,
    reset,
  };
}
