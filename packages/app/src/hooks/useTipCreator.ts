import { useState, useCallback, useRef } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { CreatorHubAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity, insertCreatorSupporter } from "@/lib/supabase";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

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

export function useTipCreator() {
  const { address } = useAccount();
  const { connected } = useCofheConnection();
  const publicClient = usePublicClient();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

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
        const amountWei = parseUnits(amount, 6);

        // Ensure the CreatorHub contract is approved to transferFrom on the vault
        if (!isVaultApproved(CONTRACTS.CreatorHub)) {
          await ensureVaultApproval(
            writeContractAsync,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            CONTRACTS.CreatorHub as `0x${string}`,
          );
          markVaultApproved(CONTRACTS.CreatorHub);
        }

        // Encrypt the tip amount
        const [encAmount] = await encryptInputsAsync([
          Encryptable.uint64(amountWei),
        ]);

        // Call CreatorHub.support() on-chain
        const hash = await writeContractAsync({
          address: CONTRACTS.CreatorHub as `0x${string}`,
          abi: CreatorHubAbi,
          functionName: "support",
          args: [
            creator as `0x${string}`,
            CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encAmount as unknown as EncryptedInput,
            message,
          ],
        });

        // Wait for on-chain confirmation before writing to Supabase
        const tipReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (tipReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Write to Supabase AFTER confirmed on-chain tx
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: creator.toLowerCase(),
          activity_type: "tip",
          contract_address: CONTRACTS.CreatorHub,
          note: message,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(tipReceipt.blockNumber),
        });

        try {
          await insertCreatorSupporter({
            creator_address: creator,
            supporter_address: address,
            message,
          });
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
          clearVaultApproval(CONTRACTS.CreatorHub);
        }
        toast.error(msg);
      } finally {
        submittingRef.current = false;
        setIsTipping(false);
      }
    },
    [address, connected, encryptInputsAsync, writeContractAsync, publicClient]
  );

  return { isTipping, tip };
}
