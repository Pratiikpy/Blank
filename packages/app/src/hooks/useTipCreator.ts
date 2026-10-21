import { useState, useCallback, useEffect, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForTx, ENCRYPTION_NOT_READY } from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { log } from "@/lib/log";
import { MAX_UINT64 } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { CreatorHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity, insertCreatorSupporter, recomputeCreatorSupporterCount } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { runFundingGate, supportsFundingGate } from "@/lib/funding-gate";
import {
  addPendingFunding,
  asHandle,
  describeGateFailure,
  findPendingId,
  listPendingFundings,
  removePendingFunding,
  type PendingFundingScope,
} from "@/lib/pending-funding";
import { useUnifiedWrite } from "./useUnifiedWrite";

// CreatorHub.TipStatus
const TIP_PENDING = 1;
const TIP_CONFIRMED = 2;
const TIP_VOIDED = 3;

const CONFIRM_GAS = BigInt(1_500_000);

/**
 * confirmed: counted on-chain (or a legacy contract, which counts at once).
 * voided: the vault moved nothing, the tip was not counted.
 * pending: the tip is on-chain but its funding check did not finish; it is
 *   retried on the next visit and anyone can confirm it.
 * failed: nothing was sent, or the transaction failed.
 */
export type TipOutcome = "confirmed" | "voided" | "pending" | "failed";

interface TipContext {
  creator: string;
  message: string;
  hash: `0x${string}`;
  blockNumber: number;
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

export function useTipCreator() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { connected } = useCofheConnection();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForTx } = useCofheDecryptForTx();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();

  const [isTipping, setIsTipping] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [pendingTipCount, setPendingTipCount] = useState(0);
  const submittingRef = useRef(false);
  const finishingRef = useRef(false);
  const gateSupportRef = useRef<{ key: string; value: boolean } | null>(null);
  // Tips whose second step is running now, so a resume never races the tip() that created them.
  const inflightRef = useRef<Set<string>>(new Set());

  const hub = contracts.CreatorHub as `0x${string}`;

  const scope = useCallback(
    (): PendingFundingScope | null =>
      address ? { kind: "tip", chainId: activeChainId, contract: hub, account: address } : null,
    [address, activeChainId, hub],
  );

  const refreshPendingCount = useCallback(() => {
    const s = scope();
    setPendingTipCount(s ? listPendingFundings(s).length : 0);
  }, [scope]);

  // Contracts that predate the funding gate have no nextTipId. Probed once per
  // chain; those contracts keep the single-step behaviour.
  const isGated = useCallback(async (): Promise<boolean> => {
    const key = `${activeChainId}:${hub}`;
    if (gateSupportRef.current?.key === key) return gateSupportRef.current.value;
    const value = await supportsFundingGate(() =>
      publicClient!.readContract({ address: hub, abi: CreatorHubAbi, functionName: "nextTipId" }),
    );
    gateSupportRef.current = { key, value };
    return value;
  }, [activeChainId, hub, publicClient]);

  const readTipStatus = useCallback(
    async (tipId: bigint): Promise<number> => {
      const t = (await publicClient!.readContract({
        address: hub,
        abi: CreatorHubAbi,
        functionName: "getTip",
        args: [tipId],
      })) as readonly [string, string, string, number | bigint];
      return Number(t[3]);
    },
    [publicClient, hub],
  );

  /** Everything the app records once a tip is counted. */
  const recordTip = useCallback(
    async (ctx: TipContext) => {
      if (!address) return;
      await insertActivity({
        tx_hash: ctx.hash,
        user_from: address.toLowerCase(),
        user_to: ctx.creator.toLowerCase(),
        activity_type: ACTIVITY_TYPES.TIP,
        contract_address: contracts.CreatorHub,
        note: ctx.message,
        token_address: contracts.FHERC20Vault_USDC,
        block_number: ctx.blockNumber,
      });

      try {
        await insertCreatorSupporter({
          creator_address: ctx.creator,
          supporter_address: address,
          message: ctx.message,
        });
        await recomputeCreatorSupporterCount(ctx.creator);
      } catch (supporterErr) {
        log.warn("useTipCreator.insertSupporter.failed", supporterErr instanceof Error ? supporterErr : new Error(String(supporterErr)));
      }

      // Notify other tabs and invalidate cached balances
      broadcastAction("balance_changed");
      broadcastAction("activity_added");
      invalidateBalanceQueries();
    },
    [address, contracts.CreatorHub, contracts.FHERC20Vault_USDC],
  );

  // Step 2 of a tip: decrypt the public "funded" bit and publish it with
  // confirmFunding. Throws when the check did not finish; the tip then stays
  // Pending on-chain and in the retry list.
  const settleTip = useCallback(
    async (tipId: bigint, ctx: TipContext): Promise<"confirmed" | "voided"> => {
      const s = scope();
      const key = tipId.toString();
      inflightRef.current.add(key);
      let funded: boolean;
      try {
        ({ funded } = await runFundingGate({
          readHandle: async () =>
            asHandle(
              await publicClient!.readContract({
                address: hub,
                abi: CreatorHubAbi,
                functionName: "getTipFundedHandle",
                args: [tipId],
              }),
            ),
          decryptForTx,
          confirm: async (verdict, signature) => {
            // Anyone may confirm; if someone already did there is nothing to send.
            if ((await readTipStatus(tipId)) !== TIP_PENDING) return;
            const res = await unifiedWriteAndWait({
              address: hub,
              abi: CreatorHubAbi,
              functionName: "confirmFunding",
              args: [tipId, verdict, signature],
              gas: CONFIRM_GAS,
            });
            const receipt =
              res.receipt ?? (await publicClient!.waitForTransactionReceipt({ hash: res.hash, confirmations: 1, timeout: 300_000 }));
            if (receipt.status === "reverted") throw new Error("Funding confirmation reverted on-chain");
          },
        }));
      } catch (err) {
        const settled = await readTipStatus(tipId).catch(() => null);
        if (settled === TIP_CONFIRMED) funded = true;
        else if (settled === TIP_VOIDED) funded = false;
        else {
          inflightRef.current.delete(key);
          throw err;
        }
      }
      inflightRef.current.delete(key);

      if (s) removePendingFunding(s, tipId);
      if (!funded) {
        // A missing allowance moves zero too, so re-approve on the next attempt.
        clearVaultApproval(contracts.CreatorHub);
        return "voided";
      }
      await recordTip(ctx);
      return "confirmed";
    },
    [scope, publicClient, hub, decryptForTx, unifiedWriteAndWait, readTipStatus, recordTip, contracts.CreatorHub],
  );

  const tip = useCallback(
    async (creator: string, amount: string, message: string): Promise<TipOutcome> => {
      if (!address) return "failed";
      if (!connected) { toast.error(ENCRYPTION_NOT_READY); return "failed"; }
      if (submittingRef.current) return "failed"; // Prevent double-submit (ref-based)

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return "failed";
      }

      try {
        submittingRef.current = true;
        setIsTipping(true);

        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return "failed";
        }

        const amountWei = parseUnits(amount, 6);

        // Ensure the CreatorHub contract is approved to transferFrom on the vault
        if (!isVaultApproved(contracts.CreatorHub)) {
          await ensureVaultApproval(
            unifiedWrite,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            contracts.CreatorHub as `0x${string}`,
          );
          markVaultApproved(contracts.CreatorHub);
        }

        const gated = await isGated();

        // Encrypt the tip amount
        const [encAmount, encAmountProof] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ],
        contracts.CreatorHub as `0x${string}`);
        // Call CreatorHub.support() — unifiedWriteAndWait so AA path skips
        // the chain-side polling (free RPC tier rate-limits it).
        const tipResult = await unifiedWriteAndWait({
          address: contracts.CreatorHub as `0x${string}`,
          abi: CreatorHubAbi,
          functionName: "support",
          args: [
            creator as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            encAmount,
            encAmountProof,
            message,
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = tipResult.hash;
        let tipLogs = tipResult.receipt?.logs;
        let tipBlockNumber = tipResult.receipt?.blockNumber;
        if (tipBlockNumber === undefined) {
          const mined = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          tipBlockNumber = mined.blockNumber;
          tipLogs = mined.logs;
        }
        const tipStatus =
          tipResult.receipt?.status ??
          (await publicClient.getTransactionReceipt({ hash })).status;
        if (tipStatus === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        const ctx: TipContext = { creator, message, hash, blockNumber: Number(tipBlockNumber) };

        // The receipt is the authority on which contract version answered: a
        // TipPending log means the tip is not counted yet, whatever the probe said.
        let tipId = findPendingId(tipLogs, hub, "tip");
        if (tipId === null && gated) {
          try {
            const next = (await publicClient.readContract({
              address: hub,
              abi: CreatorHubAbi,
              functionName: "nextTipId",
            })) as bigint;
            if (next > 0n) tipId = next - 1n;
          } catch (idErr) {
            log.warn("useTipCreator.tipId.readFailed", idErr instanceof Error ? idErr : new Error(String(idErr)));
          }
          if (tipId === null) {
            throw new Error("Tip sent, but its id could not be read. It is pending on-chain; check History.");
          }
        }

        if (tipId === null) {
          // Pre-gate contract: the tip is counted by the transaction itself.
          await recordTip(ctx);
          toast.success("Tip sent!");
          return "confirmed";
        }

        const pendingScope = scope();
        if (pendingScope) {
          addPendingFunding(pendingScope, tipId, {
            creator,
            message,
            hash,
            blockNumber: String(ctx.blockNumber),
          });
          refreshPendingCount();
        }

        const toastId = toast.loading("Tip sent. Confirming your balance covered it...");
        let verdict: "confirmed" | "voided";
        try {
          verdict = await settleTip(tipId, ctx);
        } catch (gateErr) {
          toast.error(
            describeGateFailure(gateErr, "The tip is on-chain but not counted yet. It finishes when you reopen Creator Support."),
            { id: toastId },
          );
          return "pending";
        } finally {
          refreshPendingCount();
        }

        if (verdict === "voided") {
          toast.error("Tip did not go through: balance too low", { id: toastId });
          return "voided";
        }
        toast.success("Tip sent!", { id: toastId });
        return "confirmed";
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Tip failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.CreatorHub);
        }
        toast.error(msg);
        return "failed";
      } finally {
        submittingRef.current = false;
        setIsTipping(false);
      }
    },
    [address, connected, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts, hub, isGated, scope, settleTip, recordTip, refreshPendingCount]
  );

  /**
   * Finish tips whose funding check did not complete (tab closed, slow
   * Threshold Network). Safe to call repeatedly. Returns how many tips were
   * counted so the screen can refresh.
   */
  const finishPendingTips = useCallback(async (): Promise<number> => {
    const s = scope();
    if (!s || !publicClient || finishingRef.current) return 0;
    const entries = listPendingFundings(s);
    if (entries.length === 0) {
      setPendingTipCount(0);
      return 0;
    }
    finishingRef.current = true;
    setIsFinishing(true);
    let counted = 0;
    try {
      for (const entry of entries) {
        if (inflightRef.current.has(entry.id)) continue;
        const tipId = BigInt(entry.id);
        const ctx: TipContext = {
          creator: entry.data.creator,
          message: entry.data.message ?? "",
          hash: entry.data.hash as `0x${string}`,
          blockNumber: Number(entry.data.blockNumber ?? 0),
        };
        try {
          const status = await readTipStatus(tipId);
          if (status === TIP_PENDING) {
            const verdict = await settleTip(tipId, ctx);
            if (verdict === "confirmed") counted++;
            else toast.error("A tip did not go through: balance too low");
          } else if (status === TIP_CONFIRMED) {
            removePendingFunding(s, tipId);
            await recordTip(ctx);
            counted++;
          } else {
            removePendingFunding(s, tipId);
            if (status === TIP_VOIDED) toast.error("A tip did not go through: balance too low");
          }
        } catch (err) {
          toast.error(describeGateFailure(err, "It stays pending; try again in a minute."));
        }
      }
      if (counted > 0) toast.success(counted === 1 ? "Tip confirmed" : `${counted} tips confirmed`);
    } finally {
      finishingRef.current = false;
      setIsFinishing(false);
      refreshPendingCount();
    }
    return counted;
  }, [scope, publicClient, readTipStatus, settleTip, recordTip, refreshPendingCount]);

  // Resume anything left over from an earlier visit once the FHE session is up.
  useEffect(() => {
    refreshPendingCount();
    const s = scope();
    if (!s || !connected || !publicClient) return;
    if (listPendingFundings(s).length === 0) return;
    void finishPendingTips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, activeChainId, connected, publicClient]);

  return { isTipping, tip, pendingTipCount, isFinishing, finishPendingTips };
}
