// Second step of every "funding gate" action (tip, purchase, escrow, gift,
// claim link, contribution, P2P fill).
//
// The FHE vault moves zero instead of reverting when a payer's balance is short,
// because revealing "balance too low" would leak the balance. So a contract
// cannot tell, in the same transaction, whether the money really moved. It
// publishes one public ebool ("funded") and waits for someone to decrypt it
// off-chain and submit the signed result. That someone is this helper, run
// right after the user's own transaction, so the user never sees a second step.

export type DecryptForTx = (
  ctHash: bigint,
  fheType?: "uint64" | "ebool" | "uint8",
) => Promise<{ decryptedValue: bigint | boolean; signature: `0x${string}` } | null>;

export interface FundingGateOptions {
  /** Reads the funded-bit handle. Return 0n (or throw) while the chain read has not caught up. */
  readHandle: () => Promise<bigint>;
  decryptForTx: DecryptForTx;
  /** Submits confirmFunding(...) with the decrypted bit and the Threshold Network signature. */
  confirm: (funded: boolean, signature: `0x${string}`) => Promise<void>;
  /** Total time to wait for the handle and the decryption. Default 90s. */
  timeoutMs?: number;
  pollMs?: number;
  /** Extra attempts for confirm(): public RPCs can serve a stale state right after a block. */
  confirmRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type FundingGateResult = { funded: boolean };

export class FundingGateTimeout extends Error {
  constructor(what: string) {
    super(`${what} is not ready yet. Your payment went through; it will finish on its own, or you can retry in a minute.`);
    this.name = "FundingGateTimeout";
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads the funded handle, decrypts it, submits confirmFunding.
 * Resolves with the on-chain verdict. Throws FundingGateTimeout when the handle or
 * the decryption never became available, and rethrows the last confirm() error
 * once its retries are used up.
 */
export async function runFundingGate(opts: FundingGateOptions): Promise<FundingGateResult> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3_000;
  const retries = opts.confirmRetries ?? 6;
  const startedAt = now();
  const left = () => timeoutMs - (now() - startedAt);

  let handle = 0n;
  while (left() > 0) {
    try {
      handle = await opts.readHandle();
    } catch {
      handle = 0n;
    }
    if (handle !== 0n) break;
    await sleep(pollMs);
  }
  if (handle === 0n) throw new FundingGateTimeout("The funding check");

  // A confirm can fail because a lagging RPC has not seen the handle yet, or because
  // the Threshold Network node that answered signed with a key the chain does not
  // accept (seen intermittently on Base Sepolia: InvalidSigner). Each attempt asks
  // for a fresh decryption, so a retry can land on a different signer.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const decryptEnd = attempt === 0 ? startedAt + timeoutMs : now() + pollMs * 10;
    let proof: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
    while (now() < decryptEnd) {
      proof = await opts.decryptForTx(handle, "ebool");
      if (proof) break;
      await sleep(pollMs);
    }
    if (!proof) {
      if (attempt === 0) throw new FundingGateTimeout("The funding check result");
      break;
    }
    const funded = typeof proof.decryptedValue === "boolean" ? proof.decryptedValue : proof.decryptedValue !== 0n;
    try {
      await opts.confirm(funded, proof.signature);
      return { funded };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(pollMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * True when `probe` resolves, false when the contract does not have the function
 * (an implementation that predates the funding gate). Hooks use it to keep working
 * against contracts that are not upgraded yet.
 */
export async function supportsFundingGate(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
