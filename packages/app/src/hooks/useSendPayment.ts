import { useState, useCallback, useEffect, useRef } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { sepolia } from "viem/chains";
import {
  useCofheEncrypt,
  useCofheConnection,
  useCofheEncryptAndWriteContract,
} from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { useChain } from "@/providers/ChainProvider";
import { FHERC20VaultAbi, PaymentHubAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { STORAGE_KEYS, getStoredJson, setStoredJson, removeStored } from "@/lib/storage";
import { mapError } from "@/lib/error-messages";

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
  const { isConnected } = useAccount();
  const { effectiveAddress: address, isSmartAccount } = useEffectiveAddress();
  const { connected: cofheConnected } = useCofheConnection();
  const { activeChainId, contracts } = useChain();
  // Pass `chainId` so passkey-only users (no EOA → no wagmi-connected chain)
  // get a working publicClient. Same fix pattern as useShield/useSmartAccount.
  const publicClient = usePublicClient({ chainId: activeChainId });
  // R5-C: the canProceed gate previously required wagmi `isConnected`,
  // which is false for passkey-only users. Treat passkey users as
  // "connected" too — they have an effective address and can submit
  // UserOps via the relayer.
  const isAuthenticated = isConnected || isSmartAccount;
  const [state, _setLocalState] = useState<SendPaymentState>(() => _sharedState);
  // #272: synchronous latch — set before any state update so a double-click
  // in the same React batch can't fire two writeContract calls. Cleared in
  // the finally block of each confirm path.
  const submittingRef = useRef(false);

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
    if (!address) return;
    const key = STORAGE_KEYS.pendingSend(address, activeChainId);
    const data = getStoredJson<{ timestamp: number; amount: string; token: string; hash: string } | null>(
      key,
      null,
    );
    if (data) {
      // Only show if less than 10 minutes old
      if (Date.now() - data.timestamp < 600_000) {
        toast(`You have a pending send of ${data.amount} ${data.token}. Check explorer: ${data.hash}`, {
          duration: 10000,
        });
      }
      removeStored(key);
    }
  }, [address, activeChainId]);

  // ─── Amount warning for large transfers (#90) ─────────────────────
  const amountWarning = parseFloat(state.amount) > 100000
    ? "Large amount -- verify sufficient balance"
    : undefined;

  // ─── Legacy hooks (fallback path) ──────────────────────────────────
  const { encryptInputsAsync, isEncrypting } = useCofheEncrypt();
  const { unifiedWrite } = useUnifiedWrite();

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

  // cofheConnected removed from gate — encryption happens on confirm, not proceed
  const canProceed =
    isAuthenticated &&
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

  // #239: pulled the body out so we can self-call once on allowance errors
  // (clear stale cache + re-approve + retry). Without this, the user has to
  // hit "send" again manually after every cross-device or stale-cache miss.
  const _runConfirmSendAtomic = useCallback(async (isRetry: boolean): Promise<void> => {
    if (!address) return;
    // #272: synchronous latch check PRECEDES the state check — state flips
    // are async (React batching), but the ref is always current.
    if (submittingRef.current && !isRetry) return;
    if (state.step === "sending" && !isRetry) return; // Already submitting

    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return;
    }

    submittingRef.current = true;
    try {
      setState((s) => ({ ...s, step: "sending", encryptionProgress: 0 }));

      if (!state.amount || state.amount.trim() === "") {
        toast.error("Enter an amount");
        setState((s) => ({ ...s, step: "input" }));
        return;
      }

      const vaultAddress = contracts.FHERC20Vault_USDC as `0x${string}`;
      const amountWei = parseUnits(state.amount, 6);

      if (amountWei === 0n || parseFloat(state.amount) < 0.01) {
        toast.error("Minimum amount is $0.01");
        setState((s) => ({ ...s, step: "input" }));
        return;
      }

      // Approve PaymentHub as a spender on the vault (lazy, cached for 24h)
      if (!isVaultApproved(contracts.PaymentHub)) {
        setState((s) => ({ ...s, step: "encrypting" })); // Show approving state
        const approveHash = await unifiedWrite({
          address: contracts.FHERC20Vault_USDC,
          abi: FHERC20VaultAbi,
          functionName: "approvePlaintext",
          args: [contracts.PaymentHub, BigInt("0xFFFFFFFFFFFFFFFF")], // MAX_UINT64
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        markVaultApproved(contracts.PaymentHub);
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
          address: contracts.PaymentHub,
          abi: PaymentHubAbi,
          functionName: "sendPayment",
          chain: sepolia,
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
      const pendingSendKey = STORAGE_KEYS.pendingSend(address, activeChainId);
      setStoredJson(pendingSendKey, {
        hash,
        recipient: state.recipient,
        amount: state.amount,
        token: state.token,
        timestamp: Date.now(),
      });

      // Wait for on-chain confirmation before writing to Supabase
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // Clear pending tx on success
      removeStored(pendingSendKey);

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
        activity_type: ACTIVITY_TYPES.PAYMENT,
        contract_address: vaultAddress,
        note: state.note,
        token_address: contracts.TestUSDC,
        // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
        block_number: Number(receipt.blockNumber),
      });

      toast.success("Payment sent!");
    } catch (err) {
      // Clear cached approval on allowance/transfer errors so next attempt re-approves
      const msg = err instanceof Error ? err.message : String(err);
      const isAllowanceErr = /allowance|approve|insufficient|ERC20/i.test(msg);
      if (isAllowanceErr) {
        clearVaultApproval(contracts.PaymentHub);
        // #239: retry once with a freshly-cleared approval. Common cause:
        // user was approved on-chain but cache TTL flipped, OR a different
        // tab/device just consumed the allowance. Re-running the same flow
        // re-approves (because cache is now empty) and resubmits the send.
        // Guard with isRetry so a genuinely-broken approval can't loop.
        if (!isRetry) {
          submittingRef.current = false;
          return _runConfirmSendAtomic(true);
        }
      }
      // #277: map to friendly copy + suppress toast on wallet-cancellation
      const mapped = mapError(err);
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      if (!mapped.userCancelled) toast.error(mapped.title);
    } finally {
      submittingRef.current = false;
    }
  }, [address, state.step, state.amount, state.recipient, state.note, encryptAndWrite, unifiedWrite, publicClient, activeChainId, contracts]);

  const confirmSendAtomic = useCallback(
    () => _runConfirmSendAtomic(false),
    [_runConfirmSendAtomic],
  );

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
    if (!address) {
      // R5-D: smart-account address resolves asynchronously. If user
      // races the click before useSmartAccount finishes its first
      // resolveAccount, address is undefined here. Surface as a real
      // error instead of the silent return that hid this for hours.
      toast.error("Smart wallet not ready yet — please wait a moment and try again.");
      return;
    }
    // #272: synchronous latch — prevents double-submit during the React
    // batching window before `state.step` flips to "encrypting"/"sending".
    if (submittingRef.current) return;
    if (state.step === "sending" || state.step === "encrypting") return;

    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return;
    }

    submittingRef.current = true;
    try {
      if (!state.amount || state.amount.trim() === "") {
        toast.error("Enter an amount");
        return;
      }

      // Step 1: Encrypt
      setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

      const vaultAddress = contracts.FHERC20Vault_USDC as `0x${string}`;
      const amountWei = parseUnits(state.amount, 6);

      const encrypted = await encryptInputsAsync([
        Encryptable.uint64(amountWei),
      ]);
      console.log("[useSendPayment] post-encrypt OK len=", encrypted?.length);
      // Explicitly construct ABI tuple from SDK result (CipherPay pattern)
      const raw = encrypted[0] as any;
      const encAmount = {
        ctHash: BigInt(raw.ctHash ?? raw.data?.ctHash ?? 0),
        securityZone: Number(raw.securityZone ?? raw.data?.securityZone ?? 0),
        utype: Number(raw.utype ?? raw.data?.utype ?? 5),
        signature: (raw.signature ?? raw.data?.signature ?? "0x") as `0x${string}`,
      };
      console.log("[useSendPayment] encAmount built, ctHash hex len:", encAmount.ctHash.toString(16).length, "approved:", isVaultApproved(contracts.PaymentHub));

      // Step 2: Approve + Send
      setState((s) => ({ ...s, step: "sending", encryptionProgress: 100 }));
      console.log("[useSendPayment] step=sending. Branch:", isVaultApproved(contracts.PaymentHub) ? "send-only" : "approve+send");

      if (!isVaultApproved(contracts.PaymentHub)) {
        console.log("[useSendPayment] calling unifiedWrite for approvePlaintext... typeof:", typeof unifiedWrite, "fnName:", (unifiedWrite as { name?: string })?.name ?? "?");
        let approveHash: `0x${string}`;
        try {
          approveHash = await unifiedWrite({
            address: contracts.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [contracts.PaymentHub, BigInt("0xFFFFFFFFFFFFFFFF")],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
          });
        } catch (e) {
          console.error("[useSendPayment] unifiedWrite(approve) THREW:", String(e).slice(0, 800));
          throw e;
        }
        console.log("[useSendPayment] approve tx hash:", approveHash);
        await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        markVaultApproved(contracts.PaymentHub);
        console.log("[useSendPayment] approve confirmed, proceeding to sendPayment");
      }

      console.log("[useSendPayment] calling unifiedWrite for sendPayment...");
      const hash = await unifiedWrite({
        address: contracts.PaymentHub,
        abi: PaymentHubAbi,
        functionName: "sendPayment",
        args: [
          state.recipient as `0x${string}`,
          vaultAddress,
          encAmount,
          state.note || "",
        ],
        // FHE transactions can't be gas-estimated (precompile not available in simulation)
        // Set manual gas limit — FHE operations use ~2-5M gas
        gas: BigInt(5_000_000),
      });

      // Save pending tx for crash recovery (#71)
      const pendingSendKey = STORAGE_KEYS.pendingSend(address, activeChainId);
      setStoredJson(pendingSendKey, {
        hash,
        recipient: state.recipient,
        amount: state.amount,
        token: state.token,
        timestamp: Date.now(),
      });

      // Wait for on-chain confirmation before writing to Supabase
      const legacyReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (legacyReceipt.status === "reverted") {
        throw new Error("Transaction reverted on-chain");
      }

      // Clear pending tx on success
      removeStored(pendingSendKey);

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
        activity_type: ACTIVITY_TYPES.PAYMENT,
        contract_address: vaultAddress,
        note: state.note,
        token_address: contracts.TestUSDC,
        // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
        block_number: Number(legacyReceipt.blockNumber),
      });

      toast.success("Payment sent!");
    } catch (err) {
      // Clear cached approval on allowance/transfer errors so next attempt re-approves
      const msg = err instanceof Error ? err.message : String(err);
      if (/allowance|approve|insufficient|ERC20/i.test(msg)) {
        clearVaultApproval(contracts.PaymentHub);
      }
      // #277: surface friendly copy; suppress toast if user cancelled the prompt.
      const mapped = mapError(err);
      setState((s) => ({
        ...s,
        step: "error",
        error: err instanceof Error ? err.message : "Transaction failed",
      }));
      if (!mapped.userCancelled) toast.error(mapped.title);
    } finally {
      submittingRef.current = false;
    }
  }, [encryptedAmount, address, state.step, state.recipient, state.note, unifiedWrite, publicClient, activeChainId, contracts]);

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
