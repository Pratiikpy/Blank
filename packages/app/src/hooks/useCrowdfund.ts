// Wave 4 task #257 — EncryptedCrowdfund hook.
// Mirrors useStorefront / useClaimLinks shape.

import { useCallback, useRef, useState } from "react";
import { parseUnits, toEventSelector } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForTx, Encryptable } from "@/lib/cofhe-shim";
import { runFundingGate, supportsFundingGate, FundingGateTimeout } from "@/lib/funding-gate";
import { EncryptedCrowdfundAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, getExplorerTxUrl } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export type CrowdfundStep = "idle" | "approving" | "encrypting" | "sending" | "funding" | "success" | "error";
/** Outcome of the funding check for the last contribution. Null on a contract that predates the funding gate. */
export type ContributionFunding = "funded" | "pending" | "unfunded";
export interface CrowdfundState {
  step: CrowdfundStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  lastCampaignId: number | null;
  /** Funding verdict for the last contribution. */
  funding: ContributionFunding | null;
  /** On-chain index of the last contribution, needed to finish a pending one. */
  lastContributionIndex: number | null;
}
const initial: CrowdfundState = {
  step: "idle",
  isProcessing: false,
  error: null,
  txHash: null,
  lastCampaignId: null,
  funding: null,
  lastContributionIndex: null,
};

export const CONTRIBUTION_UNFUNDED_MESSAGE =
  "Your contribution was not counted: your private balance was too low. Nothing was locked.";
export const REFUND_NOT_PAID_MESSAGE =
  "Nothing was paid out: no funds were locked for this contribution, so there was nothing to refund.";

const CONTRIBUTION_PENDING = 1;
/** Max contributions walked back when the Contributed event cannot be found in the receipt. */
const CONTRIBUTION_SCAN_LIMIT = 50;
const CONTRIBUTED_TOPIC = toEventSelector("Contributed(uint256,address,uint256,uint256)");

/** Reads the contribution index out of the Contributed event the tx emitted. */
export function parseContributionIndex(
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>,
  contract: string,
  campaignId: number,
): number | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== CONTRIBUTED_TOPIC.toLowerCase()) continue;
    if (!log.topics[1] || BigInt(log.topics[1]) !== BigInt(campaignId)) continue;
    // data = contributionIndex (32 bytes) ++ timestamp (32 bytes)
    if (log.data.length < 66) continue;
    return Number(BigInt(`0x${log.data.slice(2, 66)}`));
  }
  return null;
}

function reasonOf(err: unknown, what: string): string {
  if (err instanceof FundingGateTimeout) return `${what} is not ready yet`;
  return err instanceof Error ? err.message : String(err);
}

// §3.7 of BEST_VERSION_FULL_PLAN: friendly labels for callSimple toasts.
const FRIENDLY_LABEL: Record<string, string> = {
  closeCampaign: "Campaign closed",
  claimRelease: "Funds released",
  claimRefund: "Refund claimed",
};

function friendlyCrowdfundError(raw: string): string {
  if (raw.includes("already released")) return "The pool was already released to the creator.";
  if (raw.includes("vault not allowed")) return "This token vault is not enabled for crowdfunds on this chain.";
  if (raw.includes("refund pending")) return "A refund for this contribution is waiting for its confirmation. Press Finish refund.";
  if (raw.includes("no contributions to close against")) {
    return "There are no confirmed contributions to close against. A contribution still waiting for its funding check does not count until it is finished.";
  }
  return raw;
}

export function useCrowdfund() {
  const { effectiveAddress: address, notReadyReason } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const { decryptForTx } = useCofheDecryptForTx();
  const pipeline = useFhePipeline();
  const [state, setState] = useState<CrowdfundState>(initial);

  // Chains whose EncryptedCrowdfund has the funding gate. Only a positive probe
  // is kept: a failed probe may be a flaky RPC, so the next call asks again.
  const gateSupport = useRef(new Set<string>());
  const gateSupported = useCallback(
    async (cf: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${cf.toLowerCase()}`;
      if (gateSupport.current.has(key)) return true;
      if (!publicClient) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ok = await supportsFundingGate(() =>
          publicClient.readContract({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "getContributionFundingCheck",
            args: [0n, 0n],
          }),
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

  // Decrypts "funded" for a PendingFunding contribution and publishes it.
  // Anyone can run it, so a contribution another tab or user already settled
  // is a no-op.
  const runContributionGate = useCallback(
    async (cf: `0x${string}`, campaignId: number, index: number): Promise<boolean> => {
      const client = publicClient!;
      const { funded } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: cf,
              abi: EncryptedCrowdfundAbi,
              functionName: "getContributionFundingCheck",
              args: [BigInt(campaignId), BigInt(index)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            const st = await client.readContract({
              address: cf,
              abi: EncryptedCrowdfundAbi,
              functionName: "contributionState",
              args: [BigInt(campaignId), BigInt(index)],
            });
            if (Number(st) !== CONTRIBUTION_PENDING) return;
          } catch {
            // State unreadable: let the write decide.
          }
          const r = await unifiedWriteAndWait({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "confirmContribution",
            args: [BigInt(campaignId), BigInt(index), verdict, signature],
            gas: BigInt(2_000_000),
          });
          if (r.receipt?.status === "reverted") throw new Error("confirmContribution reverted on-chain");
        },
      });
      return funded;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // Decrypts "refund moved funds" for an in-flight refund and publishes it.
  // true: the contribution is marked refunded. false: nothing moved.
  const runRefundGate = useCallback(
    async (cf: `0x${string}`, campaignId: number, index: number): Promise<boolean> => {
      const client = publicClient!;
      const { funded: paid } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: cf,
              abi: EncryptedCrowdfundAbi,
              functionName: "getRefundCheck",
              args: [BigInt(campaignId), BigInt(index)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            const inFlight = await client.readContract({
              address: cf,
              abi: EncryptedCrowdfundAbi,
              functionName: "refundInFlight",
              args: [BigInt(campaignId), BigInt(index)],
            });
            if (inFlight === false) return;
          } catch {
            // State unreadable: let the write decide.
          }
          const r = await unifiedWriteAndWait({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "confirmRefund",
            args: [BigInt(campaignId), BigInt(index), verdict, signature],
            gas: BigInt(2_000_000),
          });
          if (r.receipt?.status === "reverted") throw new Error("confirmRefund reverted on-chain");
        },
      });
      return paid;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // Decrypts the goal-met verdict of a closed campaign and publishes it, which
  // lets the creator release or the contributors refund. Returns goalMet.
  const runCloseGate = useCallback(
    async (cf: `0x${string}`, campaignId: number): Promise<boolean> => {
      const client = publicClient!;
      const readCampaign = async () =>
        (await client.readContract({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCampaign",
          args: [BigInt(campaignId)],
        })) as readonly unknown[];
      const { funded: goalMet } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: cf,
              abi: EncryptedCrowdfundAbi,
              functionName: "getGoalCheckHandle",
              args: [BigInt(campaignId)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            if ((await readCampaign())[5] === true) return;
          } catch {
            // State unreadable: let the write decide.
          }
          const r = await unifiedWriteAndWait({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "publishCloseResult",
            args: [BigInt(campaignId), verdict, signature],
            gas: BigInt(2_000_000),
          });
          if (r.receipt?.status === "reverted") throw new Error("publishCloseResult reverted on-chain");
        },
      });
      return goalMet;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  const guardReady = useCallback((): { cf: `0x${string}` } | null => {
    if (!address || !connected) { toast.error(notReadyReason ?? "Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const cf = contracts.EncryptedCrowdfund as `0x${string}`;
    if (!cf || cf === ZERO_ADDRESS) { toast.error("Crowdfund not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { cf };
  }, [address, connected, contracts.EncryptedCrowdfund, publicClient, state.isProcessing, notReadyReason]);

  // §3.17 of BEST_VERSION_FULL_PLAN: plaintext-only guard for callSimple.
  // closeCampaign / claimRelease / claimRefund / publishCloseResult don't
  // need cofhe-connected.
  const guardWalletReady = useCallback((): { cf: `0x${string}` } | null => {
    if (!address) { toast.error(notReadyReason ?? "Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const cf = contracts.EncryptedCrowdfund as `0x${string}`;
    if (!cf || cf === ZERO_ADDRESS) { toast.error("Crowdfund not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { cf };
  }, [address, contracts.EncryptedCrowdfund, publicClient, state.isProcessing, notReadyReason]);

  const ensureVaultApproval = useCallback(async (vault: `0x${string}`) => {
    const cf = contracts.EncryptedCrowdfund as `0x${string}`;
    if (isVaultApproved(cf)) return;
    const toastId = toast.loading("Approving vault...");
    try {
      // §3.4 of BEST_VERSION_FULL_PLAN: AndWait for receipt before caching.
      await unifiedWriteAndWait({
        address: vault,
        abi: FHERC20VaultAbi,
        functionName: "approvePlaintext",
        args: [cf, MAX_UINT64],
        gas: BigInt(5_000_000),
      });
      markVaultApproved(cf);
      toast.success("Approval granted", { id: toastId });
    } catch (err) {
      toast.error("Approval failed", { id: toastId });
      throw err;
    }
  }, [contracts.EncryptedCrowdfund, unifiedWriteAndWait]);

  const createCampaign = useCallback(
    async (params: {
      vault: `0x${string}`;
      goalTokens: string;
      decimals: number;
      durationSeconds: number;
      title: string;
      descriptionCidHash: `0x${string}`;
    }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { cf } = ready;
      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const goalUnits = parseUnits(params.goalTokens, params.decimals);
        const [encGoal, encGoalProof] = await encryptInputsAsync(
          [Encryptable.uint64(goalUnits)],
          cf,
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const wr = await unifiedWriteAndWait({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "createCampaign",
          args: [
            params.vault,
            encGoal,
            encGoalProof,BigInt(params.durationSeconds),
            params.title,
            params.descriptionCidHash,
          ],
          gas: BigInt(5_000_000),
        });

        // §3.10: only flash confirming on the EOA path that actually waits.
        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (wr.receipt) logs = wr.receipt.logs as never;
        else {
          pipeline.markConfirming();
          const r = await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("createCampaign reverted");
          logs = r.logs as never;
        }
        const id = extractEventId(logs, cf);
        if (id === null) {
          throw new Error("Tx mined but campaignId could not be read; check History tab.");
        }
        pipeline.markDone();
        setState({ ...initial, step: "success", txHash: wr.hash, lastCampaignId: id });
        invalidateBalanceQueries();
        return id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return null;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait, publicClient],
  );

  // Fallback when the Contributed event is not in the receipt: the caller's
  // newest contribution that is still PendingFunding.
  const findPendingContribution = useCallback(
    async (cf: `0x${string}`, campaignId: number): Promise<number | null> => {
      if (!publicClient || !address) return null;
      try {
        const count = Number(
          await publicClient.readContract({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "getContributionCount",
            args: [BigInt(campaignId)],
          }),
        );
        for (let i = count - 1; i >= Math.max(0, count - CONTRIBUTION_SCAN_LIMIT); i--) {
          const [who] = (await publicClient.readContract({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "getContribution",
            args: [BigInt(campaignId), BigInt(i)],
          })) as readonly [`0x${string}`, boolean];
          if (who.toLowerCase() !== address.toLowerCase()) continue;
          const st = await publicClient.readContract({
            address: cf,
            abi: EncryptedCrowdfundAbi,
            functionName: "contributionState",
            args: [BigInt(campaignId), BigInt(i)],
          });
          if (Number(st) === CONTRIBUTION_PENDING) return i;
        }
      } catch {
        return null;
      }
      return null;
    },
    [publicClient, address],
  );

  const contribute = useCallback(
    async (params: {
      campaignId: number;
      vault: `0x${string}`;
      amountTokens: string;
      decimals: number;
    }) => {
      const ready = guardReady();
      if (!ready) return false;
      const { cf } = ready;
      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);
        const gated = await gateSupported(cf);

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount, encAmountProof] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          cf,
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const wr = await unifiedWriteAndWait({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "contribute",
          args: [BigInt(params.campaignId), encAmount, encAmountProof],
          gas: BigInt(5_000_000),
        });
        if (!gated) {
          // §3.10: unifiedWriteAndWait already settled the receipt; skip flash.
          pipeline.markDone();
          setState({ ...initial, step: "success", txHash: wr.hash, lastCampaignId: params.campaignId });
          invalidateBalanceQueries();
          return true;
        }

        // The contribution counts only once its funding check is published.
        // Find its index first: the check is keyed by (campaign, index).
        const receipt = wr.receipt ?? (await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 }));
        if (receipt.status === "reverted") throw new Error("contribute reverted on-chain");
        let index = parseContributionIndex(receipt.logs, cf, params.campaignId);
        if (index === null) index = await findPendingContribution(cf, params.campaignId);
        if (index === null) {
          throw new Error(
            "Your contribution is on-chain but its index could not be read. Reopen the campaign page and finish it from there.",
          );
        }
        setState((s) => ({ ...s, step: "funding", txHash: wr.hash, lastCampaignId: params.campaignId, lastContributionIndex: index }));

        let funding: ContributionFunding;
        let pendingNote: string | null = null;
        try {
          funding = (await runContributionGate(cf, params.campaignId, index)) ? "funded" : "unfunded";
        } catch (gateErr) {
          funding = "pending";
          pendingNote = `Contribution #${index} is on-chain but not confirmed yet (${reasonOf(gateErr, "The funding check")}). It is not counted until it is. Press Finish to retry.`;
        }
        invalidateBalanceQueries();
        if (funding === "unfunded") {
          pipeline.markFailed(new Error(CONTRIBUTION_UNFUNDED_MESSAGE));
          setState({
            ...initial,
            step: "error",
            error: CONTRIBUTION_UNFUNDED_MESSAGE,
            txHash: wr.hash,
            lastCampaignId: params.campaignId,
            lastContributionIndex: index,
            funding,
          });
          toast.error(CONTRIBUTION_UNFUNDED_MESSAGE);
          return false;
        }
        pipeline.markDone();
        setState({
          ...initial,
          step: "success",
          txHash: wr.hash,
          lastCampaignId: params.campaignId,
          lastContributionIndex: index,
          funding,
        });
        if (pendingNote) toast.error(pendingNote);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, gateSupported, runContributionGate, findPendingContribution, encryptInputsAsync, unifiedWriteAndWait, publicClient],
  );

  const callSimple = useCallback(
    async (
      functionName: "closeCampaign" | "claimRelease" | "claimRefund",
      args: readonly unknown[],
      gasLimit = 5_000_000,
      opts: { silent?: boolean } = {},
    ) => {
      // §3.17: plaintext-only guard.
      const ready = guardWalletReady();
      if (!ready) return false;
      const { cf } = ready;
      try {
        // §3.13: preserve lastCampaignId across callSimple invocations.
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        await unifiedWriteAndWait({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName,
          args: args as never,
          gas: BigInt(gasLimit),
        });
        // "idle", not "success": the success step drives the
        // contribution-submitted screen, which is wrong for close/release/refund.
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
        invalidateBalanceQueries();
        // §3.7: friendly label instead of raw function name.
        if (!opts.silent) toast.success(FRIENDLY_LABEL[functionName] ?? "Submitted");
        return true;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = friendlyCrowdfundError(raw);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardWalletReady, unifiedWriteAndWait],
  );

  const claimRelease = useCallback((id: number) => callSimple("claimRelease", [BigInt(id)]), [callSimple]);

  // ─── Goal verdict (second step of closing) ──────────────────────────
  // closeCampaign only computes the encrypted verdict. Publishing it is what
  // lets the creator release or the contributors refund, and anyone can do it.

  const finishClosingUnguarded = useCallback(
    async (cf: `0x${string}`, id: number): Promise<"met" | "missed" | null> => {
      setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Publishing the goal verdict...");
      try {
        const campaign = (await publicClient!.readContract({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCampaign",
          args: [BigInt(id)],
        })) as readonly unknown[];
        if (Number(campaign[3]) === 0) throw new Error("This campaign has not been closed yet.");
        const goalMet = await runCloseGate(cf, id);
        invalidateBalanceQueries();
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
        toast.success(
          goalMet ? "Goal met. The creator can now release the pool." : "Goal not met. Contributors can now claim refunds.",
          { id: toastId },
        );
        return goalMet ? "met" : "missed";
      } catch (err) {
        const msg = `The goal verdict was not published (${reasonOf(err, "The goal verdict")}). Press Finish closing to retry.`;
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [publicClient, runCloseGate],
  );

  /**
   * Publish the goal verdict of a closed campaign. Anyone can run it. Returns
   * the verdict, or null when it could not be completed; the campaign then
   * stays Closed and can be retried.
   */
  const finishClosing = useCallback(
    async (id: number): Promise<"met" | "missed" | null> => {
      const ready = guardWalletReady();
      if (!ready) return null;
      return finishClosingUnguarded(ready.cf, id);
    },
    [guardWalletReady, finishClosingUnguarded],
  );

  // Closing publishes the verdict right away when the closer is the creator,
  // so one click takes the campaign to its release or refund phase.
  const closeCampaign = useCallback(
    async (id: number) => {
      const ok = await callSimple("closeCampaign", [BigInt(id)]);
      if (!ok) return false;
      const cf = contracts.EncryptedCrowdfund as `0x${string}`;
      try {
        const campaign = (await publicClient!.readContract({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCampaign",
          args: [BigInt(id)],
        })) as readonly unknown[];
        if (address && String(campaign[0]).toLowerCase() === address.toLowerCase()) {
          await finishClosingUnguarded(cf, id);
        }
      } catch {
        // Creator unknown: the campaign page offers Finish closing to anyone.
      }
      return true;
    },
    [callSimple, contracts.EncryptedCrowdfund, publicClient, address, finishClosingUnguarded],
  );

  // ─── Refund (two steps) ─────────────────────────────────────────────

  const finishRefundUnguarded = useCallback(
    async (cf: `0x${string}`, id: number, contributionIndex: number): Promise<"paid" | "not_paid" | null> => {
      setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Confirming refund...");
      try {
        const paid = await runRefundGate(cf, id, contributionIndex);
        invalidateBalanceQueries();
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
        if (paid) toast.success("Refund claimed", { id: toastId });
        else toast.error(REFUND_NOT_PAID_MESSAGE, { id: toastId });
        return paid ? "paid" : "not_paid";
      } catch (err) {
        const msg = `Refund requested but not confirmed (${reasonOf(err, "The refund check")}). Press Finish refund to retry.`;
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [runRefundGate],
  );

  /** Confirm a refund whose first step ran but whose check was not published. */
  const finishRefund = useCallback(
    async (id: number, contributionIndex: number) => {
      const ready = guardWalletReady();
      if (!ready) return null;
      return finishRefundUnguarded(ready.cf, id, contributionIndex);
    },
    [guardWalletReady, finishRefundUnguarded],
  );

  // Step 1 moves the funds; step 2 publishes whether anything moved. Returns
  // true only when the refund is confirmed as paid.
  const claimRefund = useCallback(
    async (id: number, contributionIndex: number) => {
      const cf = contracts.EncryptedCrowdfund as `0x${string}`;
      const gated = !!cf && cf !== ZERO_ADDRESS && (await gateSupported(cf));
      const ok = await callSimple("claimRefund", [BigInt(id), BigInt(contributionIndex)], 5_000_000, { silent: gated });
      if (!ok || !gated) return ok;
      return (await finishRefundUnguarded(cf, id, contributionIndex)) === "paid";
    },
    [contracts.EncryptedCrowdfund, gateSupported, callSimple, finishRefundUnguarded],
  );

  // ─── Contribution funding (second step of contributing) ─────────────

  /**
   * Finish a contribution left PendingFunding (the funding check timed out, or
   * the tab closed). Anyone can run it. Returns the verdict, or null when it
   * could not be completed; the contribution then stays pending.
   */
  const finishContribution = useCallback(
    async (campaignId: number, contributionIndex: number): Promise<"funded" | "unfunded" | null> => {
      const ready = guardWalletReady();
      if (!ready) return null;
      const { cf } = ready;
      if (!(await gateSupported(cf))) {
        toast.error("This crowdfund contract has no funding check to finish.");
        return null;
      }
      const isCurrent = state.lastCampaignId === campaignId && state.lastContributionIndex === contributionIndex;
      setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Confirming contribution...");
      try {
        const funded = await runContributionGate(cf, campaignId, contributionIndex);
        invalidateBalanceQueries();
        setState((prev) =>
          funded
            ? { ...prev, step: "success", isProcessing: false, funding: isCurrent ? "funded" : prev.funding }
            : {
                ...prev,
                step: "error",
                isProcessing: false,
                error: CONTRIBUTION_UNFUNDED_MESSAGE,
                funding: isCurrent ? "unfunded" : prev.funding,
              },
        );
        if (funded) toast.success("Contribution counted", { id: toastId });
        else toast.error(CONTRIBUTION_UNFUNDED_MESSAGE, { id: toastId });
        return funded ? "funded" : "unfunded";
      } catch (err) {
        const msg = `Contribution #${contributionIndex} is not confirmed yet (${reasonOf(err, "The funding check")}). Press Finish to retry.`;
        setState((prev) => ({ ...prev, isProcessing: false, step: isCurrent ? "success" : "error", error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [guardWalletReady, gateSupported, runContributionGate, state.lastCampaignId, state.lastContributionIndex],
  );

  // §3.2 of BEST_VERSION_FULL_PLAN: publishCloseResult wrapper. Low-level: the
  // caller supplies the plaintext + threshold signature. Screens use
  // finishClosing, which fetches both.
  const publishCloseResult = useCallback(
    async (campaignId: number, plaintext: boolean, signature: `0x${string}`) => {
      // §3.17: plaintext-only (signature already obtained off-chain).
      const ready = guardWalletReady();
      if (!ready) return false;
      const { cf } = ready;
      try {
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        await unifiedWriteAndWait({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "publishCloseResult",
          args: [BigInt(campaignId), plaintext, signature],
        });
        // "idle", not "success": the success step drives the contribution-submitted screen.
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
        invalidateBalanceQueries();
        toast.success(plaintext ? "Goal verdict: success published" : "Goal verdict: not met published");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardWalletReady, unifiedWriteAndWait],
  );

  const reset = useCallback(() => { setState(initial); pipeline.reset(); }, [pipeline]);

  // §1.15 B4b — creator-side reads. Closes the audit B4 gap (no UI
  // listed the creator's own campaigns + no way to navigate to them).
  const fetchCreatorCampaigns = useCallback(
    async (creator: `0x${string}`): Promise<bigint[]> => {
      const cf = contracts.EncryptedCrowdfund as `0x${string}`;
      if (!publicClient || !cf || cf === "0x0000000000000000000000000000000000000000") {
        return [];
      }
      try {
        const ids = (await publicClient.readContract({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCreatorCampaigns",
          args: [creator],
        })) as readonly bigint[];
        return [...ids];
      } catch {
        return [];
      }
    },
    [publicClient, contracts.EncryptedCrowdfund],
  );

  const fetchCampaign = useCallback(
    async (campaignId: bigint) => {
      const cf = contracts.EncryptedCrowdfund as `0x${string}`;
      if (!publicClient || !cf) return null;
      try {
        const result = (await publicClient.readContract({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "getCampaign",
          args: [campaignId],
        })) as readonly [
          `0x${string}`, `0x${string}`, bigint, number, boolean, boolean,
          string, `0x${string}`, bigint,
        ];
        const [
          creator, vault, deadline, status, goalMet, resultPublished,
          title, descriptionCidHash, createdAt,
        ] = result;
        if (creator === "0x0000000000000000000000000000000000000000") return null;
        return {
          id: campaignId,
          creator,
          vault,
          deadline,
          status,
          goalMet,
          resultPublished,
          title,
          descriptionCidHash,
          createdAt,
        };
      } catch {
        return null;
      }
    },
    [publicClient, contracts.EncryptedCrowdfund],
  );

  // §3.12 of BEST_VERSION_FULL_PLAN: derived txExplorerUrl.
  const txExplorerUrl = state.txHash ? getExplorerTxUrl(state.txHash, activeChainId) : null;

  return {
    state,
    txExplorerUrl,
    pipeline: pipeline.state,
    createCampaign,
    contribute,
    closeCampaign,
    publishCloseResult,
    finishClosing,
    claimRelease,
    claimRefund,
    finishRefund,
    finishContribution,
    fetchCreatorCampaigns,
    fetchCampaign,
    reset,
  };
}
