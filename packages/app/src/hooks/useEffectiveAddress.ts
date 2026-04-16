import { useAccount } from "wagmi";
import { useSmartAccount } from "./useSmartAccount";

/**
 * Single source of truth for "which address is the user effectively acting
 * as right now." Every hook that reads balance, writes activities, filters
 * subscriptions, or caches data by address should use this — NOT raw
 * `useAccount().address`.
 *
 * When a smart wallet (AA) is active and ready, this returns the smart
 * account's counterfactual address. Otherwise it falls back to the EOA.
 *
 * Returns `{ effectiveAddress, eoa, smartAccount, isSmartAccount }` so
 * callers that genuinely need the EOA (e.g. to look up EOA-only ETH
 * balance) can still get it explicitly.
 *
 * Rule of thumb: if you're about to destructure `useAccount().address` in
 * a hook, replace it with `useEffectiveAddress().effectiveAddress`.
 */
export function useEffectiveAddress() {
  const { address: eoa } = useAccount();
  const smartAccount = useSmartAccount();

  const isSmartAccount =
    smartAccount.status === "ready" && !!smartAccount.account;

  const effectiveAddress = (
    isSmartAccount
      ? (smartAccount.account!.address as `0x${string}`)
      : eoa
  ) as `0x${string}` | undefined;

  return {
    effectiveAddress,
    eoa,
    smartAccount,
    isSmartAccount,
  };
}
