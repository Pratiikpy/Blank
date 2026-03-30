import { useState, useCallback, useEffect } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { baseSepolia } from "viem/chains";
import {
  useCofheEncrypt,
  useCofheConnection,
  useCofheEncryptAndWriteContract,
} from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, type EncryptedInput } from "@/lib/constants";
import { FHERC20VaultAbi, PaymentHubAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { insertActivity } from "@/lib/supabase";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Pending TX recovery key ────────────────────────────────────────
const PENDING_TX_KEY = "blank_pending_send";

// ─── Feature flag: atomic encrypt+write ─────────────────────────────
// When true, uses useCofheEncryptAndWriteContract from @cofhe/react
// to combine encryption and contract write into a single operation.
// This simplifies the step machine from 6 states to 4.
const USE_ATOMIC_ENCRYPT_WRITE = false;

// ─── Step Machine ───────────────────────────────────────────────────

export type SendStep =
  | "input"
  | "approving"
  | "encrypting"
  | "confirming"
  | "sending"
  | "success"
  | "error";

export interface SendPaymentState {
  step: SendStep;
  recipient: string;
  amount: string;
  note: string;
  token: string;
  txHash: string | null;
  error: string | null;
  encryptionProgress: number;
}

const initialState: SendPaymentState = {
  step: "input",
  recipient: "",
  amount: "",
  note: "",
  token: "USDC",
  txHash: null,
  error: null,
  encryptionProgress: 0,
};

// Module-level singleton state so it persists across route navigations
// (SendContacts → SendAmount → SendConfirm → SendSuccess all share this)
let _sharedState: SendPaymentState = { ...initialState };
const _listeners = new Set<() => void>();



export function useSendPayment() {
  const { address, isConnected } = useAccount();
  const { connected: cofheConnected } = useCofheConnection();
  const publicClient = usePublicClient();
  const [state, _setLocalState] = useState<SendPaymentState>(() => _sharedState);

  // Wrapped setState that syncs to shared singleton
  const setState = useCallback((updater: SendPaymentState | ((prev: SendPaymentState) => SendPaymentState)) => {
    const newState = typeof updater === "function" ? updater(_sharedState) : updater;
    _sharedState = newState;
    _setLocalState(newState);
    _listeners.forEach((l) => l());
  }, []);

  // Sync local state with shared state on mount (for cross-route persistence)
  useEffect(() => {
    const listener = () => _setLocalState({ ..._sharedState });
    _listeners.add(listener);
    _setLocalState({ ..._sharedState });
    return () => { _listeners.delete(listener); };
  }, []);

  // ─── Pending TX recovery on mount (#71) ─────────────────────────────
  useEffect(() => {
    try {
      const pending = localStorage.getItem(PENDING_TX_KEY);
      if (pending) {
        const data = JSON.parse(pending);
        // Only show if less than 10 minutes old
        if (Date.now() - data.timestamp < 600_000) {
          toast(`You have a pending send of ${data.amount} ${data.token}. Check explorer: ${data.hash}`, {
            duration: 10000,
          });
        }
        localStorage.removeItem(PENDING_TX_KEY);
      }
    } catch {}
  }, []);

  // ─── Amount warning for large transfers (#90) ─────────────────────
  const amountWarning = parseFloat(state.amount) > 100000
    ? "Large amount -- verify sufficient balance"
    : undefined;

  // ─── Legacy hooks (fallback path) ──────────────────────────────────
  const { encryptInputsAsync, isEncrypting } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

  // ─── TASK 5: Atomic encrypt+write hook from @cofhe/react ──────────
  // useCofheEncryptAndWriteContract combines encryption and write into
  // one operation. It:
  //   1. Extracts encryptable values from ABI args
  //   2. Encrypts them via cofhe SDK (ZK proof + ciphertext)
  //   3. Inserts encrypted values back into args
  //   4. Calls walletClient.writeContract
  // This eliminates the separate "encrypting" -> "confirming" steps.
  const {
    encryptAndWrite,
    encryption: atomicEncryption,
    write: atomicWrite,
  } = useCofheEncryptAndWriteContract();

  // Encrypted input — stored between encrypt and confirm steps (legacy path)
  const [encryptedAmount, setEncryptedAmount] = useState<Record<string, unknown> | null>(null);

  const setRecipient = useCallback((value: string) => {
    setState((s) => ({ ...s, recipient: value }));
  }, []);

  const setAmount = useCallback((value: string) => {
    if (value === "" || /^\d*\.?\d{0,6}$/.test(value)) {
      setState((s) => ({ ...s, amount: value }));
    }
  }, []);

  const setNote = useCallback((value: string) => {
    setState((s) => ({ ...s, note: value.slice(0, 280) }));
  }, []);

  const setToken = useCallback((value: string) => {
    setState((s) => ({ ...s, token: value }));
  }, []);

  const canProceed =
    isConnected &&
    cofheConnected &&
    !!publicClient &&
    state.recipient.length > 0 &&
    state.amount.length > 0 &&
    parseFloat(state.amount) > 0 &&
    state.recipient.toLowerCase() !== address?.toLowerCase();

  // ─── Atomic path: encrypt + write in one shot (TASK 5) ─────────────
  // Steps: input -> confirming -> sending -> success
  // The "confirming" step lets the user review before submitting.
  // On confirm, encryption and transaction happen as one atomic operation.

  const sendAtomic = useCallback(async () => {
    if (!canProceed || !address) return;

    // Go to confirming step — user reviews recipient/amount before final send
    setState((s) => ({ ...s, step: "confirming", encryptionProgress: 0 }));
  }, [canProceed, address]);

  const confirmSendAtomic = useCallback(async () => {
    if (!address) return;
    if (state.step === "sending") return; // Already submitting

    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return;
    }

    try {
      setState((s) => ({ ...s, step: "sending", encryptionProgress: 0 }));

      if (!state.amount || state.amount.trim() === "") {
        toast.error("Enter an amount");
        setState((s) => ({ ...s, step: "input" }));
        return;
      }

      const vaultAddress = CONTRACTS.FHERC20Vault_USDC as `0x${string}`;
      const amountWei = parseUnits(state.amount, 6);

      if (amountWei === 0n || parseFloat(state.amount) < 0.01) {
        toast.error("Minimum amount is $0.01");
        setState((s) => ({ ...s, step: "input" }));
        return;
      }

      // Approve PaymentHub as a spender on the vault (lazy, cached for 24h)
      if (!isVaultApproved(CONTRACTS.PaymentHub)) {
        setState((s) => ({ ...s, step: "encrypting" })); // Show approving state
        const approveHash = await writeContractAsync({
          address: CONTRACTS.FHERC20Vault_USDC,
          abi: FHERC20VaultAbi,
          functionName: "approvePlaintext",
          args: [CONTRACTS.PaymentHub, BigInt("0xFFFFFFFFFFFFFFFF")], // MAX_UINT64
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        markVaultApproved(CONTRACTS.PaymentHub);
      }

      // Atomic encrypt + write via PaymentHub.sendPayment():
      //   1. Extracts the encAmount field from args based on ABI internalType
      //      (our ABI annotates encAmount with internalType: "struct InEuint64")
      //   2. Encrypts it (ZK proof + ciphertext generation)
      //   3. Inserts the encrypted result back into args
      //   4. Calls walletClient.writeContract
      //
      // PaymentHub calls vault.transferFrom() on the user's behalf, which
      // is why the approval step above is required.
      const hash = await encryptAndWrite({
        params: {
          address: CONTRACTS.PaymentHub,
          abi: PaymentHubAbi,
          functionName: "sendPayment",
          chain: baseSepolia,
          account: address,
        },
        args: [
          state.recipient as `0x${string}`,
          vaultAddress,
          amountWei,
          state.note || "",
        ],
      });

      // Save pending tx for crash recovery (#71)
      try {
        localStorage.setItem(PENDING_TX_KEY, JSON.stringify({
          hash,
          recipient: state.recipient,
          amount: state.amount,
          token: state.token,
          timestamp: Date.now(),
        }));
      } catch {}

      // Wait for on-chain confirmation before writing to Supabase
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // Clear pending tx on success
      try { localStorage.removeItem(PENDING_TX_KEY); } catch {}

      // Notify other tabs and invalidate cached balances (#60, #76, #96)
      broadcastAction("balance_changed");
      broadcastAction("activity_added");
      invalidateBalanceQueries();

      setState((s) => ({
        ...s,
        step: "success",
        txHash: hash,
        encryptionProgress: 100,
      }));

      // Write to Supabase for real-time notification to recipient
      await insertActivity({
        tx_hash: hash,
        user_from: address.toLowerCase(),
        user_to: state.recipient.toLowerCase(),
        activity_type: "payment",
        contract_address: vaultAddress,
        note: state.note,
        token_address: CONTRACTS.TestUSDC,
        // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
        block_number: Number(receipt.blockNumber),
      });

      toast.success("Payment sent!");
    } catch (err) {
      // Clear cached approval on allowance/transfer errors so next attempt re-approves
      const msg = err instanceof Error ? err.message : String(err);
      if (/allowance|approve|insufficient|ERC20/i.test(msg)) {
        clearVaultApproval(CONTRACTS.PaymentHub);
      }
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      toast.error(
        err instanceof Error ? err.message : "Transaction failed"
      );
    }
  }, [address, state.step, state.amount, state.recipient, state.note, encryptAndWrite, writeContractAsync, publicClient]);

  // ─── Legacy path: separate encrypt then write ──────────────────────
  // Kept as fallback when USE_ATOMIC_ENCRYPT_WRITE is false.
  // Steps: input -> encrypting -> confirming -> sending -> success

  const sendLegacy = useCallback(async () => {
    if (!canProceed || !address) return;

    if (!state.amount || state.amount.trim() === "") {
      toast.error("Enter an amount");
      return;
    }

    if (parseFloat(state.amount) < 0.01) {
      toast.error("Minimum amount is $0.01");
      return;
    }

    // Just set step to confirming — encryption happens on confirm
    setState((s) => ({ ...s, step: "confirming", encryptionProgress: 0 }));
  }, [canProceed, address, state.amount]);

  const confirmSendLegacy = useCallback(async () => {
    if (!address) return;
    if (state.step === "sending" || state.step === "encrypting") return;

    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return;
    }

    try {
      if (!state.amount || state.amount.trim() === "") {
        toast.error("Enter an amount");
        return;
      }

      // Step 1: Encrypt
      setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

      const vaultAddress = CONTRACTS.FHERC20Vault_USDC as `0x${string}`;
      const amountWei = parseUnits(state.amount, 6);

      const encrypted = await encryptInputsAsync([
        Encryptable.uint64(amountWei),
      ]);
      const encAmount = encrypted[0] as unknown as EncryptedInput;

      // Step 2: Approve + Send
      setState((s) => ({ ...s, step: "sending", encryptionProgress: 100 }));

      if (!isVaultApproved(CONTRACTS.PaymentHub)) {
        const approveHash = await writeContractAsync({
          address: CONTRACTS.FHERC20Vault_USDC,
          abi: FHERC20VaultAbi,
          functionName: "approvePlaintext",
          args: [CONTRACTS.PaymentHub, BigInt("0xFFFFFFFFFFFFFFFF")],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        markVaultApproved(CONTRACTS.PaymentHub);
      }

      const hash = await writeContractAsync({
        address: CONTRACTS.PaymentHub,
        abi: PaymentHubAbi,
        functionName: "sendPayment",
        args: [
          state.recipient as `0x${string}`,
          vaultAddress,
          encAmount,
          state.note || "",
        ],
      });

      // Save pending tx for crash recovery (#71)
      try {
        localStorage.setItem(PENDING_TX_KEY, JSON.stringify({
          hash,
          recipient: state.recipient,
          amount: state.amount,
          token: state.token,
          timestamp: Date.now(),
        }));
      } catch {}

      // Wait for on-chain confirmation before writing to Supabase
      const legacyReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (legacyReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // Clear pending tx on success
      try { localStorage.removeItem(PENDING_TX_KEY); } catch {}

      // Notify other tabs and invalidate cached balances (#60, #76, #96)
      broadcastAction("balance_changed");
      broadcastAction("activity_added");
      invalidateBalanceQueries();

      setState((s) => ({
        ...s,
        step: "success",
        txHash: hash,
      }));

      await insertActivity({
        tx_hash: hash,
        user_from: address.toLowerCase(),
        user_to: state.recipient.toLowerCase(),
        activity_type: "payment",
        contract_address: vaultAddress,
        note: state.note,
        token_address: CONTRACTS.TestUSDC,
        // Safe: Base Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
        block_number: Number(legacyReceipt.blockNumber),
      });

      toast.success("Payment sent!");
    } catch (err) {
      // Clear cached approval on allowance/transfer errors so next attempt re-approves
      const msg = err instanceof Error ? err.message : String(err);
      if (/allowance|approve|insufficient|ERC20/i.test(msg)) {
        clearVaultApproval(CONTRACTS.PaymentHub);
      }
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      toast.error("Transaction failed");
    }
  }, [encryptedAmount, address, state.step, state.recipient, state.note, writeContractAsync, publicClient]);

  // ─── Route to correct implementation ───────────────────────────────

  const send = USE_ATOMIC_ENCRYPT_WRITE ? sendAtomic : sendLegacy;
  const confirmSend = USE_ATOMIC_ENCRYPT_WRITE
    ? confirmSendAtomic
    : confirmSendLegacy;

  const reset = useCallback(() => {
    setState(initialState);
    setEncryptedAmount(null);
  }, []);

  const goBack = useCallback(() => {
    if (state.step === "encrypting" || state.step === "sending") return;
    setState((s) => {
      if (s.step === "confirming") return { ...s, step: "input" };
      if (s.step === "error") return { ...s, step: "input", error: null };
      return s;
    });
  }, [state.step]);

  return {
    ...state,
    isEncrypting: USE_ATOMIC_ENCRYPT_WRITE
      ? atomicEncryption.isEncrypting
      : isEncrypting,
    isSending: USE_ATOMIC_ENCRYPT_WRITE
      ? atomicWrite.isPending
      : false,
    cofheConnected,
    amountWarning,
    setRecipient,
    setAmount,
    setNote,
    setToken,
    canProceed,
    send,
    confirmSend,
    reset,
    goBack,
  };
}
