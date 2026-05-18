// Central mapper from raw wagmi/viem/cofhe error strings to short, user-
// readable copy. Hooks and UIs should normalize errors through `mapError`
// before surfacing them in toasts or error cards — the raw messages leak
// implementation detail ("execution reverted: InsufficientBalance()",
// "user rejected the request", "429 Too Many Requests") that confuses
// non-technical users.

import toast from "react-hot-toast";

export interface MappedError {
  /** Short heading suitable for a toast title or card header. */
  title: string;
  /** One-sentence body — explains *what to do*, not what happened. */
  body: string;
  /** `true` when the user cancelled; callers should usually suppress toasts. */
  userCancelled: boolean;
}

const DEFAULT: MappedError = {
  title: "Transaction failed",
  body: "Something went wrong. Please try again.",
  userCancelled: false,
};

const PATTERNS: Array<{ test: RegExp; map: MappedError }> = [
  {
    test: /user (?:rejected|denied|declined)|rejected the request/i,
    map: {
      title: "Cancelled",
      body: "You dismissed the wallet prompt.",
      userCancelled: true,
    },
  },
  {
    test: /insufficient (?:funds|balance)/i,
    map: {
      title: "Insufficient funds",
      body: "Your balance is too low to cover this amount plus gas.",
      userCancelled: false,
    },
  },
  {
    // Match allowance/approval-specific errors only. The original
    // pattern included `/erc20/i` which incorrectly captured any
    // ERC20-family error (Paused, InvalidReceiver, Frozen, etc.) +
    // mislabeled them as "Approval needed". Now we only match the
    // canonical allowance shapes: ERC20InsufficientAllowance,
    // "transfer amount exceeds allowance", explicit "allowance" or
    // "approve…amount" mentions, and the common shorthand.
    test: /allowance|approve.*amount|insufficient.*allowance|ERC20InsufficientAllowance/i,
    map: {
      title: "Approval needed",
      body: "The vault approval expired or changed. Please try again.",
      userCancelled: false,
    },
  },
  {
    test: /gas (?:price|required|estimation) (?:too low|exceeds|failed)/i,
    map: {
      title: "Gas estimation failed",
      body: "Network may be congested. Retry in a moment.",
      userCancelled: false,
    },
  },
  {
    test: /nonce|replacement transaction underpriced/i,
    map: {
      title: "Transaction stuck",
      body: "A previous transaction is still pending. Wait for it to confirm, then retry.",
      userCancelled: false,
    },
  },
  {
    test: /429|too many requests|rate limit/i,
    map: {
      title: "Rate limited",
      body: "The network is rate-limiting your wallet. Retry in a few seconds.",
      userCancelled: false,
    },
  },
  {
    test: /network.*(?:error|unreachable)|fetch failed|ECONNREFUSED|ENOTFOUND/i,
    map: {
      title: "Network error",
      body: "Couldn't reach the RPC. Check your connection and retry.",
      userCancelled: false,
    },
  },
  {
    test: /transaction reverted|execution reverted/i,
    map: {
      title: "Transaction reverted",
      body: "The contract rejected the transaction. Retry or contact support if it persists.",
      userCancelled: false,
    },
  },
  {
    test: /timeout|timed out/i,
    map: {
      title: "Timeout",
      body: "The operation took too long. The transaction may still confirm; check the explorer.",
      userCancelled: false,
    },
  },
];

/** Shortcut: run an unknown error through `mapError` and surface it via
 *  react-hot-toast with sensible defaults. Suppresses the toast when the
 *  user cancelled their own wallet prompt (a `toast.error` for that case
 *  reads as the app yelling at the user for not clicking confirm). Pass
 *  a `toastId` to replace a previously-shown loading/success toast.
 *
 *  Replaces the ad-hoc `toast.error(err instanceof Error ? err.message :
 *  "Foo failed")` pattern that was sprinkled across ~20 screens — that
 *  shape leaked 500-char viem traces to end users instead of the
 *  humanized copy already defined in PATTERNS. */
export function toastMappedError(err: unknown, toastId?: string): void {
  const mapped = mapError(err);
  if (mapped.userCancelled) {
    if (toastId) toast.dismiss(toastId);
    return;
  }
  toast.error(`${mapped.title}: ${mapped.body}`, toastId ? { id: toastId } : undefined);
}

/** Normalize any thrown error (or string) into user-readable copy. */
export function mapError(err: unknown): MappedError {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return DEFAULT;
  for (const { test, map } of PATTERNS) {
    if (test.test(raw)) return map;
  }
  // Unknown — surface the first 120 chars so power users can self-diagnose,
  // but keep the title generic.
  return {
    title: "Transaction failed",
    body: raw.length > 120 ? raw.slice(0, 117) + "…" : raw,
    userCancelled: false,
  };
}
