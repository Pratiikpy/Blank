import { useState, useCallback, useEffect, useRef } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import {
  useCofheEncrypt,
  useCofheConnection,
} from "@/lib/cofhe-shim";
import { Encryptable } from "@/lib/cofhe-shim";
import toast from "react-hot-toast";
import { log } from "@/lib/log";
import { useChain } from "@/providers/ChainProvider";
import { BusinessHubAbi, FHERC20VaultAbi, PaymentHubAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { insertActivity } from "@/lib/supabase";
import { insertActivitiesFanout } from "@/lib/activity-fanout";
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

/** Phase 8.2 — Send to many.
 *
 * Single mode keeps using `recipient` + `amount` as before so every existing
 * caller (incl. /pay, request-fulfilment, agent flows) continues to work
 * unchanged. Many mode adds:
 *
 *   recipients: string[]        — multi-select set, lower-cased addresses
 *   splitMode: "equal"|"custom" — equal divides `amount` evenly; custom
 *                                 uses `recipientAmounts` (parallel to
 *                                 `recipients`)
 *   recipientAmounts: string[]  — only consulted when splitMode === "custom"
 *
 * The contract uses `BusinessHub.runPayroll(employees, vault, salaries)` —
 * already shipped with MAX_PAYROLL_SIZE=30 — so no contract upgrade is
 * needed. Activity rows go in as ACTIVITY_TYPES.BATCH_PAYMENT (already
 * exists with formatter "X sent a batch payment").
 */
export type SendMode = "single" | "many";
export type SplitMode = "equal" | "custom";

/** Hard cap matching `BusinessHub.MAX_PAYROLL_SIZE`. The contract reverts
 *  above this; we surface it client-side for a friendlier UX. */
export const MAX_BATCH_RECIPIENTS = 30;

export interface SendPaymentState {
  step: SendStep;
  recipient: string;
  amount: string;
  note: string;
  token: string;
  txHash: string | null;
  error: string | null;
  encryptionProgress: number;
  // Phase 8.2 batch fields
  mode: SendMode;
  recipients: string[];
  splitMode: SplitMode;
  recipientAmounts: string[];
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
  mode: "single",
  recipients: [],
  splitMode: "equal",
  recipientAmounts: [],
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
  // §1.6 of BEST_VERSION_FULL_PLAN: removed useCofheEncryptAndWriteContract
  // (a stub that threw). Atomic encrypt+write now goes through unifiedWrite,
  // which accepts InEuint64 values directly. Atomic-state booleans below
  // were sourced from the stub and are now stubbed locally as false (the
  // USE_ATOMIC_ENCRYPT_WRITE flag is constant-false anyway).
  const atomicEncryption = { isEncrypting: false };
  const atomicWrite = { isPending: false };

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

  // Phase 8.2 — batch setters. Switching modes deliberately resets the
  // counterpart fields so we never carry stale single-mode state into a
  // batch send (or vice versa) after the user toggles.
  const setMode = useCallback((mode: SendMode) => {
    setState((s) =>
      mode === s.mode
        ? s
        : {
            ...s,
            mode,
            // wipe whichever side of the state model isn't relevant
            recipient: mode === "single" ? s.recipient : "",
            recipients: mode === "many" ? s.recipients : [],
            recipientAmounts: mode === "many" ? s.recipientAmounts : [],
          },
    );
  }, []);

  const setRecipients = useCallback((addrs: string[]) => {
    setState((s) => {
      const trimmed = addrs.slice(0, MAX_BATCH_RECIPIENTS);
      // Keep recipientAmounts parallel — pad with "" or trim to match.
      const nextAmounts =
        s.recipientAmounts.length === trimmed.length
          ? s.recipientAmounts
          : trimmed.map((_, i) => s.recipientAmounts[i] ?? "");
      return { ...s, recipients: trimmed, recipientAmounts: nextAmounts };
    });
  }, []);

  const setSplitMode = useCallback((splitMode: SplitMode) => {
    setState((s) => ({ ...s, splitMode }));
  }, []);

  const setRecipientAmount = useCallback((index: number, value: string) => {
    if (value !== "" && !/^\d*\.?\d{0,6}$/.test(value)) return;
    setState((s) => {
      if (index < 0 || index >= s.recipients.length) return s;
      const next = s.recipientAmounts.slice();
      next[index] = value;
      return { ...s, recipientAmounts: next };
    });
  }, []);

  // cofheConnected removed from gate — encryption happens on confirm, not proceed
  const canProceedSingle =
    state.recipient.length > 0 &&
    state.amount.length > 0 &&
    parseFloat(state.amount) > 0 &&
    state.recipient.toLowerCase() !== address?.toLowerCase();

  const canProceedMany = (() => {
    if (state.recipients.length === 0) return false;
    // Block self-sends in batch too
    if (address && state.recipients.some((r) => r.toLowerCase() === address.toLowerCase())) {
      return false;
    }
    if (state.splitMode === "equal") {
      return state.amount.length > 0 && parseFloat(state.amount) > 0;
    }
    // custom: every recipient must have a positive amount
    return (
      state.recipientAmounts.length === state.recipients.length &&
      state.recipientAmounts.every((a) => a.length > 0 && parseFloat(a) > 0)
    );
  })();

  const canProceed =
    isAuthenticated &&
    !!publicClient &&
    (state.mode === "single" ? canProceedSingle : canProceedMany);

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
      // §1.6 of BEST_VERSION_FULL_PLAN: migrated from encryptAndWrite stub
      // (which threw) to unifiedWrite. unifiedWrite handles InEuint64
      // encryption internally and routes through both EOA and AA paths.
      const hash = await unifiedWrite({
        address: contracts.PaymentHub,
        abi: PaymentHubAbi,
        functionName: "sendPayment",
        args: [
          state.recipient as `0x${string}`,
          vaultAddress,
          amountWei,
          state.note || "",
        ],
        // §3.19 of BEST_VERSION_FULL_PLAN: FHE-touching call needs explicit
        // gas (precompile can't be auto-estimated). The §1.6 migration from
        // the encryptAndWrite stub dropped this; restoring per audit iter 41.
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
  }, [address, state.step, state.amount, state.recipient, state.note, unifiedWrite, publicClient, activeChainId, contracts]);

  // Phase 7.D — the atomic path uses `encryptAndWrite` from `@cofhe/react`,
  // which lives outside our `unifiedWrite` abstraction and currently has no
  // self-pay hook. Until that integration lands, fail loudly when a caller
  // requests "self" on the atomic path so we never silently fall through to
  // sponsored (which would AA31-revert with no recoverable UX). SendConfirm
  // should keep falling back to the legacy path (USE_ATOMIC_ENCRYPT_WRITE
  // is false today anyway) when self-pay is required.
  const confirmSendAtomic = useCallback(
    (paymasterMode?: "sponsored" | "self") => {
      if (paymasterMode === "self") {
        const msg = "Self-pay is not yet supported on the atomic encrypt-and-write path. Toggle USE_ATOMIC_ENCRYPT_WRITE off to use the legacy path.";
        setState((s) => ({ ...s, step: "error", error: msg }));
        toast.error(msg);
        return;
      }
      return _runConfirmSendAtomic(false);
    },
    [_runConfirmSendAtomic],
  );

  // ─── Legacy path: separate encrypt then write ──────────────────────
  // Kept as fallback when USE_ATOMIC_ENCRYPT_WRITE is false.
  // Steps: input -> encrypting -> confirming -> sending -> success

  const sendLegacy = useCallback(async () => {
    if (!canProceed || !address) return;

    // Phase 8.2 — many mode keeps its amounts in `recipientAmounts` (custom)
    // or implies them via `amount × N` (equal). The `state.amount` checks
    // below only make sense for single mode and would falsely toast "Enter
    // an amount" in many+custom even though canProceedMany already passed.
    // confirmBatchSend re-validates per-recipient before encrypting, so we
    // don't re-do that work here either.
    if (state.mode === "single") {
      if (!state.amount || state.amount.trim() === "") {
        toast.error("Enter an amount");
        return;
      }
      if (parseFloat(state.amount) < 0.01) {
        toast.error("Minimum amount is $0.01");
        return;
      }
    }

    // Just set step to confirming — encryption happens on confirm
    setState((s) => ({ ...s, step: "confirming", encryptionProgress: 0 }));
  }, [canProceed, address, state.amount, state.mode]);

  const confirmSendLegacy = useCallback(async (paymasterMode?: "sponsored" | "self") => {
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
      log.debug("useSendPayment.encrypt.success", { length: encrypted?.length });
      // Explicitly construct ABI tuple from SDK result (CipherPay pattern)
      const raw = encrypted[0] as any;
      const encAmount = {
        ctHash: BigInt(raw.ctHash ?? raw.data?.ctHash ?? 0),
        securityZone: Number(raw.securityZone ?? raw.data?.securityZone ?? 0),
        utype: Number(raw.utype ?? raw.data?.utype ?? 5),
        signature: (raw.signature ?? raw.data?.signature ?? "0x") as `0x${string}`,
      };
      log.debug("useSendPayment.encAmount.built", { ctHashHexLen: encAmount.ctHash.toString(16).length, approved: isVaultApproved(contracts.PaymentHub) });

      // Step 2: Approve + Send
      setState((s) => ({ ...s, step: "sending", encryptionProgress: 100 }));
      log.debug("useSendPayment.step.sending", { branch: isVaultApproved(contracts.PaymentHub) ? "send-only" : "approve+send" });

      // Phase 7.D: when caller passes paymasterMode === "self", every
      // unifiedWrite below builds a UserOp with paymasterAndData = "0x" so
      // the AA pays its own gas via _payPrefund (BaseAccount inheritance).
      // SendConfirm.tsx resolves the mode based on usePaymasterHealth +
      // useBalance; we just forward whatever it picked.
      if (!isVaultApproved(contracts.PaymentHub)) {
        log.debug("useSendPayment.approve.calling", { unifiedWriteType: typeof unifiedWrite, fnName: (unifiedWrite as { name?: string })?.name ?? "?", paymasterMode: paymasterMode ?? "sponsored" });
        let approveHash: `0x${string}`;
        try {
          approveHash = await unifiedWrite({
            address: contracts.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [contracts.PaymentHub, BigInt("0xFFFFFFFFFFFFFFFF")],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
            paymaster: paymasterMode,
          });
        } catch (e) {
          log.error("useSendPayment.approve.threw", e instanceof Error ? e : new Error(String(e).slice(0, 800)));
          throw e;
        }
        log.debug("useSendPayment.approve.txHash", { hash: approveHash });
        await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        markVaultApproved(contracts.PaymentHub);
        log.debug("useSendPayment.approve.confirmed");
      }

      log.debug("useSendPayment.sendPayment.calling", { paymasterMode: paymasterMode ?? "sponsored" });
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
        paymaster: paymasterMode,
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

  // ─── Phase 8.2 — Batch send via BusinessHub.runPayroll ──────────────
  // Encrypts all per-recipient amounts in one parallel pass, then submits
  // a single tx that fans out N transferFromVerified calls server-side
  // (atomic — either every recipient gets paid or none do). Activity
  // rows fanned-out client-side post-confirmation, one per recipient,
  // so each one gets a real-time push notification.
  const confirmBatchSend = useCallback(
    async (paymasterMode?: "sponsored" | "self") => {
      if (!address) {
        toast.error("Smart wallet not ready yet — please wait a moment and try again.");
        return;
      }
      if (submittingRef.current) return;
      if (state.step === "sending" || state.step === "encrypting") return;
      if (state.mode !== "many") return;
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return;
      }

      // Resolve the per-recipient amount array up-front so the encryption
      // call has a stable input regardless of splitMode.
      const recipientList = state.recipients;
      const amounts =
        state.splitMode === "equal"
          ? recipientList.map(() => state.amount)
          : state.recipientAmounts;

      // Defensive client-side checks; the contract enforces the same caps
      // but a local error message reads better than an EVM revert.
      if (recipientList.length === 0) {
        toast.error("Pick at least one recipient");
        return;
      }
      if (recipientList.length > MAX_BATCH_RECIPIENTS) {
        toast.error(`Max ${MAX_BATCH_RECIPIENTS} recipients per batch`);
        return;
      }
      if (amounts.length !== recipientList.length) {
        toast.error("Recipient and amount counts disagree — re-enter amounts");
        return;
      }
      for (const a of amounts) {
        if (!a || a.trim() === "" || parseFloat(a) <= 0) {
          toast.error("Every recipient needs a positive amount");
          return;
        }
        if (parseFloat(a) < 0.01) {
          toast.error("Minimum per-recipient amount is $0.01");
          return;
        }
      }

      submittingRef.current = true;
      try {
        setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 0 }));

        const vaultAddress = contracts.FHERC20Vault_USDC as `0x${string}`;

        // BusinessHub needs vault approval (not PaymentHub). Cached for 24h
        // by `markVaultApproved` so subsequent batches skip this step.
        if (!isVaultApproved(contracts.BusinessHub)) {
          setState((s) => ({ ...s, step: "approving" }));
          const approveHash = await unifiedWrite({
            address: contracts.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [contracts.BusinessHub, BigInt("0xFFFFFFFFFFFFFFFF")],
            gas: BigInt(5_000_000),
            paymaster: paymasterMode,
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
          markVaultApproved(contracts.BusinessHub);
        }

        // Encrypt all salaries in parallel — same pattern useBusinessHub
        // uses for runPayroll. uint64 matches the InEuint64[] contract
        // parameter type.
        setState((s) => ({ ...s, step: "encrypting", encryptionProgress: 50 }));
        const encSalaries = await encryptInputsAsync(
          amounts.map((a) => Encryptable.uint64(parseUnits(a, 6))),
        );

        setState((s) => ({ ...s, step: "sending", encryptionProgress: 100 }));
        const hash = await unifiedWrite({
          address: contracts.BusinessHub as `0x${string}`,
          abi: BusinessHubAbi,
          functionName: "runPayroll",
          args: [
            recipientList as `0x${string}`[],
            vaultAddress,
            encSalaries as unknown as Record<string, unknown>[],
          ],
          gas: BigInt(5_000_000) + BigInt(800_000) * BigInt(recipientList.length),
          paymaster: paymasterMode,
        });

        const batchReceipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (batchReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setState((s) => ({ ...s, step: "success", txHash: hash }));

        // Fanout activity rows — one per recipient. Suffix tx_hash with the
        // recipient address so Supabase's tx_hash unique key still works.
        // Per-recipient amount lives encrypted on-chain; activity rows are
        // notification metadata only (matches the existing payroll fanout
        // pattern in useBusinessHub.ts).
        await insertActivitiesFanout(
          recipientList.map((recipient) => ({
            tx_hash: `${hash}_${recipient.toLowerCase()}`,
            user_from: address.toLowerCase(),
            user_to: recipient.toLowerCase(),
            activity_type: ACTIVITY_TYPES.BATCH_PAYMENT,
            contract_address: vaultAddress,
            note: state.note || `Batch from ${address.slice(0, 6)}…`,
            token_address: contracts.TestUSDC,
            block_number: Number(batchReceipt.blockNumber),
          })),
          { userToastOnFailure: true, context: "batch-send" },
        );

        toast.success(`Sent to ${recipientList.length} recipients`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/allowance|approve|insufficient|ERC20/i.test(msg)) {
          clearVaultApproval(contracts.BusinessHub);
        }
        const mapped = mapError(err);
        setState((s) => ({
          ...s,
          step: "error",
          error: err instanceof Error ? err.message : "Batch send failed",
        }));
        if (!mapped.userCancelled) toast.error(mapped.title);
      } finally {
        submittingRef.current = false;
      }
    },
    [
      address,
      state.step,
      state.mode,
      state.recipients,
      state.splitMode,
      state.amount,
      state.recipientAmounts,
      state.note,
      encryptInputsAsync,
      unifiedWrite,
      publicClient,
      activeChainId,
      contracts,
    ],
  );

  // ─── Route to correct implementation ───────────────────────────────

  const send = USE_ATOMIC_ENCRYPT_WRITE ? sendAtomic : sendLegacy;
  // Many-mode forces the legacy path — atomic encrypt+write encrypts a
  // single value at a time and doesn't fit the parallel batch pattern.
  const confirmSendSingle = USE_ATOMIC_ENCRYPT_WRITE
    ? confirmSendAtomic
    : confirmSendLegacy;
  const confirmSend = (paymasterMode?: "sponsored" | "self") =>
    state.mode === "many"
      ? confirmBatchSend(paymasterMode)
      : confirmSendSingle(paymasterMode);

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
    // Phase 8.2 batch
    setMode,
    setRecipients,
    setSplitMode,
    setRecipientAmount,
    canProceed,
    send,
    confirmSend,
    reset,
    goBack,
  };
}
