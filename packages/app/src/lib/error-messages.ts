// Central mapper from raw wagmi/viem/cofhe error strings to short, user-
// readable copy. Hooks and UIs should normalize errors through `mapError`
// before surfacing them in toasts or error cards — the raw messages leak
// implementation detail ("execution reverted: InsufficientBalance()",
// "user rejected the request", "429 Too Many Requests") that confuses
// non-technical users.

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
  body: "Something went wrong — please try again.",
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
    test: /allowance|approve.*amount|erc20/i,
    map: {
      title: "Approval needed",
      body: "The vault approval expired or changed — please try again.",
      userCancelled: false,
    },
  },
  {
    test: /gas (?:price|required|estimation) (?:too low|exceeds|failed)/i,
    map: {
      title: "Gas estimation failed",
      body: "Network may be congested — retry in a moment.",
      userCancelled: false,
    },
  },
  {
    test: /nonce|replacement transaction underpriced/i,
    map: {
      title: "Transaction stuck",
      body: "A previous transaction is still pending — wait for it to confirm, then retry.",
      userCancelled: false,
    },
  },
  {
    test: /429|too many requests|rate limit/i,
    map: {
      title: "Rate limited",
      body: "The network is rate-limiting your wallet — retry in a few seconds.",
      userCancelled: false,
    },
  },
  {
    test: /network.*(?:error|unreachable)|fetch failed|ECONNREFUSED|ENOTFOUND/i,
    map: {
      title: "Network error",
      body: "Couldn't reach the RPC — check your connection and retry.",
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
      body: "The operation took too long. The transaction may still confirm — check explorer.",
      userCancelled: false,
    },
  },
];

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
