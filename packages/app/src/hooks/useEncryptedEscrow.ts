// Wave 4 #249 — fully-encrypted escrow hook.
// Mirrors useStorefront / useCrowdfund shape. Replaces the plaintext-storage
// path in BusinessHub.escrow for new escrows. Existing BusinessHub escrows
// continue to work via useBusinessHub for back-compat.

import { useCallback, useRef, useState } from "react";
import { parseUnits, encodeAbiParameters } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForTx, Encryptable } from "@/lib/cofhe-shim";
import { runFundingGate, supportsFundingGate, FundingGateTimeout } from "@/lib/funding-gate";
import type { PublicClient } from "viem";
import {
  EncryptedEscrowAbi,
  FHERC20VaultAbi,
  InvoiceApprovalResolverAbi,
  InvoiceApprovalResolverLegacyAbi,
} from "@/lib/abis";
import { MAX_UINT64, getExplorerTxUrl } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { escrowArbiterError } from "@/lib/escrow-rules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export const ESCROW_STATUS = {
  Active: 0,
  Disputed: 1,
  Released: 2,
  Refunded: 3,
  PendingFunding: 4,
  Void: 5,
} as const;
export type EscrowStatus = typeof ESCROW_STATUS[keyof typeof ESCROW_STATUS];

export interface ConditionalInvoiceCondition {
  buyer: `0x${string}`;
  autoReleaseDeadline: bigint;
  isApproved: boolean;
  deadlinePassed: boolean;
  set: boolean;
  /** The resolver this escrow was created with. Approvals go there. */
  resolver: `0x${string}`;
  /** True when that resolver is the pre-upgrade one (approve(uint256)). */
  legacy: boolean;
}

/**
 * Read a conditional invoice's release rule from the resolver it was created
 * with. EncryptedEscrow keeps each escrow's resolver private but emits
 * EscrowResolverSet, so the log names it. Escrows on the current resolver
 * use the (escrow, id) keyed reads; escrows on an older resolver use its
 * id-keyed reads. If the log lookup fails, the current resolver is assumed.
 */
export async function readConditionalInvoice(
  client: Pick<PublicClient, "readContract" | "getLogs">,
  params: { escrow: `0x${string}`; currentResolver: `0x${string}`; escrowId: number },
): Promise<ConditionalInvoiceCondition | null> {
  const { escrow, currentResolver, escrowId } = params;
  let resolver = currentResolver;
  try {
    const logs = await client.getLogs({
      address: escrow,
      event: {
        type: "event",
        name: "EscrowResolverSet",
        inputs: [
          { name: "escrowId", type: "uint256", indexed: true },
          { name: "resolver", type: "address", indexed: true },
        ],
      },
      args: { escrowId: BigInt(escrowId) },
      fromBlock: "earliest",
      toBlock: "latest",
    });
    const found = logs[logs.length - 1]?.args?.resolver as `0x${string}` | undefined;
    if (found) resolver = found;
  } catch {
    resolver = currentResolver;
  }
  if (!resolver || resolver === ZERO_ADDRESS) return null;
  const legacy = resolver.toLowerCase() !== (currentResolver ?? "").toLowerCase();
  const c = legacy
    ? ((await client.readContract({
        address: resolver,
        abi: InvoiceApprovalResolverLegacyAbi,
        functionName: "getCondition",
        args: [BigInt(escrowId)],
      })) as readonly [`0x${string}`, bigint, boolean, boolean, boolean])
    : ((await client.readContract({
        address: resolver,
        abi: InvoiceApprovalResolverAbi,
        functionName: "getCondition",
        args: [escrow, BigInt(escrowId)],
      })) as readonly [`0x${string}`, bigint, boolean, boolean, boolean]);
  return {
    buyer: c[0],
    autoReleaseDeadline: c[1],
    isApproved: c[2],
    deadlinePassed: c[3],
    set: c[4],
    resolver,
    legacy,
  };
}

export type EscrowStep = "idle" | "approving" | "encrypting" | "sending" | "funding" | "success" | "error";
/** Outcome of the funding check for the last escrow. Null on a contract that predates the funding gate. */
export type EscrowFunding = "funded" | "pending" | "unfunded";
export interface EscrowState {
  step: EscrowStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  lastEscrowId: number | null;
  funding: EscrowFunding | null;
}
const initial: EscrowState = { step: "idle", isProcessing: false, error: null, txHash: null, lastEscrowId: null, funding: null };

export const ESCROW_UNFUNDED_MESSAGE =
  "The escrow was not funded: your private balance was too low. Nothing was locked.";

function pendingFundingMessage(id: number, err: unknown): string {
  const reason = err instanceof FundingGateTimeout ? "the funding check is not ready yet" : err instanceof Error ? err.message : String(err);
  return `Escrow #${id} was created but its funding is not confirmed (${reason}). Nothing is lost: open the escrow and press Finish funding.`;
}

// §3.7 of BEST_VERSION_FULL_PLAN: friendly labels for callSimple toasts.
const FRIENDLY_LABEL: Record<string, string> = {
  markDelivered: "Delivery marked",
  approveRelease: "Release approved",
  disputeEscrow: "Dispute opened",
  claimExpiredEscrow: "Escrow refunded after deadline",
  cancelPendingEscrow: "Escrow cancelled",
  arbiterDecide: "Arbiter decision recorded",
  claimDisputeTimeout: "Dispute timed out. Funds returned to you",
  releaseIfConditionMet: "Funds released",
};

export function useEncryptedEscrow() {
  const { effectiveAddress: address, notReadyReason } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();
  const { decryptForTx } = useCofheDecryptForTx();
  const [state, setState] = useState<EscrowState>(initial);
  // Chains whose EncryptedEscrow has the funding gate. Only a positive probe is
  // kept: a failed probe may be a flaky RPC, so the next call asks again.
  const gateSupport = useRef(new Set<string>());

  const gateSupported = useCallback(
    async (ee: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${ee.toLowerCase()}`;
      if (gateSupport.current.has(key)) return true;
      if (!publicClient) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ok = await supportsFundingGate(() =>
          publicClient.readContract({ address: ee, abi: EncryptedEscrowAbi, functionName: "getFundingCheck", args: [0n] }),
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

  // Decrypts "funded" for a PendingFunding escrow and publishes it. Anyone can
  // run this, so it is safe to call again for an escrow another tab or user
  // already settled: the pending check below turns that into a no-op.
  const runGate = useCallback(
    async (ee: `0x${string}`, id: number): Promise<boolean> => {
      const client = publicClient!;
      const { funded } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: ee,
              abi: EncryptedEscrowAbi,
              functionName: "getFundingCheck",
              args: [BigInt(id)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            const e = (await client.readContract({
              address: ee,
              abi: EncryptedEscrowAbi,
              functionName: "getEscrow",
              args: [BigInt(id)],
            })) as readonly unknown[];
            if (Number(e[7]) !== ESCROW_STATUS.PendingFunding) return;
          } catch {
            // Status unreadable: let the write decide.
          }
          const r = await unifiedWriteAndWait({
            address: ee,
            abi: EncryptedEscrowAbi,
            functionName: "confirmFunding",
            args: [BigInt(id), verdict, signature],
            gas: BigInt(5_000_000),
          });
          if (r.receipt?.status === "reverted") throw new Error("confirmFunding reverted on-chain");
        },
      });
      return funded;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // §3.17 of BEST_VERSION_FULL_PLAN: split guards. The original guardReady
  // required cofhe-connected which blocked plaintext-only ops (arbiterDecide,
  // markDelivered, approveRelease, claimExpiredEscrow, disputeEscrow) when
  // the cofhe shim hadn't connected yet. Half-baked B7. The encrypt-required
  // path (createEscrow) keeps the strict guard; plaintext-only paths use the
  // wallet-only guard.
  const guardReady = useCallback((): { ee: `0x${string}` } | null => {
    if (!address || !connected) { toast.error(notReadyReason ?? "Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const ee = contracts.EncryptedEscrow as `0x${string}`;
    if (!ee || ee === ZERO_ADDRESS) { toast.error("EncryptedEscrow not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { ee };
  }, [address, connected, contracts.EncryptedEscrow, publicClient, state.isProcessing, notReadyReason]);

  const guardWalletReady = useCallback((): { ee: `0x${string}` } | null => {
    if (!address) { toast.error(notReadyReason ?? "Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const ee = contracts.EncryptedEscrow as `0x${string}`;
    if (!ee || ee === ZERO_ADDRESS) { toast.error("EncryptedEscrow not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { ee };
  }, [address, contracts.EncryptedEscrow, publicClient, state.isProcessing, notReadyReason]);

  const ensureVaultApproval = useCallback(async (vault: `0x${string}`) => {
    const ee = contracts.EncryptedEscrow as `0x${string}`;
    if (isVaultApproved(ee)) return;
    const toastId = toast.loading("Approving vault...");
    try {
      // §3.4 of BEST_VERSION_FULL_PLAN: AndWait so receipt mines before
      // markVaultApproved caches. Pre-fix race could leave allowance still
      // pending while the main tx fired, reverting on insufficient allowance.
      await unifiedWriteAndWait({
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
  }, [contracts.EncryptedEscrow, unifiedWriteAndWait]);

  // Runs the funding gate for a freshly created escrow and publishes the
  // outcome. Returns the id unless the escrow is known to be unfunded. A gate
  // that cannot finish leaves the escrow PendingFunding on-chain, which anyone
  // can settle later, so that case still returns the id.
  const settleCreated = useCallback(
    async (ee: `0x${string}`, id: number, hash: `0x${string}`, gated: boolean): Promise<number | null> => {
      if (!gated) {
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: hash, lastEscrowId: id, funding: null });
        invalidateBalanceQueries();
        return id;
      }
      setState((s) => ({ ...s, step: "funding" }));
      let funding: EscrowFunding;
      let pendingNote: string | null = null;
      try {
        funding = (await runGate(ee, id)) ? "funded" : "unfunded";
      } catch (err) {
        funding = "pending";
        pendingNote = pendingFundingMessage(id, err);
      }
      invalidateBalanceQueries();
      if (funding === "unfunded") {
        pipeline.markFailed(new Error(ESCROW_UNFUNDED_MESSAGE));
        setState({ step: "error", isProcessing: false, error: ESCROW_UNFUNDED_MESSAGE, txHash: hash, lastEscrowId: id, funding });
        toast.error(ESCROW_UNFUNDED_MESSAGE);
        return null;
      }
      pipeline.markDone();
      setState({ step: "success", isProcessing: false, error: null, txHash: hash, lastEscrowId: id, funding });
      if (pendingNote) toast.error(pendingNote);
      return id;
    },
    [pipeline, runGate],
  );

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

      // §3.15 of BEST_VERSION_FULL_PLAN: fail-fast pre-encryption validation.
      // Mirrors the contract's require statements so users don't lose 30s
      // of FHE work on a guaranteed-revert input.
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (params.beneficiary === ZERO || params.beneficiary.toLowerCase() === address?.toLowerCase()) {
        toast.error("Beneficiary must be a different address from yours.");
        return null;
      }
      if (params.vault === ZERO) {
        toast.error("Vault address required.");
        return null;
      }
      const arbiterErr = escrowArbiterError(params.arbiter, address ?? "", params.beneficiary);
      if (arbiterErr) {
        toast.error(arbiterErr);
        return null;
      }
      const minDeadline = Math.floor(Date.now() / 1000) + 86400;
      if (params.deadlineSeconds < minDeadline) {
        toast.error("Escrow deadline must be at least 1 day from now.");
        return null;
      }
      if (params.description.length > 512) {
        toast.error("Description must be 512 characters or fewer.");
        return null;
      }

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);
        const gated = await gateSupported(ee);

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount, encAmountProof] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          ee,
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
            encAmount,
            encAmountProof,params.description,
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
        return await settleCreated(ee, id, wr.hash, gated);
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
    [guardReady, pipeline, ensureVaultApproval, gateSupported, settleCreated, encryptInputsAsync, unifiedWriteAndWait, publicClient],
  );

  // Conditional invoice: the depositor (payer) escrows an encrypted amount to
  // the beneficiary (vendor) under the InvoiceApprovalResolver. Releases when
  // the payer approves, or after the auto-release deadline. Arb Sepolia only.
  const createConditionalInvoice = useCallback(
    async (params: {
      beneficiary: `0x${string}`;
      vault: `0x${string}`;
      amountTokens: string;
      decimals: number;
      description: string;
      deadlineSeconds: number;
    }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { ee } = ready;

      const resolver = contracts.InvoiceApprovalResolver as `0x${string}`;
      if (!resolver || resolver === ZERO_ADDRESS) {
        toast.error("Conditional invoices are only available on Arbitrum Sepolia.");
        return null;
      }
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (params.beneficiary === ZERO || params.beneficiary.toLowerCase() === address?.toLowerCase()) {
        toast.error("Recipient must be a different address from yours.");
        return null;
      }
      if (params.vault === ZERO) { toast.error("Vault address required."); return null; }
      const minDeadline = Math.floor(Date.now() / 1000) + 86400;
      if (params.deadlineSeconds < minDeadline) {
        toast.error("Auto-release deadline must be at least 1 day from now.");
        return null;
      }
      if (params.description.length > 512) {
        toast.error("Description must be 512 characters or fewer.");
        return null;
      }

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);
        const gated = await gateSupported(ee);

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount, encAmountProof] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          ee,
          pipeline.onEncryptStep,
        );

        // The approver is the depositor (the connected wallet).
        const resolverData = encodeAbiParameters(
          [{ type: "address" }, { type: "uint64" }],
          [address as `0x${string}`, BigInt(params.deadlineSeconds)],
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const wr = await unifiedWriteAndWait({
          address: ee,
          abi: EncryptedEscrowAbi,
          functionName: "createConditionalEscrow",
          args: [
            params.beneficiary,
            params.vault,
            encAmount,
            encAmountProof,params.description,
            resolver,
            resolverData,
            BigInt(params.deadlineSeconds),
          ],
          gas: BigInt(6_000_000),
        });

        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (wr.receipt) logs = wr.receipt.logs as never;
        else {
          pipeline.markConfirming();
          const r = await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("createConditionalEscrow reverted");
          logs = r.logs as never;
        }
        const id = extractEventId(logs, ee);
        if (id === null) throw new Error("Tx mined but invoice id could not be read; check History tab.");
        return await settleCreated(ee, id, wr.hash, gated);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return null;
      }
    },
    [guardReady, contracts.InvoiceApprovalResolver, address, pipeline, ensureVaultApproval, gateSupported, settleCreated, encryptInputsAsync, unifiedWriteAndWait, publicClient],
  );

  const callSimple = useCallback(
    async (
      functionName:
        | "markDelivered"
        | "approveRelease"
        | "disputeEscrow"
        | "claimExpiredEscrow"
        | "claimDisputeTimeout"
        | "arbiterDecide"
        | "cancelPendingEscrow"
        | "releaseIfConditionMet",
      args: readonly unknown[],
      gasLimit = 5_000_000,
    ) => {
      // §3.17: callSimple is plaintext-only. Use the wallet-only guard so
      // arbiter decide / mark / approve / claim work without cofhe connect.
      const ready = guardWalletReady();
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
    [guardWalletReady, unifiedWriteAndWait],
  );

  const markDelivered = useCallback((id: number) => callSimple("markDelivered", [BigInt(id)]), [callSimple]);
  const approveRelease = useCallback((id: number) => callSimple("approveRelease", [BigInt(id)]), [callSimple]);
  const disputeEscrow = useCallback((id: number) => callSimple("disputeEscrow", [BigInt(id)]), [callSimple]);
  const claimExpiredEscrow = useCallback((id: number) => callSimple("claimExpiredEscrow", [BigInt(id)]), [callSimple]);
  const arbiterDecide = useCallback(
    (id: number, releaseToBeneficiary: boolean) => callSimple("arbiterDecide", [BigInt(id), releaseToBeneficiary]),
    [callSimple],
  );
  // Depositor exit when the arbiter never rules: DISPUTE_TIMEOUT (30 days)
  // after the dispute opened, funds go back and the status is Refunded.
  const claimDisputeTimeout = useCallback((id: number) => callSimple("claimDisputeTimeout", [BigInt(id)]), [callSimple]);
  /** Depositor abandons an escrow still waiting for its funding check. */
  const cancelPendingEscrow = useCallback((id: number) => callSimple("cancelPendingEscrow", [BigInt(id)]), [callSimple]);

  /**
   * Finish an escrow left PendingFunding (the funding check timed out, or the
   * tab closed). Anyone can run it. Returns the verdict, or null when it could
   * not be completed; the escrow then stays pending and can be retried.
   */
  const finishFunding = useCallback(
    async (id: number): Promise<"funded" | "unfunded" | null> => {
      const ready = guardWalletReady();
      if (!ready) return null;
      const { ee } = ready;
      if (!(await gateSupported(ee))) {
        toast.error("This escrow contract has no funding check to finish.");
        return null;
      }
      setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Confirming funding...");
      try {
        const funded = await runGate(ee, id);
        invalidateBalanceQueries();
        setState((prev) => ({ ...prev, step: "success", isProcessing: false, funding: funded ? "funded" : "unfunded" }));
        if (funded) toast.success("Escrow funded", { id: toastId });
        else toast.error(ESCROW_UNFUNDED_MESSAGE, { id: toastId });
        return funded ? "funded" : "unfunded";
      } catch (err) {
        const msg = pendingFundingMessage(id, err);
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [guardWalletReady, gateSupported, runGate],
  );

  /** Unix seconds after which claimDisputeTimeout succeeds, or null if the
   *  escrow is not disputed. Pre-upgrade disputes carry no timestamp and
   *  count from the deadline, matching the contract. */
  const fetchDisputeTimeoutAt = useCallback(
    async (id: number): Promise<bigint | null> => {
      const ee = contracts.EncryptedEscrow as `0x${string}`;
      if (!publicClient || !ee || ee === ZERO_ADDRESS) return null;
      const [disputedAt, timeout, escrow] = await Promise.all([
        publicClient.readContract({ address: ee, abi: EncryptedEscrowAbi, functionName: "getDisputedAt", args: [BigInt(id)] }) as Promise<bigint>,
        publicClient.readContract({ address: ee, abi: EncryptedEscrowAbi, functionName: "DISPUTE_TIMEOUT" }) as Promise<bigint>,
        publicClient.readContract({ address: ee, abi: EncryptedEscrowAbi, functionName: "getEscrow", args: [BigInt(id)] }) as Promise<
          readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint, boolean, boolean, number, string, bigint]
        >,
      ]);
      if (escrow[7] !== ESCROW_STATUS.Disputed) return null;
      const start = disputedAt === 0n ? escrow[4] : disputedAt;
      return start + timeout;
    },
    [contracts.EncryptedEscrow, publicClient],
  );


  /** Seconds since epoch the dispute opened, 0 if never or opened before the
   *  timestamp existed (those count from the deadline). Null on read failure. */
  const getDisputedAt = useCallback(
    async (id: number): Promise<number | null> => {
      const ee = contracts.EncryptedEscrow as `0x${string}`;
      if (!publicClient || !ee || ee === ZERO_ADDRESS) return null;
      try {
        const at = (await publicClient.readContract({
          address: ee,
          abi: EncryptedEscrowAbi,
          functionName: "getDisputedAt",
          args: [BigInt(id)],
        })) as bigint;
        return Number(at);
      } catch {
        return null;
      }
    },
    [publicClient, contracts.EncryptedEscrow],
  );

  // Conditional-invoice actions. approveInvoice writes to the escrow's own
  // resolver (conditions are keyed by escrow contract + id); the
  // permissionless triggerRelease pokes the escrow once the rule is met.
  const approveInvoice = useCallback(
    async (escrowId: number, target?: { resolver: `0x${string}`; legacy: boolean }) => {
      const ready = guardWalletReady();
      if (!ready) return false;
      const { ee } = ready;
      const resolver = target?.resolver ?? (contracts.InvoiceApprovalResolver as `0x${string}`);
      if (!resolver || resolver === ZERO_ADDRESS) {
        toast.error("Conditional invoices are only available on Arbitrum Sepolia.");
        return false;
      }
      try {
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        if (target?.legacy) {
          await unifiedWriteAndWait({
            address: resolver,
            abi: InvoiceApprovalResolverLegacyAbi,
            functionName: "approve",
            args: [BigInt(escrowId)],
            gas: BigInt(300_000),
          });
        } else {
          await unifiedWriteAndWait({
            address: resolver,
            abi: InvoiceApprovalResolverAbi,
            functionName: "approve",
            args: [ee, BigInt(escrowId)],
            gas: BigInt(300_000),
          });
        }
        setState((prev) => ({ ...prev, step: "success", isProcessing: false }));
        invalidateBalanceQueries();
        toast.success("Release approved");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardWalletReady, contracts.InvoiceApprovalResolver, unifiedWriteAndWait],
  );

  /** Reads the release condition of one conditional invoice. */
  const getConditionalInvoice = useCallback(
    (escrowId: number) => {
      if (!publicClient) return Promise.resolve(null);
      return readConditionalInvoice(publicClient, {
        escrow: contracts.EncryptedEscrow as `0x${string}`,
        currentResolver: contracts.InvoiceApprovalResolver as `0x${string}`,
        escrowId,
      });
    },
    [publicClient, contracts.EncryptedEscrow, contracts.InvoiceApprovalResolver],
  );

  const triggerRelease = useCallback((id: number) => callSimple("releaseIfConditionMet", [BigInt(id)]), [callSimple]);

  const reset = useCallback(() => { setState(initial); pipeline.reset(); }, [pipeline]);

  // §3.12 of BEST_VERSION_FULL_PLAN: derived txExplorerUrl.
  const txExplorerUrl = state.txHash ? getExplorerTxUrl(state.txHash, activeChainId) : null;

  return {
    state,
    txExplorerUrl,
    pipeline: pipeline.state,
    createEscrow,
    createConditionalInvoice,
    approveInvoice,
    getConditionalInvoice,
    triggerRelease,
    markDelivered,
    approveRelease,
    disputeEscrow,
    claimDisputeTimeout,
    cancelPendingEscrow,
    finishFunding,
    getDisputedAt,
    claimExpiredEscrow,
    fetchDisputeTimeoutAt,
    arbiterDecide,
    reset,
  };
}
