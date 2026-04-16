/**
 * Extract an indexed event parameter from transaction receipt logs.
 * Searches for the first log from the target contract and reads topics[1].
 */
export function extractEventId(
  logs: readonly { address: string; topics: readonly string[] }[],
  contractAddress: string
): number {
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
  return 0; // fallback
}
