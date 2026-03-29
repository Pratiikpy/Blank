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
import { FHERC20VaultAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Pending TX recovery key ────────────────────────────────────────
const PENDING_TX_KEY = "blank_pending_send";

// ─── Feature flag: atomic encrypt+write ─────────────────────────────
// When true, uses useCofheEncryptAndWriteContract from @cofhe/react
// to combine encryption and contract write into a single operation.
// This simplifies the step machine from 6 states to 4.
const USE_ATOMIC_ENCRYPT_WRITE = true;

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

export function useSendPayment() {
  const { address, isConnected } = useAccount();
  const { connected: cofheConnected } = useCofheConnection();
  const publicClient = usePublicClient();
  const [state, setState] = useState<SendPaymentState>(initialState);

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

      const vaultAddress = CONTRACTS.FHERC20Vault_USDC as `0x${string}`;
      const amountWei = parseUnits(state.amount, 6);

      if (amountWei === 0n) {
        toast.error("Amount must be greater than zero");
        setState((s) => ({ ...s, step: "input" }));
        return;
      }

      // No vault approval needed here: FHERC20Vault.transfer() moves from
      // msg.sender's own encrypted balance (not transferFrom). Approval is
      // only required when an intermediary contract (PaymentHub, GroupManager,
      // etc.) calls vault.transferFrom() on the user's behalf.

      // Atomic encrypt + write: the SDK hook handles:
      //   1. Extracting the encAmount field from args based on ABI internalType
      //      (our ABI annotates encAmount with internalType: "struct InEuint64")
      //   2. Encrypting it (ZK proof + ciphertext generation)
      //   3. Inserting the encrypted result back into args
      //   4. Calling walletClient.writeContract
      //
      // We pass the raw plaintext bigint for the encrypted param.
      // The SDK's extractEncryptableValues reads the ABI's internalType
      // to determine this is an InEuint64 and wraps it as Encryptable.uint64().
      const hash = await encryptAndWrite({
        params: {
          address: vaultAddress,
          abi: FHERC20VaultAbi,
          functionName: "transfer",
          chain: baseSepolia,
          account: address,
        },
        args: [
          state.recipient as `0x${string}`,
          amountWei,
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
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      toast.error(
        err instanceof Error ? err.message : "Transaction failed"
      );
    }
  }, [address, state.step, state.amount, state.recipient, state.note, encryptAndWrite, publicClient]);

  // ─── Legacy path: separate encrypt then write ──────────────────────
  // Kept as fallback when USE_ATOMIC_ENCRYPT_WRITE is false.
  // Steps: input -> encrypting -> confirming -> sending -> success

  const sendLegacy = useCallback(async () => {
    if (!canProceed || !address) return;

    try {
      setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

      const amountWei = parseUnits(state.amount, 6);

      // Encrypt using @cofhe/react
      const encrypted = await encryptInputsAsync([
        Encryptable.uint64(amountWei),
      ]);

      setEncryptedAmount(encrypted[0] as unknown as Record<string, unknown>);

      setState((s) => ({ ...s, step: "confirming", encryptionProgress: 100 }));
    } catch (err) {
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Encryption failed",
      }));
      toast.error("Encryption failed");
    }
  }, [canProceed, address, state.amount, encryptInputsAsync]);

  const confirmSendLegacy = useCallback(async () => {
    if (!encryptedAmount || !address) return;
    if (state.step === "sending") return; // Already submitting

    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return;
    }

    try {
      setState((s) => ({ ...s, step: "sending" }));

      const vaultAddress = CONTRACTS.FHERC20Vault_USDC as `0x${string}`;

      const hash = await writeContractAsync({
        address: vaultAddress,
        abi: FHERC20VaultAbi,
        functionName: "transfer",
        // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
        // whose shape doesn't match wagmi's strict ABI-inferred arg types
        args: [state.recipient as `0x${string}`, encryptedAmount as unknown as EncryptedInput],
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
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      toast.error("Transaction failed");
    }
  }, [encryptedAmount, address, state.step, state.recipient, writeContractAsync, publicClient]);

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
    setState((s) => {
      if (s.step === "confirming") return { ...s, step: "input" };
      if (s.step === "error") return { ...s, step: "input", error: null };
      return s;
    });
  }, []);

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
