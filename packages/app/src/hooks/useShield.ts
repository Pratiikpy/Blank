import { useState, useCallback } from "react";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import toast from "react-hot-toast";
import { CONTRACTS } from "@/lib/constants";
import { TestUSDCAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Rate limiting constants ────────────────────────────────────────
const FAUCET_COOLDOWN_MS = 60_000; // 1 minute between faucet calls
const FAUCET_KEY = "blank_last_faucet";

export type ShieldStep = "idle" | "approving" | "shielding" | "success" | "error";

export function useShield() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [step, setStep] = useState<ShieldStep>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { writeContractAsync } = useWriteContract();

  // Read public USDC balance — refetchInterval polls every 5s for fresh data
  const { data: publicBalance, refetch: refetchBalance } = useReadContract({
    address: CONTRACTS.TestUSDC as `0x${string}`,
    abi: TestUSDCAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!CONTRACTS.TestUSDC,
      refetchInterval: 5000, // Poll every 5s for balance updates
    },
  });

  // Read vault total deposited
  const { data: vaultBalance, refetch: refetchVault } = useReadContract({
    address: CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
    abi: FHERC20VaultAbi,
    functionName: "totalDeposited",
    query: {
      enabled: !!CONTRACTS.FHERC20Vault_USDC,
      refetchInterval: 10000,
    },
  });

  // Helper: wait for tx confirmation then refetch balances. Returns receipt.
  const waitAndRefetch = useCallback(async (hash: `0x${string}`) => {
    if (!publicClient) return undefined;
    try {
      // Wait for 1 confirmation
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }
      // Now refetch — balance has changed on-chain
      await Promise.all([refetchBalance(), refetchVault()]);
      return receipt;
    } catch {
      // Still try to refetch even if wait fails
      await Promise.all([refetchBalance(), refetchVault()]);
      return undefined;
    }
  }, [publicClient, refetchBalance, refetchVault]);

  // Mint test tokens — returns hash on success, null on failure
  const [isMinting, setIsMinting] = useState(false);

  const mintTestTokens = useCallback(async (): Promise<`0x${string}` | null> => {
    if (!address || !CONTRACTS.TestUSDC || isMinting) return null;

    // Rate limiting: prevent faucet spam (1 minute cooldown)
    const lastFaucet = parseInt(localStorage.getItem(FAUCET_KEY) || "0");
    if (Date.now() - lastFaucet < FAUCET_COOLDOWN_MS) {
      const remaining = Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - lastFaucet)) / 1000);
      toast.error(`Please wait ${remaining}s before using faucet again`);
      return null;
    }

    setIsMinting(true);
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.TestUSDC as `0x${string}`,
        abi: TestUSDCAbi,
        functionName: "faucet",
      });
      toast("Minting 10,000 test USDC...", { icon: "⏳" });
      setTxHash(hash);

      // Wait for confirmation THEN refetch
      await waitAndRefetch(hash);

      // Record faucet usage for rate limiting
      try { localStorage.setItem(FAUCET_KEY, String(Date.now())); } catch {}

      // Notify other tabs and invalidate cached balances
      broadcastAction("balance_changed");
      invalidateBalanceQueries();

      toast.success("10,000 USDC minted!");
      return hash;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint test tokens");
      return null;
    } finally {
      setIsMinting(false);
    }
  }, [address, writeContractAsync, waitAndRefetch, isMinting]);

  // Shield: approve + deposit — returns hash on success, null on failure
  const shield = useCallback(async (amount: string): Promise<`0x${string}` | null> => {
    if (!address || !CONTRACTS.TestUSDC || !CONTRACTS.FHERC20Vault_USDC) return null;

    try {
      if (!amount || amount.trim() === "") {
        toast.error("Enter an amount");
        return null;
      }

      setStep("approving");
      setError(null);

      const amountWei = parseUnits(amount, 6);

      // Type assertion: wagmi's useReadContract returns unknown for untyped ABIs;
      // balanceOf always returns a uint256 which viem decodes as bigint
      if (publicBalance && amountWei > (publicBalance as bigint)) {
        toast.error("Insufficient USDC balance");
        setStep("idle");
        return null;
      }

      // Step 1: Approve vault to spend USDC
      const approveHash = await writeContractAsync({
        address: CONTRACTS.TestUSDC as `0x${string}`,
        abi: TestUSDCAbi,
        functionName: "approve",
        args: [CONTRACTS.FHERC20Vault_USDC as `0x${string}`, amountWei],
      });
      toast.success("Approval submitted...");

      // Wait for approval to confirm
      await waitAndRefetch(approveHash);

      // Step 2: Shield (deposit into vault)
      setStep("shielding");
      const shieldHash = await writeContractAsync({
        address: CONTRACTS.FHERC20Vault_USDC as `0x${string}`,
        abi: FHERC20VaultAbi,
        functionName: "shield",
        args: [amountWei],
      });

      setTxHash(shieldHash);

      // Wait for shield to confirm THEN refetch
      const shieldReceipt = await waitAndRefetch(shieldHash);
      setStep("success");

      // Notify other tabs and invalidate cached balances
      broadcastAction("balance_changed");
      broadcastAction("activity_added");
      invalidateBalanceQueries();

      // Write to Supabase for activity feed
      await insertActivity({
        tx_hash: shieldHash,
        user_from: address.toLowerCase(),
        user_to: address.toLowerCase(),
        activity_type: "shield",
        contract_address: CONTRACTS.FHERC20Vault_USDC,
        note: `Shielded ${amount} USDC`,
        token_address: CONTRACTS.TestUSDC,
        // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
        block_number: shieldReceipt ? Number(shieldReceipt.blockNumber) : 0,
      });

      toast.success(`Shielded ${amount} USDC!`);
      return shieldHash;
    } catch (err) {
      setStep("error");
      setError(err instanceof Error ? err.message : "Shield failed");
      toast.error(err instanceof Error ? err.message : "Shield failed");
      return null;
    }
  }, [address, writeContractAsync, waitAndRefetch, publicBalance]);

  const reset = useCallback(() => {
    setStep("idle");
    setTxHash(null);
    setError(null);
  }, []);

  return {
    step,
    txHash,
    error,
    isMinting,
    // Type assertion: wagmi returns unknown for untyped ABIs; these ERC20 views return uint256 (bigint)
    publicBalance: publicBalance ? Number(formatUnits(publicBalance as bigint, 6)) : 0,
    vaultBalance: vaultBalance ? Number(formatUnits(vaultBalance as bigint, 6)) : 0,
    shield,
    mintTestTokens,
    reset,
    refetchBalance,
  };
}
