import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import { usePublicClient } from "wagmi";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useSubmissionGuard } from "@/hooks/useSubmissionGuard";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { insertActivity } from "./supabase";
import { broadcastAction } from "./cross-tab";
import { invalidateBalanceQueries } from "./query-invalidation";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "./approval";
import { MAX_UINT64, type EncryptedInput } from "./constants";
import { FHERC20VaultAbi } from "./abis";
import type { ActivityType } from "./activity-types";
import { useChain } from "@/providers/ChainProvider";

/**
 * Feature Kit — the ONE primitive every new hook should use.
 *
 * Problem this solves: 13 hooks each independently implemented
 *   submit-guard · state-machine · approval-flow · encrypt ·
 *   unified-write · receipt-wait · activity-insert · broadcast ·
 *   invalidate · error-to-user mapping · rate limiting
 *
 * Each reimplementation drifts. This kit bakes in the right pattern.
 *
 * Usage:
 *   const feature = useFeatureKit({
 *     activityType: ACTIVITY_TYPES.PAYMENT,
 *     approval: { vault: CONTRACTS.FHERC20Vault_USDC, spender: CONTRACTS.PaymentHub },
 *     rateLimit: { key: 'send', windowMs: 60_000, max: 10 },
 *   });
 *
 *   const onSubmit = () => feature.run(async ({ address, encrypt, write }) => {
 *     const [encAmount] = await encrypt([Encryptable.uint64(amountWei)]);
 *     const hash = await write({
 *       address: CONTRACTS.PaymentHub,
 *       abi: PaymentHubAbi,
 *       functionName: "sendPayment",
 *       args: [to, vault, encAmount as EncryptedInput, note],
 *       gas: BigInt(5_000_000),
 *     });
 *     return {
 *       hash,
 *       activity: {
 *         user_from: address, user_to: to,
 *         note, token_address: CONTRACTS.TestUSDC,
 *         contract_address: CONTRACTS.PaymentHub,
 *       },
 *     };
 *   });
 */

// ─── Types ────────────────────────────────────────────────────────────

export type FeatureStep =
  | "idle"
  | "approving"
  | "encrypting"
  | "sending"
  | "success"
  | "error";

export interface FeatureConfig {
  /** Activity type logged on successful run. Use a value from ACTIVITY_TYPES. */
  activityType: ActivityType;
  /** If set, kit will auto-approve the vault before the main write. */
  approval?: {
    vault: `0x${string}`;
    spender: `0x${string}`;
  };
  /** Optional rate limiter. Shared across callers via key (e.g., "gift", "faucet"). */
  rateLimit?: {
    key: string;
    windowMs: number;
    max: number;
  };
  /** Regex of error messages that should clear approval cache. Default: allowance-related. */
  approvalErrorRegex?: RegExp;
  /** Confirmations to wait after tx submission. Default 1; use 3 for reorg-sensitive flows. */
  confirmations?: number;
  /** Custom user-facing error message. Return null to use kit default. */
  classifyError?: (msg: string) => string | null;
}

export interface FeatureRunContext {
  /** User's effective address (AA if ready, EOA otherwise). */
  address: `0x${string}`;
  /** Typed wrapper around cofhe encryptInputs — call with Encryptable values. */
  encrypt: ReturnType<typeof useCofheEncrypt>["encryptInputsAsync"];
  /** unifiedWrite — branches between wagmi + AA transparently. */
  write: ReturnType<typeof useUnifiedWrite>["unifiedWrite"];
}

export interface FeatureRunResult {
  hash: `0x${string}`;
  /** Activity fields to log. Kit fills in tx_hash + block_number + activity_type. */
  activity?: Omit<Parameters<typeof insertActivity>[0], "tx_hash" | "activity_type" | "block_number"> & {
    activity_type?: undefined;
    tx_hash?: undefined;
    block_number?: undefined;
  };
  /** Also log a SECOND activity row (e.g. for the recipient) if set. */
  activityForRecipient?: Omit<Parameters<typeof insertActivity>[0], "tx_hash" | "activity_type" | "block_number"> & {
    activity_type?: undefined;
    tx_hash?: undefined;
    block_number?: undefined;
  };
}

export interface FeatureState {
  step: FeatureStep;
  error: string | null;
  txHash: `0x${string}` | null;
}

// ─── Rate limiter (localStorage-backed) ───────────────────────────────

function checkRateLimit(key: string, windowMs: number, max: number): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const now = Date.now();
    const raw = localStorage.getItem(`blank:rl:${key}`) ?? "[]";
    const recent: number[] = JSON.parse(raw).filter((t: number) => now - t < windowMs);
    if (recent.length >= max) {
      localStorage.setItem(`blank:rl:${key}`, JSON.stringify(recent));
      return false;
    }
    recent.push(now);
    localStorage.setItem(`blank:rl:${key}`, JSON.stringify(recent.slice(-max)));
    return true;
  } catch {
    return true; // fail-open if storage broken
  }
}

// ─── Error classifier ────────────────────────────────────────────────

const DEFAULT_APPROVAL_REGEX = /allowance|approve|insufficient|transfer amount exceeds/i;

function defaultClassifyError(msg: string): string {
  if (/user rejected|denied|rejected/i.test(msg)) return "Transaction rejected";
  if (/insufficient funds|out of gas/i.test(msg)) return "Not enough gas — fund your wallet";
  if (DEFAULT_APPROVAL_REGEX.test(msg)) return "Approval needed — please retry";
  if (/network|timeout|rpc/i.test(msg)) return "Network error — please retry";
  if (/reverted/i.test(msg)) return "Transaction reverted on-chain";
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useFeatureKit(config: FeatureConfig) {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId } = useChain();
  const publicClient = usePublicClient();
  const { unifiedWrite } = useUnifiedWrite();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { connected: cofheConnected } = useCofheConnection();
  const guard = useSubmissionGuard();

  const [state, setState] = useState<FeatureState>({
    step: "idle",
    error: null,
    txHash: null,
  });

  // Refs for latest values inside async closures.
  const addressRef = useRef(address);
  addressRef.current = address;

  const run = useCallback(
    async (
      fn: (ctx: FeatureRunContext) => Promise<FeatureRunResult>,
    ): Promise<`0x${string}` | null> => {
      const { result, guarded } = await guard(async () => {
        // Preflight checks
        const addr = addressRef.current;
        if (!addr) {
          toast.error("Connect your wallet first");
          return null;
        }
        if (!publicClient) {
          toast.error("Network not ready — please retry");
          return null;
        }
        if (!cofheConnected) {
          toast.error("FHE is still initializing — please retry in a moment");
          return null;
        }
        if (config.rateLimit && !checkRateLimit(
          config.rateLimit.key,
          config.rateLimit.windowMs,
          config.rateLimit.max,
        )) {
          toast.error("Too many requests — please try again later");
          return null;
        }

        setState({ step: "idle", error: null, txHash: null });

        try {
          // ─── Approval ─────────────────────────────────────────
          if (config.approval && !isVaultApproved(config.approval.spender)) {
            setState((s) => ({ ...s, step: "approving" }));
            const toastId = toast.loading("First time! Approving encrypted transfers...");
            try {
              const approvalHash = await unifiedWrite({
                address: config.approval.vault,
                abi: FHERC20VaultAbi,
                functionName: "approvePlaintext",
                args: [config.approval.spender, MAX_UINT64],
                gas: BigInt(5_000_000),
              });
              if (approvalHash) {
                const approvalReceipt = await publicClient.waitForTransactionReceipt({
                  hash: approvalHash,
                  confirmations: 1,
                });
                if (approvalReceipt.status === "reverted") {
                  throw new Error("Approval reverted on-chain");
                }
                markVaultApproved(config.approval.spender);
              }
              toast.success("Approval granted", { id: toastId });
            } catch (err) {
              toast.error("Approval failed", { id: toastId });
              throw err;
            }
          }

          // ─── Caller runs encrypt + write ──────────────────────
          setState((s) => ({ ...s, step: "encrypting" }));
          const outcome = await fn({
            address: addr as `0x${string}`,
            encrypt: encryptInputsAsync,
            write: async (args) => {
              setState((s) => ({ ...s, step: "sending" }));
              return unifiedWrite(args);
            },
          });

          // ─── Wait for receipt + check revert ──────────────────
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: outcome.hash,
            confirmations: config.confirmations ?? 1,
          });
          if (receipt.status === "reverted") {
            throw new Error("Transaction reverted on-chain");
          }

          // ─── Log activity (both directions if configured) ─────
          if (outcome.activity) {
            await insertActivity({
              ...outcome.activity,
              tx_hash: outcome.hash,
              activity_type: config.activityType,
              block_number: Number(receipt.blockNumber),
            } as Parameters<typeof insertActivity>[0]);
          }
          if (outcome.activityForRecipient) {
            await insertActivity({
              ...outcome.activityForRecipient,
              tx_hash: `${outcome.hash}:r`,
              activity_type: config.activityType,
              block_number: Number(receipt.blockNumber),
            } as Parameters<typeof insertActivity>[0]);
          }

          // ─── Cross-tab broadcast + query invalidation ─────────
          broadcastAction("balance_changed");
          broadcastAction("activity_added");
          invalidateBalanceQueries();

          setState({ step: "success", error: null, txHash: outcome.hash });
          return outcome.hash;
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const regex = config.approvalErrorRegex ?? DEFAULT_APPROVAL_REGEX;
          if (regex.test(raw) && config.approval) {
            clearVaultApproval(config.approval.spender);
          }
          const friendly =
            config.classifyError?.(raw) ?? defaultClassifyError(raw);
          setState({ step: "error", error: friendly, txHash: null });
          toast.error(friendly);
          return null;
        }
      });

      if (guarded) {
        toast("Already in flight — please wait", { icon: "\u23F3" });
        return null;
      }
      return result ?? null;
    },
    [guard, publicClient, cofheConnected, encryptInputsAsync, unifiedWrite, config],
  );

  const reset = useCallback(() => {
    setState({ step: "idle", error: null, txHash: null });
  }, []);

  return {
    state,
    run,
    reset,
    address,
    chainId: activeChainId,
  };
}

// Re-export convenience types for callers
export type { EncryptedInput };
