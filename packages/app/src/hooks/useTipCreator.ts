import { useState, useCallback, useRef } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { CreatorHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity, insertCreatorSupporter, incrementCreatorSupporterCount } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { useUnifiedWrite } from "./useUnifiedWrite";

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
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();

  const [isTipping, setIsTipping] = useState(false);
  const submittingRef = useRef(false);

  const tip = useCallback(
    async (creator: string, amount: string, message: string) => {
      if (!address || !connected) return;
      if (submittingRef.current) return; // Prevent double-submit (ref-based)

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      try {
        submittingRef.current = true;
        setIsTipping(true);

        if (!amount || amount.trim() === "") {
          toast.error("Enter an amount");
          return;
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

        // Encrypt the tip amount
        const [rawEncAmount] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ]);
        // Normalize SDK output — the SDK wraps ctHash/securityZone/utype/
        // signature either at the top level or inside `.data`. The contract's
        // InEuint64 ABI tuple expects them at the top level. useSendPayment
        // normalizes the same way; without this the signature in the
        // encrypted input doesn't line up with the ctHash when verified on-
        // chain → "InvalidSigner" revert from MockTaskManager.verifyInput.
        const raw = rawEncAmount as {
          ctHash?: bigint | string | number; securityZone?: number; utype?: number; signature?: `0x${string}`;
          data?: { ctHash?: bigint | string | number; securityZone?: number; utype?: number; signature?: `0x${string}` };
        };
        const encAmount = {
          ctHash: BigInt(raw.ctHash ?? raw.data?.ctHash ?? 0),
          securityZone: Number(raw.securityZone ?? raw.data?.securityZone ?? 0),
          utype: Number(raw.utype ?? raw.data?.utype ?? 5),
          signature: (raw.signature ?? raw.data?.signature ?? "0x") as `0x${string}`,
        };

        // Call CreatorHub.support() — unifiedWriteAndWait so AA path skips
        // the chain-side polling (free RPC tier rate-limits it).
        const tipResult = await unifiedWriteAndWait({
          address: contracts.CreatorHub as `0x${string}`,
          abi: CreatorHubAbi,
          functionName: "support",
          args: [
            creator as `0x${string}`,
            contracts.FHERC20Vault_USDC as `0x${string}`,
            encAmount as unknown as EncryptedInput,
            message,
          ],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = tipResult.hash;
        const tipBlockNumber =
          tipResult.receipt?.blockNumber ??
          (await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })).blockNumber;
        const tipStatus =
          tipResult.receipt?.status ??
          (await publicClient.getTransactionReceipt({ hash })).status;
        if (tipStatus === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Write to Supabase AFTER confirmed on-chain tx
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: creator.toLowerCase(),
          activity_type: ACTIVITY_TYPES.TIP,
          contract_address: contracts.CreatorHub,
          note: message,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(tipBlockNumber),
        });

        try {
          await insertCreatorSupporter({
            creator_address: creator,
            supporter_address: address,
            message,
          });
          await incrementCreatorSupporterCount(creator);
        } catch (supporterErr) {
          console.warn("Failed to insert creator supporter record:", supporterErr);
        }

        // Notify other tabs and invalidate cached balances
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Tip sent!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Tip failed";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.CreatorHub);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsTipping(false);
      }
    },
    [address, connected, encryptInputsAsync, unifiedWrite, unifiedWriteAndWait, publicClient, contracts]
  );

  return { isTipping, tip };
}
