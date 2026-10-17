// Escrow rules shared by BusinessHub and EncryptedEscrow, mirrored from the
// contracts so the UI rejects a guaranteed revert before any wallet prompt.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Mirrors BusinessHub.ESCROW_DISPUTE_TIMEOUT and EncryptedEscrow.DISPUTE_TIMEOUT. */
export const ESCROW_DISPUTE_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;

/**
 * An arbiter is optional, but when set it must be a third party: a
 * depositor or beneficiary acting as arbiter could decide its own dispute.
 * Returns the user-facing error, or null when the arbiter is acceptable.
 */
export function escrowArbiterError(
  arbiter: string | null | undefined,
  depositor: string,
  beneficiary: string,
): string | null {
  const a = (arbiter ?? "").trim().toLowerCase();
  if (!a || a === ZERO_ADDRESS) return null;
  if (a === depositor.toLowerCase()) return "The arbiter cannot be you. Pick a third party or leave it empty.";
  if (a === beneficiary.trim().toLowerCase()) {
    return "The arbiter cannot be the beneficiary. Pick a third party or leave it empty.";
  }
  return null;
}

/** True when the escrow names an arbiter, so a dispute can be opened. */
export function hasArbiter(arbiter: string | null | undefined): boolean {
  const a = (arbiter ?? "").trim().toLowerCase();
  return a !== "" && a !== ZERO_ADDRESS;
}

/**
 * Unix seconds when an undecided dispute may be unwound. Disputes opened
 * before the contracts recorded the time (disputedAt 0) count from the
 * escrow deadline.
 */
export function disputeTimeoutAt(disputedAt: number, deadlineSeconds: number): number {
  const start = disputedAt > 0 ? disputedAt : deadlineSeconds;
  return start + ESCROW_DISPUTE_TIMEOUT_SECONDS;
}
