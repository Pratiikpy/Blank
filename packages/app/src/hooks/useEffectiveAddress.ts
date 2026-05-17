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

  // When effectiveAddress is null, callers (guardReady patterns) want
  // a humanized reason for their toast. Passkey-only users mid-load
  // would otherwise see "Wallet not connected" — wrong; their wallet IS
  // connected, the AA is just resolving. Split the message so the user
  // knows the next action is "wait" vs "connect." "no-passkey" is the
  // only state where the user genuinely needs to take action; every
  // other non-"ready" state is a transient resolver/UserOp lifecycle
  // step that will settle on its own.
  const notReadyReason: string | null = effectiveAddress
    ? null
    : smartAccount.status === "no-passkey"
      ? "Wallet not connected"
      : "Smart wallet loading — try again in a moment";

  return {
    effectiveAddress,
    eoa,
    smartAccount,
    isSmartAccount,
    notReadyReason,
  };
}
