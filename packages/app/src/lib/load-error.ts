// Shared error classifier for public deep-link pages (ClaimLinkPage,
// StorefrontPage, CrowdfundPage). The audit (§F1) found that all three
// rendered raw RPC errors like "HTTPProviderError: 429 Too Many
// Requests" as full-page headlines. That makes the demo look broken
// when the actual issue is free-tier RPC throttling that retry would
// resolve in one second.
//
// Split the error into "transient" (retry CTA) vs "permanent" (no
// retry, go home) so the UI can offer the right next action. Returns
// a structured object so the screen can render an icon + headline +
// hint + retry button without re-parsing the message.

export type LoadErrorKind = "transient" | "permanent";

export interface ClassifiedLoadError {
  kind: LoadErrorKind;
  headline: string;
  hint: string;
  /** Best-effort raw cause for debugging. Never shown as the main
   *  message; rendered as a collapsed details element. */
  rawCause: string;
}

const TRANSIENT_PATTERNS = [
  /429/, // Rate limit
  /rate.?limit/i,
  /too many requests/i,
  /timeout/i,
  /timed.?out/i,
  /econn/i, // ECONNRESET, ECONNREFUSED
  /etimedout/i,
  /network error/i,
  /failed to fetch/i,
  /load failed/i,
  /5\d\d/, // 500-599 server errors
  /service unavailable/i,
  /gateway/i,
  /unavailable/i,
];

const PERMANENT_PATTERNS = [
  /not found/i,
  /does not exist/i,
  /reverted/i,
  /reverted with reason/i,
  /execution reverted/i,
  /invalid (chain|link|listing|campaign|address)/i,
  /unsupported chain/i,
];

/**
 * Classify an error caught during an on-chain read. The order matters:
 * permanent patterns take precedence over transient ones because some
 * revert strings happen to mention "timeout" (e.g. "auction not yet
 * timed out") which would otherwise be classified as transient.
 */
export function classifyLoadError(
  err: unknown,
  context: { resourceName: string; chainName?: string },
): ClassifiedLoadError {
  const rawMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");

  // Permanent first (more specific).
  for (const p of PERMANENT_PATTERNS) {
    if (p.test(rawMsg)) {
      return {
        kind: "permanent",
        headline: `${context.resourceName} not found`,
        hint: context.chainName
          ? `This ${context.resourceName.toLowerCase()} doesn't exist on ${context.chainName}. Check the link or switch chains.`
          : `This ${context.resourceName.toLowerCase()} doesn't exist. Check the link.`,
        rawCause: rawMsg,
      };
    }
  }

  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(rawMsg)) {
      return {
        kind: "transient",
        headline: "Network busy",
        hint: context.chainName
          ? `We couldn't reach ${context.chainName} right now. The public RPC may be rate-limiting. Try again in a moment.`
          : "We couldn't reach the chain right now. Try again in a moment.",
        rawCause: rawMsg,
      };
    }
  }

  // Unclassified errors are treated as transient by default. A retry
  // costs the user nothing and gives them a path forward; routing
  // every unknown error to "not found" would block legitimate
  // recovery from infrastructure issues.
  return {
    kind: "transient",
    headline: "Couldn't load",
    hint: "Something went wrong reading this from chain. Try again.",
    rawCause: rawMsg,
  };
}
