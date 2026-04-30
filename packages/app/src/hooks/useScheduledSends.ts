// Phase 4.1 — useScheduledSends: surfaces the user's active session-key
// scopes + write helpers for create / revoke. Read path uses event log
// scanning (no on-chain enumeration), which works on a fresh device
// without server state.
//
// Write path: setScope is called BY THE AA (msg.sender), so the
// frontend wraps it in `BlankAccount.execute(validator, 0,
// abi.encodeCall(setScope, [...]))` and signs via passkey (legacy P-256
// path — still works post-Phase-4.1 upgrade).

import { useCallback, useEffect, useState } from "react";
import { type Address, encodeFunctionData, parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import {
  fetchActiveScopes,
  SessionKeyValidatorAbi,
  type ActiveScope,
} from "@/lib/scheduled-sends";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const BlankAccountExecAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

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
      const setScopeData = encodeFunctionData({
        abi: SessionKeyValidatorAbi,
        functionName: "setScope",
        args: [
          args.sessionKey,
          {
            recipient: args.recipient,
            spendToken: args.spendToken,
            maxAmountPerCall: amountBase,
            periodSeconds: args.periodSeconds,
            validUntil: args.validUntil,
            lastFiredAt: 0, // ignored on write — contract anchors at block.timestamp - period
          },
        ],
      });
      // Wrap in execute(validator, 0, setScopeData) so the AA itself is
      // msg.sender on the validator (account-associated storage rule).
      await unifiedWrite({
        address: effectiveAddress as `0x${string}`,
        abi: BlankAccountExecAbi,
        functionName: "execute",
        args: [validatorAddr, 0n, setScopeData],
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
      const revokeData = encodeFunctionData({
        abi: SessionKeyValidatorAbi,
        functionName: "revokeScope",
        args: [sessionKey],
      });
      await unifiedWrite({
        address: effectiveAddress as `0x${string}`,
        abi: BlankAccountExecAbi,
        functionName: "execute",
        args: [validatorAddr, 0n, revokeData],
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
