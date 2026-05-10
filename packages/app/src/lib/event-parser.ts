/**
 * Extract an indexed event parameter from transaction receipt logs.
 * Searches for the first log from the target contract and reads topics[1].
 *
 * Returns null when no matching log was found. Callers MUST handle null;
 * a previous version returned 0 on miss, which silently routed share-links
 * at id=0 (someone else's "first" record). §1.7 of BEST_VERSION_FULL_PLAN
 * fixed this to fail explicitly.
 */
export function extractEventId(
  logs: readonly { address: string; topics: readonly string[] }[],
  contractAddress: string
): number | null {
  for (const log of logs) {
    if (
      log.address.toLowerCase() === contractAddress.toLowerCase() &&
      log.topics.length >= 2 &&
      log.topics[1]
    ) {
      try {
        return Number(BigInt(log.topics[1]));
      } catch {
        continue;
      }
    }
  }
  return null;
}
