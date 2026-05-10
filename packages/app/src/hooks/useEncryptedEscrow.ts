// Wave 4 #249 — fully-encrypted escrow hook.
// Mirrors useStorefront / useCrowdfund shape. Replaces the plaintext-storage
// path in BusinessHub.escrow for new escrows. Existing BusinessHub escrows
// continue to work via useBusinessHub for back-compat.

import { useCallback, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, Encryptable } from "@/lib/cofhe-shim";
import { EncryptedEscrowAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export const ESCROW_STATUS = {
  Active: 0,
  Disputed: 1,
  Released: 2,
  Refunded: 3,
} as const;
export type EscrowStatus = typeof ESCROW_STATUS[keyof typeof ESCROW_STATUS];

export type EscrowStep = "idle" | "approving" | "encrypting" | "sending" | "success" | "error";
export interface EscrowState {
  step: EscrowStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  lastEscrowId: number | null;
}
const initial: EscrowState = { step: "idle", isProcessing: false, error: null, txHash: null, lastEscrowId: null };

// §3.7 of BEST_VERSION_FULL_PLAN: friendly labels for callSimple toasts.
const FRIENDLY_LABEL: Record<string, string> = {
  markDelivered: "Delivery marked",
  approveRelease: "Release approved",
  disputeEscrow: "Dispute opened",
  claimExpiredEscrow: "Escrow refunded after deadline",
  arbiterDecide: "Arbiter decision recorded",
};

export function useEncryptedEscrow() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();
  const [state, setState] = useState<EscrowState>(initial);

  const guardReady = useCallback((): { ee: `0x${string}` } | null => {
    if (!address || !connected) { toast.error("Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const ee = contracts.EncryptedEscrow as `0x${string}`;
    if (!ee || ee === ZERO_ADDRESS) { toast.error("EncryptedEscrow not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { ee };
  }, [address, connected, contracts.EncryptedEscrow, publicClient, state.isProcessing]);

  const ensureVaultApproval = useCallback(async (vault: `0x${string}`) => {
    const ee = contracts.EncryptedEscrow as `0x${string}`;
    if (isVaultApproved(ee)) return;
    const toastId = toast.loading("Approving vault...");
    try {
      await unifiedWrite({
        address: vault,
        abi: FHERC20VaultAbi,
        functionName: "approvePlaintext",
        args: [ee, MAX_UINT64],
        gas: BigInt(5_000_000),
      });
      markVaultApproved(ee);
      toast.success("Approval granted", { id: toastId });
    } catch (err) {
      toast.error("Approval failed", { id: toastId });
      throw err;
    }
  }, [contracts.EncryptedEscrow, unifiedWrite]);

  const createEscrow = useCallback(
    async (params: {
      beneficiary: `0x${string}`;
      vault: `0x${string}`;
      amountTokens: string;
      decimals: number;
      description: string;
      arbiter: `0x${string}`;     // ZERO_ADDRESS for no arbiter
      deadlineSeconds: number;     // unix-seconds absolute deadline (>= now + 1 day)
    }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { ee } = ready;
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
          address: ee,
          abi: EncryptedEscrowAbi,
          functionName: "createEscrow",
          args: [
            params.beneficiary,
            params.vault,
            encAmount as unknown as EncryptedInput,
            params.description,
            params.arbiter,
            BigInt(params.deadlineSeconds),
          ],
          gas: BigInt(5_000_000),
        });

        // §3.10: only flash confirming on the EOA path that actually waits.
        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (wr.receipt) logs = wr.receipt.logs as never;
        else {
          pipeline.markConfirming();
          const r = await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("createEscrow reverted");
          logs = r.logs as never;
        }
        const id = extractEventId(logs, ee);
        if (id === null) {
          throw new Error("Tx mined but escrowId could not be read; check History tab.");
        }
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: wr.hash, lastEscrowId: id });
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

  const callSimple = useCallback(
    async (
      functionName:
        | "markDelivered"
        | "approveRelease"
        | "disputeEscrow"
        | "claimExpiredEscrow"
        | "arbiterDecide",
      args: readonly unknown[],
      gasLimit = 5_000_000,
    ) => {
      const ready = guardReady();
      if (!ready) return false;
      const { ee } = ready;
      try {
        // §3.13: preserve lastEscrowId across callSimple invocations.
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        await unifiedWriteAndWait({
          address: ee,
          abi: EncryptedEscrowAbi,
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
    [guardReady, unifiedWriteAndWait],
  );

  const markDelivered = useCallback((id: number) => callSimple("markDelivered", [BigInt(id)]), [callSimple]);
  const approveRelease = useCallback((id: number) => callSimple("approveRelease", [BigInt(id)]), [callSimple]);
  const disputeEscrow = useCallback((id: number) => callSimple("disputeEscrow", [BigInt(id)]), [callSimple]);
  const claimExpiredEscrow = useCallback((id: number) => callSimple("claimExpiredEscrow", [BigInt(id)]), [callSimple]);
  const arbiterDecide = useCallback(
    (id: number, releaseToBeneficiary: boolean) => callSimple("arbiterDecide", [BigInt(id), releaseToBeneficiary]),
    [callSimple],
  );

  const reset = useCallback(() => { setState(initial); pipeline.reset(); }, [pipeline]);

  return {
    state,
    pipeline: pipeline.state,
    createEscrow,
    markDelivered,
    approveRelease,
    disputeEscrow,
    claimExpiredEscrow,
    arbiterDecide,
    reset,
  };
}
