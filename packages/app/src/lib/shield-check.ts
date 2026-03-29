import toast from "react-hot-toast";

/**
 * Shows a helpful error when user tries to use encrypted features
 * without having shielded tokens first. Returns true if blocked.
 */
export function requireShieldedBalance(hasBalance: boolean | undefined): boolean {
  if (hasBalance === false || hasBalance === undefined) {
    toast.error("You need to shield USDC first. Go to Dashboard \u2192 Shield Tokens.", { duration: 5000 });
    return true; // blocked
  }
  return false; // ok to proceed
}
