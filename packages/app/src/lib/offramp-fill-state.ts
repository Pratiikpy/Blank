/** P2POfframp.FillState. Pending and Voided exist only on contracts with the funding gate. */
export const FILL_STATE = {
  Locked: 0,
  ProofSubmitted: 1,
  Released: 2,
  Disputed: 3,
  Resolved: 4,
  Refunded: 5,
  Pending: 6,
  Voided: 7,
} as const;

export const FILL_STATE_LABEL: Record<number, string> = {
  [FILL_STATE.Locked]: "Locked",
  [FILL_STATE.ProofSubmitted]: "Proof submitted",
  [FILL_STATE.Released]: "Released",
  [FILL_STATE.Disputed]: "Disputed",
  [FILL_STATE.Resolved]: "Resolved",
  [FILL_STATE.Refunded]: "Refunded",
  [FILL_STATE.Pending]: "Checking escrow",
  [FILL_STATE.Voided]: "Voided",
};
