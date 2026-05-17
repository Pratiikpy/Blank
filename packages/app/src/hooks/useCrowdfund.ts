// Wave 4 task #257 — EncryptedCrowdfund hook.
// Mirrors useStorefront / useClaimLinks shape.

import { useCallback, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, Encryptable } from "@/lib/cofhe-shim";
import { EncryptedCrowdfundAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, type EncryptedInput, getExplorerTxUrl } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export type CrowdfundStep = "idle" | "approving" | "encrypting" | "sending" | "success" | "error";
export interface CrowdfundState {
  step: CrowdfundStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  lastCampaignId: number | null;
}
const initial: CrowdfundState = { step: "idle", isProcessing: false, error: null, txHash: null, lastCampaignId: null };

// §3.7 of BEST_VERSION_FULL_PLAN: friendly labels for callSimple toasts.
const FRIENDLY_LABEL: Record<string, string> = {
  closeCampaign: "Campaign closed",
  claimRelease: "Funds released",
  claimRefund: "Refund claimed",
};

export function useCrowdfund() {
  const { effectiveAddress: address, notReadyReason } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();
  const [state, setState] = useState<CrowdfundState>(initial);

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
        const [encGoal] = await encryptInputsAsync(
          [Encryptable.uint64(goalUnits)],
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
            encGoal as unknown as EncryptedInput,
            BigInt(params.durationSeconds),
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
        setState({ step: "success", isProcessing: false, error: null, txHash: wr.hash, lastCampaignId: id });
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

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const wr = await unifiedWriteAndWait({
          address: cf,
          abi: EncryptedCrowdfundAbi,
          functionName: "contribute",
          args: [BigInt(params.campaignId), encAmount as unknown as EncryptedInput],
          gas: BigInt(5_000_000),
        });
        // §3.10: unifiedWriteAndWait already settled the receipt; skip flash.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: wr.hash, lastCampaignId: params.campaignId });
        invalidateBalanceQueries();
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
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait],
  );

  const callSimple = useCallback(
    async (functionName: "closeCampaign" | "claimRelease" | "claimRefund", args: readonly unknown[], gasLimit = 5_000_000) => {
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
        setState((prev) => ({ ...prev, step: "success", isProcessing: false }));
        invalidateBalanceQueries();
        // §3.7: friendly label instead of raw function name.
        toast.success(FRIENDLY_LABEL[functionName] ?? "Submitted");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardWalletReady, unifiedWriteAndWait],
  );

  const closeCampaign = useCallback((id: number) => callSimple("closeCampaign", [BigInt(id)]), [callSimple]);
  const claimRelease = useCallback((id: number) => callSimple("claimRelease", [BigInt(id)]), [callSimple]);
  const claimRefund = useCallback(
    (id: number, contributionIndex: number) => callSimple("claimRefund", [BigInt(id), BigInt(contributionIndex)]),
    [callSimple],
  );

  // §3.2 of BEST_VERSION_FULL_PLAN: publishCloseResult wrapper. Half-baked B2.
  // After closeCampaign, the encrypted goal-met verdict needs publishing via
  // FHE.publishDecryptResult. Caller is responsible for fetching the
  // plaintext + threshold signature (via cofhe client.decryptForTx) before
  // invoking this hook. Auto-call after closeCampaign deferred to Wave 5
  // (needs cofhe-decrypt-queue subscription).
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
        setState((prev) => ({ ...prev, step: "success", isProcessing: false }));
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
    claimRelease,
    claimRefund,
    fetchCreatorCampaigns,
    fetchCampaign,
    reset,
  };
}
