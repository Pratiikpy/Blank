import { useState, useCallback, useEffect } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits, formatUnits, encodeFunctionData } from "viem";
import toast from "react-hot-toast";
import { useChain } from "@/providers/ChainProvider";
import { TestUSDCAbi, FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";
import {
  STORAGE_KEYS,
  getStoredJson,
  setStoredJson,
  getStoredString,
  setStoredString,
  removeStored,
} from "@/lib/storage";

// ─── Rate limiting constants ────────────────────────────────────────
const FAUCET_COOLDOWN_MS = 60_000; // 1 minute between faucet calls

// Pending unshield persistence (tab-close resilience).
// chainId is passed in explicitly from the hook body (sourced from
// useChain()) so switching chains doesn't cause us to resume a ctHash
// that belongs to a different network, and so this helper is safe to
// call after a reload-free chain switch.
const pendingUnshieldKey = (addr: string, chainId: number) =>
  STORAGE_KEYS.pendingUnshield(addr, chainId);

export type ShieldStep = "idle" | "approving" | "shielding" | "success" | "error";
export type UnshieldStep = "idle" | "encrypting" | "requesting" | "decrypting" | "claiming" | "success" | "error";

export function useShield() {
  const { activeChainId, contracts } = useChain();
  // Pass `chainId` so wagmi's public client resolves for the active chain
  // even when no EOA is connected (passkey-only users). Same fix as
  // useSmartAccount.
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [step, setStep] = useState<ShieldStep>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const passphrasePrompt = usePassphrasePrompt();

  // Effective address: smart account when active, EOA otherwise. Without
  // this, smart-wallet users see $0 USDC (we'd be reading the EOA's balance
  // not the smart account's). Same fix as useEncryptedBalance.
  const { effectiveAddress: address, smartAccount } = useEffectiveAddress();

  // Read public USDC balance — refetchInterval polls every 5s for fresh data.
  // `chainId` is passed explicitly so passkey-only users (no EOA → no wagmi
  // "connected" chain) still get reads routed to the correct chain.
  const { data: publicBalance, refetch: refetchBalance } = useReadContract({
    address: contracts.TestUSDC as `0x${string}`,
    abi: TestUSDCAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: activeChainId,
    query: {
      enabled: !!address && !!contracts.TestUSDC,
      refetchInterval: 5000, // Poll every 5s for balance updates
    },
  });

  // Read vault total deposited
  const { data: vaultBalance, refetch: refetchVault } = useReadContract({
    address: contracts.FHERC20Vault_USDC as `0x${string}`,
    abi: FHERC20VaultAbi,
    functionName: "totalDeposited",
    chainId: activeChainId,
    query: {
      enabled: !!contracts.FHERC20Vault_USDC,
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
    if (!address || !contracts.TestUSDC || isMinting) return null;

    // Rate limiting: prevent faucet spam (1 minute cooldown)
    const faucetKey = STORAGE_KEYS.faucetCooldown(address, activeChainId);
    const lastFaucet = parseInt(getStoredString(faucetKey) || "0");
    if (Date.now() - lastFaucet < FAUCET_COOLDOWN_MS) {
      const remaining = Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - lastFaucet)) / 1000);
      toast.error(`Please wait ${remaining}s before using faucet again`);
      return null;
    }

    setIsMinting(true);
    try {
      const hash = await unifiedWrite({
        address: contracts.TestUSDC as `0x${string}`,
        abi: TestUSDCAbi,
        functionName: "faucet",
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
      });
      toast("Minting 10,000 test USDC...", { icon: "⏳" });
      setTxHash(hash);

      // Wait for confirmation THEN refetch
      await waitAndRefetch(hash);

      // Record faucet usage for rate limiting
      setStoredString(faucetKey, String(Date.now()));

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
  }, [address, unifiedWrite, waitAndRefetch, isMinting, activeChainId, contracts]);

  // Mint test USDT — parallel to mintTestTokens, uses the per-token cooldown
  // so USDC and USDT faucets don't block each other. TestUSDT inherits
  // TestUSDC's bytecode, so the faucet() selector is identical — we can
  // reuse TestUSDCAbi here. Chains without TestUSDT deployed short-circuit.
  const [isMintingUsdt, setIsMintingUsdt] = useState(false);

  const mintTestUSDT = useCallback(async (): Promise<`0x${string}` | null> => {
    if (!address || !contracts.TestUSDT || isMintingUsdt) {
      if (!contracts.TestUSDT) toast.error("USDT faucet only available on Base Sepolia");
      return null;
    }

    const faucetKey = STORAGE_KEYS.faucetCooldownUsdt(address, activeChainId);
    const lastFaucet = parseInt(getStoredString(faucetKey) || "0");
    if (Date.now() - lastFaucet < FAUCET_COOLDOWN_MS) {
      const remaining = Math.ceil((FAUCET_COOLDOWN_MS - (Date.now() - lastFaucet)) / 1000);
      toast.error(`Please wait ${remaining}s before using USDT faucet again`);
      return null;
    }

    setIsMintingUsdt(true);
    try {
      const hash = await unifiedWrite({
        address: contracts.TestUSDT as `0x${string}`,
        abi: TestUSDCAbi,
        functionName: "faucet",
        gas: BigInt(5_000_000),
      });
      toast("Minting 10,000 test USDT...", { icon: "⏳" });

      await waitAndRefetch(hash);

      setStoredString(faucetKey, String(Date.now()));

      broadcastAction("balance_changed");
      invalidateBalanceQueries();

      toast.success("10,000 USDT minted!");
      return hash;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint test USDT");
      return null;
    } finally {
      setIsMintingUsdt(false);
    }
  }, [address, unifiedWrite, waitAndRefetch, isMintingUsdt, activeChainId, contracts]);

  // Shield: approve + deposit — returns hash on success, null on failure.
  //
  // Two execution paths share this entry point:
  //  - SMART ACCOUNT (passkey active): bundles approve+shield into one
  //    UserOp via BlankAccount.executeBatch. One passphrase prompt, one
  //    on-chain submission. The smart account itself must hold the
  //    underlying USDC — caller transfers from the EOA first if needed.
  //  - EOA (no passkey or passkey not active): existing wagmi path. Two
  //    sequential txs: approve, then shield. User signs each MetaMask popup.
  const shield = useCallback(async (amount: string): Promise<`0x${string}` | null> => {
    if (!address || !contracts.TestUSDC || !contracts.FHERC20Vault_USDC) return null;
    if (!amount || amount.trim() === "") {
      toast.error("Enter an amount");
      return null;
    }
    const amountWei = parseUnits(amount, 6);

    // ─── Smart-account path ──────────────────────────────────────────
    if (smartAccount.status === "ready" && smartAccount.account) {
      try {
        setStep("approving");
        setError(null);

        const passphrase = await passphrasePrompt.request({
          title: "Sign shield transaction",
          subtitle: `Bundle approve + shield ${amount} USDC into one UserOp.`,
        });
        if (!passphrase) {
          setStep("idle");
          return null;
        }

        setStep("shielding");
        // Encode the two inner calls — approve, then shield
        const approveData = encodeFunctionData({
          abi: TestUSDCAbi,
          functionName: "approve",
          args: [contracts.FHERC20Vault_USDC as `0x${string}`, amountWei],
        });
        const shieldData = encodeFunctionData({
          abi: FHERC20VaultAbi,
          functionName: "shield",
          args: [amountWei],
        });

        const result = await smartAccount.sendBatchUserOp(
          [contracts.TestUSDC as `0x${string}`, contracts.FHERC20Vault_USDC as `0x${string}`],
          [0n, 0n],
          [approveData, shieldData],
          passphrase,
        );
        if (!result) {
          setStep("error");
          return null;
        }

        setTxHash(result.txHash);
        const shieldReceipt = await waitAndRefetch(result.txHash);
        setStep("success");

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        await insertActivity({
          tx_hash: result.txHash,
          user_from: smartAccount.account.address.toLowerCase(),
          user_to: smartAccount.account.address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.SHIELD,
          contract_address: contracts.FHERC20Vault_USDC,
          note: `Shielded ${amount} USDC (via smart wallet)`,
          token_address: contracts.TestUSDC,
          block_number: shieldReceipt ? Number(shieldReceipt.blockNumber) : 0,
        });

        toast.success(`Shielded ${amount} USDC via smart wallet!`);
        return result.txHash;
      } catch (err) {
        setStep("error");
        const msg = err instanceof Error ? err.message : "Shield failed";
        setError(msg);
        toast.error(msg);
        return null;
      }
    }

    // ─── EOA path (unchanged) ────────────────────────────────────────
    try {
      setStep("approving");
      setError(null);

      // Type assertion: wagmi's useReadContract returns unknown for untyped ABIs;
      // balanceOf always returns a uint256 which viem decodes as bigint
      if (publicBalance && amountWei > (publicBalance as bigint)) {
        toast.error("Insufficient USDC balance");
        setStep("idle");
        return null;
      }

      // Step 1: Approve vault to spend USDC. unifiedWriteAndWait so AA path
      // gets the relayer's pre-confirmed receipt instead of polling the
      // free RPC tier (which hits rate limits and silently times out).
      const approveResult = await unifiedWriteAndWait({
        address: contracts.TestUSDC as `0x${string}`,
        abi: TestUSDCAbi,
        functionName: "approve",
        args: [contracts.FHERC20Vault_USDC as `0x${string}`, amountWei],
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
      });
      toast.success("Approval submitted...");

      // EOA path needs polling; AA path skips it (relayer already waited).
      if (!approveResult.receipt) await waitAndRefetch(approveResult.hash);
      else await Promise.all([refetchBalance(), refetchVault()]);

      // Step 2: Shield (deposit into vault)
      setStep("shielding");
      const shieldResult = await unifiedWriteAndWait({
        address: contracts.FHERC20Vault_USDC as `0x${string}`,
        abi: FHERC20VaultAbi,
        functionName: "shield",
        args: [amountWei],
        gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
      });
      const shieldHash = shieldResult.hash;

      setTxHash(shieldHash);

      const shieldReceipt = shieldResult.receipt
        ? (await Promise.all([refetchBalance(), refetchVault()]), shieldResult.receipt)
        : await waitAndRefetch(shieldHash);
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
        activity_type: ACTIVITY_TYPES.SHIELD,
        contract_address: contracts.FHERC20Vault_USDC,
        note: `Shielded ${amount} USDC`,
        token_address: contracts.TestUSDC,
        // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
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
  }, [address, unifiedWrite, unifiedWriteAndWait, waitAndRefetch, refetchBalance, refetchVault, publicBalance, smartAccount, passphrasePrompt, contracts]);

  // ─── Unshield (request → off-chain decrypt → claim) ────────────────
  // v0.1.3 flow: requestUnshield calls FHE.allowPublic on-chain. We then
  // call client.decryptForTx off-chain to get (plaintext, signature) and
  // submit them via claimUnshield. Persisted to localStorage so closing
  // the tab mid-flow doesn't strand the pending claim.
  const [unshieldStep, setUnshieldStep] = useState<UnshieldStep>("idle");
  const [unshieldError, setUnshieldError] = useState<string | null>(null);
  const { decryptForTx } = useCofheDecryptForTx();

  // Read this user's pending unshield ctHash (zero if none pending)
  const { data: pendingCtHash, refetch: refetchPending } = useReadContract({
    address: contracts.FHERC20Vault_USDC as `0x${string}`,
    abi: FHERC20VaultAbi,
    functionName: "pendingUnshield",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!contracts.FHERC20Vault_USDC,
      refetchInterval: 8000,
    },
  });

  const hasPendingUnshield = !!pendingCtHash && (pendingCtHash as bigint) !== 0n;

  // Internal: claim a pending unshield once the Threshold Network has the result.
  // Polls decryptForTx every 5s up to ~60s, then submits the proof to claimUnshield.
  const _attemptClaim = useCallback(async (ctHash: bigint, amountHint: string): Promise<boolean> => {
    if (!address || !publicClient) return false;
    setUnshieldStep("decrypting");
    const startedAt = Date.now();
    const TIMEOUT_MS = 60_000;
    let lastErr: string | null = null;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const result = await decryptForTx(ctHash, "uint64");
      if (result) {
        const plaintext = typeof result.decryptedValue === "bigint"
          ? result.decryptedValue
          : BigInt(result.decryptedValue ? 1 : 0);

        setUnshieldStep("claiming");
        try {
          const claimHash = await unifiedWrite({
            address: contracts.FHERC20Vault_USDC as `0x${string}`,
            abi: FHERC20VaultAbi,
            functionName: "claimUnshield",
            args: [plaintext, result.signature],
            gas: BigInt(5_000_000),
          });
          await waitAndRefetch(claimHash);
          await refetchPending();

          // Clear the persisted pending state — claim succeeded
          removeStored(pendingUnshieldKey(address, activeChainId));

          broadcastAction("balance_changed");
          broadcastAction("activity_added");
          invalidateBalanceQueries();

          // Fetch the claim receipt so block_number reflects the actual tx.
          const claimReceipt = await publicClient.getTransactionReceipt({ hash: claimHash }).catch(() => undefined);
          await insertActivity({
            tx_hash: claimHash,
            user_from: address.toLowerCase(),
            user_to: address.toLowerCase(),
            activity_type: ACTIVITY_TYPES.UNSHIELD,
            contract_address: contracts.FHERC20Vault_USDC,
            note: amountHint ? `Unshielded ${amountHint} USDC` : "Unshielded USDC",
            token_address: contracts.TestUSDC,
            block_number: claimReceipt ? Number(claimReceipt.blockNumber) : 0,
          });

          setUnshieldStep("success");
          toast.success(amountHint ? `Unshielded ${amountHint} USDC!` : "Unshield complete!");
          return true;
        } catch (claimErr) {
          lastErr = claimErr instanceof Error ? claimErr.message : "Claim transaction failed";
          break; // Don't retry the on-chain call — only retry the decrypt
        }
      }
      // Decrypt not ready yet — wait and retry
      await new Promise((r) => setTimeout(r, 5000));
    }

    setUnshieldStep("error");
    setUnshieldError(lastErr ?? "Decryption timed out — pending unshield will retry on next page load");
    toast.error(lastErr ?? "Decryption timed out — claim still pending");
    return false;
  }, [address, publicClient, decryptForTx, unifiedWrite, waitAndRefetch, refetchPending, contracts, activeChainId]);

  // Public: initiate an unshield. Encrypts amount, calls requestUnshield,
  // then immediately attempts the claim (after the on-chain allowPublic).
  const unshield = useCallback(async (amount: string, encryptInputsAsync: (items: unknown[]) => Promise<unknown[]>, Encryptable: any): Promise<boolean> => {
    if (!address || !contracts.FHERC20Vault_USDC) return false;
    if (!amount || amount.trim() === "") {
      toast.error("Enter an amount to unshield");
      return false;
    }

    setUnshieldStep("encrypting");
    setUnshieldError(null);

    try {
      const amountWei = parseUnits(amount, 6);
      const encrypted = await encryptInputsAsync([Encryptable.uint64(amountWei)]);
      const raw = encrypted[0] as any;
      const encAmount = {
        ctHash: BigInt(raw.ctHash ?? raw.data?.ctHash ?? 0),
        securityZone: Number(raw.securityZone ?? raw.data?.securityZone ?? 0),
        utype: Number(raw.utype ?? raw.data?.utype ?? 5),
        signature: (raw.signature ?? raw.data?.signature ?? "0x") as `0x${string}`,
      };

      setUnshieldStep("requesting");
      const reqHash = await unifiedWrite({
        address: contracts.FHERC20Vault_USDC as `0x${string}`,
        abi: FHERC20VaultAbi,
        functionName: "requestUnshield",
        args: [encAmount],
        gas: BigInt(5_000_000),
      });

      // Persist pending state — if tab closes, we resume on next mount
      setStoredJson(pendingUnshieldKey(address, activeChainId), {
        requestedAt: Date.now(),
        txHash: reqHash,
        amount,
      });

      const receipt = await waitAndRefetch(reqHash);
      if (!receipt) {
        setUnshieldStep("error");
        setUnshieldError("Request transaction confirmation failed");
        return false;
      }

      // Refetch the ctHash now that the request is on-chain
      const refreshed = await refetchPending();
      const newCtHash = refreshed.data as bigint | undefined;
      if (!newCtHash || newCtHash === 0n) {
        setUnshieldStep("error");
        setUnshieldError("Pending unshield handle missing after request");
        return false;
      }

      return await _attemptClaim(newCtHash, amount);
    } catch (err) {
      setUnshieldStep("error");
      setUnshieldError(err instanceof Error ? err.message : "Unshield failed");
      toast.error(err instanceof Error ? err.message : "Unshield failed");
      return false;
    }
  }, [address, unifiedWrite, waitAndRefetch, refetchPending, _attemptClaim, contracts, activeChainId]);

  // Auto-resume any pending unshield from a previous session.
  // Runs once on mount when address + ctHash are available.
  useEffect(() => {
    if (!address || !hasPendingUnshield || unshieldStep !== "idle") return;
    const data = getStoredJson<{ amount?: string } | null>(
      pendingUnshieldKey(address, activeChainId),
      null,
    );
    if (!data) return; // pending on-chain but no local hint — leave it for explicit retry
    console.log("[useShield] Auto-resuming pending unshield from previous session");
    _attemptClaim(pendingCtHash as bigint, data.amount ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, hasPendingUnshield, activeChainId]);

  // Manual claim retry — surfaced to UI for the failure case
  const retryUnshieldClaim = useCallback(async () => {
    if (!address || !hasPendingUnshield) return false;
    const data = getStoredJson<{ amount?: string } | null>(
      pendingUnshieldKey(address, activeChainId),
      null,
    );
    const amountHint = data?.amount ?? "";
    return await _attemptClaim(pendingCtHash as bigint, amountHint);
  }, [address, hasPendingUnshield, pendingCtHash, _attemptClaim, activeChainId]);

  const reset = useCallback(() => {
    setStep("idle");
    setTxHash(null);
    setError(null);
    setUnshieldStep("idle");
    setUnshieldError(null);
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
    mintTestUSDT,
    isMintingUsdt,
    // Unshield surface (new in v0.1.3 migration)
    unshield,
    unshieldStep,
    unshieldError,
    hasPendingUnshield,
    retryUnshieldClaim,
    reset,
    refetchBalance,
  };
}
