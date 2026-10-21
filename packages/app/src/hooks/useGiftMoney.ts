import { useState, useCallback, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForTx, ENCRYPTION_NOT_READY } from "@/lib/cofhe-shim";
import { runFundingGate, supportsFundingGate, FundingGateTimeout } from "@/lib/funding-gate";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { MAX_UINT64 } from "@/lib/constants";
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
  | "funding"
  | "success"
  | "error";

/** GiftMoney.FundingStatus, by name. Envelopes from before the funding gate read as "active". */
export type GiftFunding = "active" | "pending" | "void";
const FUNDING_PENDING = 1;

export interface GiftMoneyState {
  step: GiftStep;
  isProcessing: boolean;
  error: string | null;
  txHash: string | null;
  encryptionProgress: number;
  /** Envelope created by the last createGift, so the screen can finish it. */
  lastEnvelopeId: number | null;
  /** Funding verdict for lastEnvelopeId. Null on a contract that predates the funding gate. */
  funding: GiftFunding | null;
}

const initialState: GiftMoneyState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  encryptionProgress: 0,
  lastEnvelopeId: null,
  funding: null,
};

/** Shown when any share fell short. The shares that did move stay with their recipients. */
export const GIFT_UNFUNDED_MESSAGE =
  "The gift was not fully funded: your private balance was too low for at least one share, so the envelope is void. Some recipients may already have received their share.";

function pendingFundingMessage(envelopeId: number, err: unknown): string {
  const reason = err instanceof FundingGateTimeout ? "the funding check is not ready yet" : err instanceof Error ? err.message : String(err);
  return `Envelope #${envelopeId} was created but its funding is not confirmed (${reason}). It cannot be opened until it is. Press Finish funding to retry.`;
}

/** Turns the contract's funding-gate reverts into something a recipient can act on. */
export function friendlyGiftError(message: string): string {
  if (message.includes("funding pending")) return "This gift is still being funded. Try again in a minute.";
  if (message.includes("envelope unfunded")) return "This gift was never fully funded, so it cannot be opened.";
  return message;
}

// confirmFunding bumps the receipts counters for every recipient, so gas grows
// with the envelope size. GiftMoney allows at most 30 recipients.
const GIFT_CONFIRM_GAS_BASE = 1_500_000;
const GIFT_CONFIRM_GAS_PER_RECIPIENT = 600_000;
const GIFT_MAX_RECIPIENTS = 30;
function confirmGas(recipientCount: number): bigint {
  const n = Math.min(Math.max(recipientCount, 1), GIFT_MAX_RECIPIENTS);
  return BigInt(GIFT_CONFIRM_GAS_BASE + GIFT_CONFIRM_GAS_PER_RECIPIENT * n);
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

  // Allocate minimum to each, then randomly distribute the remainder.
  // Use crypto.getRandomValues instead of Math.random — for a "random
  // split" feature, observers who can predict Math.random's seed could
  // reconstruct the share each recipient gets before they claim. CSPRNG
  // closes that transparency-of-fairness gap. Cost: ~zero, same math.
  const remainder = total - minTotal;
  const cutCount = recipientCount - 1;
  const cuts: number[] = [];
  if (cutCount > 0) {
    const buf = new Uint32Array(cutCount);
    crypto.getRandomValues(buf);
    // Map each uint32 to a uniform [0, remainder) float. Dividing by
    // 2^32 gives a value in [0, 1) without bias for non-power-of-2
    // ranges (we're scaling to `remainder`, not bucketing into ints).
    for (let i = 0; i < cutCount; i++) {
      cuts.push((buf[i] / 0x1_0000_0000) * remainder);
    }
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

  const { decryptForTx } = useCofheDecryptForTx();

  const [state, setState] = useState<GiftMoneyState>(initialState);

  // Chains whose GiftMoney has the funding gate. Only a positive probe is
  // kept: a failed probe may be a flaky RPC, so the next call asks again.
  const gateSupport = useRef(new Set<string>());
  const gateSupported = useCallback(
    async (gm: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${gm.toLowerCase()}`;
      if (gateSupport.current.has(key)) return true;
      if (!publicClient) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ok = await supportsFundingGate(() =>
          publicClient.readContract({ address: gm, abi: GiftMoneyAbi, functionName: "getFundingCheck", args: [0n] }),
        );
        if (ok) {
          gateSupport.current.add(key);
          return true;
        }
      }
      return false;
    },
    [activeChainId, publicClient],
  );

  // Decrypts "every share moved" for a PendingFunding envelope and publishes
  // it. Anyone can run it, so an envelope another tab or user already settled
  // is a no-op.
  const runGate = useCallback(
    async (gm: `0x${string}`, envelopeId: number, recipientCount?: number): Promise<boolean> => {
      const client = publicClient!;
      const { funded } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: gm,
              abi: GiftMoneyAbi,
              functionName: "getFundingCheck",
              args: [BigInt(envelopeId)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            const status = await client.readContract({
              address: gm,
              abi: GiftMoneyAbi,
              functionName: "fundingStatus",
              args: [BigInt(envelopeId)],
            });
            if (Number(status) !== FUNDING_PENDING) return;
          } catch {
            // Status unreadable: let the write decide.
          }
          let count = recipientCount;
          if (count === undefined) {
            try {
              const env = (await client.readContract({
                address: gm,
                abi: GiftMoneyAbi,
                functionName: "getEnvelope",
                args: [BigInt(envelopeId)],
              })) as readonly unknown[];
              count = Number(env[2]);
            } catch {
              count = GIFT_MAX_RECIPIENTS;
            }
          }
          const r = await unifiedWriteAndWait({
            address: gm,
            abi: GiftMoneyAbi,
            functionName: "confirmFunding",
            args: [BigInt(envelopeId), verdict, signature],
            gas: confirmGas(count),
          });
          if (r.receipt?.status === "reverted") throw new Error("confirmFunding reverted on-chain");
        },
      });
      return funded;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // ─── Create Gift Envelope ───────────────────────────────────────────

  const createGift = useCallback(
    async (
      vault: string,
      shares: string[],
      recipients: string[],
      note: string,
      expiryTimestamp: number = 0
    ) => {
      if (!address) return;
      if (!connected) { toast.error(ENCRYPTION_NOT_READY); return; }
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
        const gated = await gateSupported(giftMoneyAddress);

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
        ,
        contracts.GiftMoney as `0x${string}`);

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
            encryptedShares.slice(0, -1),
            encryptedShares[encryptedShares.length - 1],
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
        if (envelopeId === null) {
          throw new Error("Tx mined but envelopeId could not be read; check History tab.");
        }
        const envelopeNote = `[envelope:${envelopeId}] ${note || "Gift envelope"}`;

        // The envelope is only openable once every share is shown to have
        // moved. A gate that cannot finish leaves it PendingFunding on-chain,
        // which anyone can settle later, so that case is not an error here.
        let funding: GiftFunding | null = null;
        let pendingNote: string | null = null;
        if (gated) {
          setState((s) => ({ ...s, step: "funding", txHash: hash, lastEnvelopeId: envelopeId }));
          try {
            funding = (await runGate(giftMoneyAddress, envelopeId, recipients.length)) ? "active" : "void";
          } catch (gateErr) {
            funding = "pending";
            pendingNote = pendingFundingMessage(envelopeId, gateErr);
          }
        }

        // Sync to Supabase for each recipient + the sender-copy row, all in
        // parallel via Promise.allSettled so a single row failure doesn't halt
        // sync for the remaining rows. Unique tx_hash per row (recipient
        // address or `_sender`) since insertActivity upserts on tx_hash. A void
        // envelope only gets the sender-copy row: recipients have nothing to open.
        const senderRow = {
          tx_hash: `${hash}_sender`,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.GIFT_CREATED,
          contract_address: giftMoneyAddress,
          note: envelopeNote,
          token_address: contracts.TestUSDC,
          block_number: Number(giftReceipt.blockNumber),
        };
        await insertActivitiesFanout(
          [
            ...(funding === "void"
              ? []
              : recipients.map((recipient) => ({
                  tx_hash: `${hash}_${recipient.toLowerCase()}`,
                  user_from: address.toLowerCase(),
                  user_to: recipient.toLowerCase(),
                  activity_type: ACTIVITY_TYPES.GIFT_CREATED,
                  contract_address: giftMoneyAddress,
                  note: envelopeNote,
                  token_address: contracts.TestUSDC,
                  block_number: Number(giftReceipt.blockNumber),
                }))),
            senderRow,
          ],
          { userToastOnFailure: true, context: "gift-create" },
        );

        // #253: broadcasts must fire AFTER insertActivitiesFanout completes —
        // if they fired earlier, the cross-tab listener would refetch while
        // the inserts were still in flight and miss the new rows.
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        if (funding === "void") {
          setState((s) => ({
            ...s,
            step: "error",
            isProcessing: false,
            error: GIFT_UNFUNDED_MESSAGE,
            txHash: hash,
            lastEnvelopeId: envelopeId,
            funding,
          }));
          toast.error(GIFT_UNFUNDED_MESSAGE);
          return;
        }

        setState((s) => ({
          ...s,
          step: "success",
          isProcessing: false,
          txHash: hash,
          lastEnvelopeId: envelopeId,
          funding,
        }));
        if (pendingNote) toast.error(pendingNote);
        else toast.success("Gift envelope created!");
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
    [address, connected, state.isProcessing, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts, gateSupported, runGate]
  );

  // ─── Finish Funding ─────────────────────────────────────────────────

  /**
   * Finish an envelope left PendingFunding (the funding check timed out, or the
   * tab closed). Anyone can run it. Returns the verdict, or null when it could
   * not be completed; the envelope then stays pending and can be retried.
   */
  const finishFunding = useCallback(
    async (envelopeId: number): Promise<"funded" | "unfunded" | null> => {
      if (!address) return null;
      if (state.isProcessing) return null;
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }
      const giftMoneyAddress = contracts.GiftMoney as `0x${string}`;
      if (!(await gateSupported(giftMoneyAddress))) {
        toast.error("This gift contract has no funding check to finish.");
        return null;
      }
      const isCurrent = state.lastEnvelopeId === envelopeId;
      setState((s) => ({ ...s, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Confirming funding...");
      try {
        const funded = await runGate(giftMoneyAddress, envelopeId);
        invalidateBalanceQueries();
        broadcastAction("balance_changed");
        setState((s) =>
          funded
            ? { ...s, step: "success", isProcessing: false, funding: isCurrent ? "active" : s.funding }
            : {
                ...s,
                step: "error",
                isProcessing: false,
                error: GIFT_UNFUNDED_MESSAGE,
                funding: isCurrent ? "void" : s.funding,
              },
        );
        if (funded) toast.success("Gift funded", { id: toastId });
        else toast.error(GIFT_UNFUNDED_MESSAGE, { id: toastId });
        return funded ? "funded" : "unfunded";
      } catch (err) {
        const msg = pendingFundingMessage(envelopeId, err);
        setState((s) => ({ ...s, step: isCurrent ? "success" : "error", isProcessing: false, error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [address, state.isProcessing, state.lastEnvelopeId, publicClient, contracts.GiftMoney, gateSupported, runGate],
  );

  // ─── Claim (Open) Gift ──────────────────────────────────────────────

  const claimGift = useCallback(
    async (envelopeId: number) => {
      // No `connected` gate: this call carries no encrypted argument, so it
      // does not need the CoFHE client. Requiring it made the button a silent
      // no-op for anyone whose smart account is not deployed yet — which is
      // exactly the state a brand new recipient is in.
      if (!address) return;
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
        const msg = friendlyGiftError(err instanceof Error ? err.message : "Failed to open gift");
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
      // No `connected` gate: this call carries no encrypted argument, so it
      // does not need the CoFHE client. Requiring it made the button a silent
      // no-op for anyone whose smart account is not deployed yet — which is
      // exactly the state a brand new recipient is in.
      if (!address) return;
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
      // No `connected` gate: this call carries no encrypted argument, so it
      // does not need the CoFHE client. Requiring it made the button a silent
      // no-op for anyone whose smart account is not deployed yet — which is
      // exactly the state a brand new recipient is in.
      if (!address) return;
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
    finishFunding,
    claimGift,
    deactivateEnvelope,
    setExpiry,
    computeRandomSplits,
    computeEqualSplits,
    reset,
  };
}
