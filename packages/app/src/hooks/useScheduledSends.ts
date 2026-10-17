// Phase 4.1 — useScheduledSends: surfaces the user's active session-key
// scopes + write helpers for create / revoke. Read path uses event log
// scanning (no on-chain enumeration), which works on a fresh device
// without server state.
//
// Write path: setScope is called BY THE AA (msg.sender). unifiedWrite
// wraps the call in `BlankAccount.execute(validator, 0, data)` and signs
// via passkey.

import { useCallback, useEffect, useState } from "react";
import { type Address, parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import {
  fetchActiveScopes,
  SessionKeyValidatorAbi,
  buildSessionScope,
  type ActiveScope,
} from "@/lib/scheduled-sends";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

export interface CreateScopeArgs {
  /** The server-generated session key public address (returned from
   *  /api/scheduled-sends/create). */
  sessionKey: Address;
  /** Where the recurring transfer will land. */
  recipient: Address;
  /** ERC-20 token address. address(0) reserved for native ETH (not yet
   *  surfaced in the UI). */
  spendToken: Address;
  /** Per-call ceiling, in human units (e.g. "50" for $50 USDC). Encoded
   *  to base units inside the hook. */
  amount: string;
  /** Token decimals — typically 6 for USDC. */
  decimals: number;
  /** Min seconds between fires. EntryPoint enforces via validAfter. */
  periodSeconds: number;
  /** Hard expiry of the entire authorization, Unix seconds. */
  validUntil: number;
  /** Paymaster fires may name (BlankPaymaster). null/absent: account pays. */
  paymaster?: Address | null;
}

export interface UseScheduledSendsReturn {
  scopes: ActiveScope[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  createScope: (args: CreateScopeArgs, paymasterMode?: "sponsored" | "self") => Promise<void>;
  revokeScope: (sessionKey: Address, paymasterMode?: "sponsored" | "self") => Promise<void>;
}

export function useScheduledSends(): UseScheduledSendsReturn {
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite } = useUnifiedWrite();
  const validatorAddr = (contracts.SessionKeyValidator ?? ZERO_ADDR) as Address;

  const [scopes, setScopes] = useState<ActiveScope[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!publicClient || !effectiveAddress || validatorAddr === ZERO_ADDR) {
      setScopes([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const fetched = await fetchActiveScopes({
        publicClient,
        validatorAddress: validatorAddr,
        accountAddress: effectiveAddress as Address,
      });
      setScopes(fetched);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.slice(0, 280));
    } finally {
      setIsLoading(false);
    }
  }, [publicClient, effectiveAddress, validatorAddr]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const createScope = useCallback(
    async (args: CreateScopeArgs, paymasterMode?: "sponsored" | "self") => {
      if (!effectiveAddress) throw new Error("No smart account ready");
      if (validatorAddr === ZERO_ADDR) throw new Error("SessionKeyValidator not deployed");
      const amountBase = parseUnits(args.amount, args.decimals);
      // viem's `parseUnits` truncates excess decimals — `0.00000001` at
      // 6 decimals silently rounds to `0n`, which would write a useless
      // scope (every UserOp fails the maxAmountPerCall check). Reject
      // up-front with an honest error.
      if (amountBase === 0n) {
        const minHuman = (1 / Math.pow(10, args.decimals)).toString();
        throw new Error(
          `Amount below smallest unit — minimum is ${minHuman} (one ${"USDC".toLowerCase()} cent)`,
        );
      }
      // The validator's Scope struct caps amount at uint128. For USDC
      // (6 decimals) uint128 covers > 3.4e20 — plenty of headroom.
      if (amountBase > (1n << 128n) - 1n) {
        throw new Error("Amount exceeds uint128 cap");
      }
      // unifiedWrite wraps this in BlankAccount.execute(validator, 0, data),
      // so the account is msg.sender on the validator (account-associated
      // storage) and the op is sponsorable (the validator is an approved
      // paymaster target; a call into the account itself never is).
      await unifiedWrite({
        address: validatorAddr,
        abi: SessionKeyValidatorAbi,
        functionName: "setScope",
        args: [
          args.sessionKey,
          buildSessionScope({
            recipient: args.recipient,
            spendToken: args.spendToken,
            maxAmountPerCall: amountBase,
            periodSeconds: args.periodSeconds,
            validUntil: args.validUntil,
            paymaster: args.paymaster ?? null,
          }),
        ],
        gas: 250_000n,
        paymaster: paymasterMode,
      });
      await refetch();
    },
    [effectiveAddress, validatorAddr, unifiedWrite, refetch],
  );

  const revokeScope = useCallback(
    async (sessionKey: Address, paymasterMode?: "sponsored" | "self") => {
      if (!effectiveAddress) throw new Error("No smart account ready");
      if (validatorAddr === ZERO_ADDR) throw new Error("SessionKeyValidator not deployed");
      await unifiedWrite({
        address: validatorAddr,
        abi: SessionKeyValidatorAbi,
        functionName: "revokeScope",
        args: [sessionKey],
        gas: 150_000n,
        paymaster: paymasterMode,
      });
      await refetch();
    },
    [effectiveAddress, validatorAddr, unifiedWrite, refetch],
  );

  return {
    scopes,
    isLoading,
    error,
    refetch,
    createScope,
    revokeScope,
  };
}
