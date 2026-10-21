import { Contract, type Signer } from "ethers";
import { parseAbi } from "viem";

// Second step of every funding-gate action, for hardhat tasks and scripts.
//
// The FHE vault moves zero instead of reverting when a payer's balance is short,
// so a contract cannot tell in the creating transaction whether funds really
// moved. Escrow, claim link, gift, contribution, tip, P2P fill and storefront
// purchase therefore start Pending and publish one public ebool. Someone decrypts
// it off-chain and submits the signed result to confirmFunding, which flips the
// item to Active or Void. The app does this automatically after the user's own
// transaction (packages/app/src/lib/funding-gate.ts). Tasks that create an item
// and then act on it must do the same, or the follow-up call reverts with
// "funding pending".
//
// Contracts deployed before the upgrade have none of these functions. `supported`
// probes for them, so a task written with settleFunding keeps working against
// both generations: it returns { gated: false } on an old contract.

export type GateKind =
  | "escrow"
  | "claimLink"
  | "gift"
  | "contribution"
  | "refund"
  | "tip"
  | "fill"
  | "purchase";

interface GateSpec {
  /** Human-readable ABI fragments, valid for both ethers and viem. */
  abi: readonly string[];
  handleFn: string;
  confirmFn: string;
  statusFn: string;
  /** True while the item still waits for confirmFunding. */
  isPending: (status: any) => boolean;
}

const SPECS: Record<GateKind, GateSpec> = {
  escrow: {
    abi: [
      "function getFundingCheck(uint256 escrowId) view returns (bytes32)",
      "function confirmFunding(uint256 escrowId, bool funded, bytes signature)",
      "function getEscrow(uint256 escrowId) view returns (address depositor, address beneficiary, address arbiter, address vault, uint256 deadline, bool depositorApproved, bool beneficiaryMarkedDelivered, uint8 status, string description, uint256 createdAt)",
    ],
    handleFn: "getFundingCheck",
    confirmFn: "confirmFunding",
    statusFn: "getEscrow",
    // EscrowStatus.PendingFunding
    isPending: (r) => Number(r[7]) === 4,
  },
  claimLink: {
    abi: [
      "function getFundingCheck(uint256 linkId) view returns (bytes32)",
      "function confirmFunding(uint256 linkId, bool funded, bytes signature)",
      "function fundingStatus(uint256 linkId) view returns (uint8)",
    ],
    handleFn: "getFundingCheck",
    confirmFn: "confirmFunding",
    statusFn: "fundingStatus",
    // FundingStatus.PendingFunding
    isPending: (r) => Number(r) === 1,
  },
  gift: {
    abi: [
      "function getFundingCheck(uint256 envelopeId) view returns (bytes32)",
      "function confirmFunding(uint256 envelopeId, bool funded, bytes signature)",
      "function fundingStatus(uint256 envelopeId) view returns (uint8)",
    ],
    handleFn: "getFundingCheck",
    confirmFn: "confirmFunding",
    statusFn: "fundingStatus",
    isPending: (r) => Number(r) === 1,
  },
  contribution: {
    abi: [
      "function getContributionFundingCheck(uint256 campaignId, uint256 contributionIndex) view returns (bytes32)",
      "function confirmContribution(uint256 campaignId, uint256 contributionIndex, bool funded, bytes signature)",
      "function contributionState(uint256 campaignId, uint256 contributionIndex) view returns (uint8)",
    ],
    handleFn: "getContributionFundingCheck",
    confirmFn: "confirmContribution",
    statusFn: "contributionState",
    // ContributionState.PendingFunding
    isPending: (r) => Number(r) === 1,
  },
  refund: {
    abi: [
      "function getRefundCheck(uint256 campaignId, uint256 contributionIndex) view returns (bytes32)",
      "function confirmRefund(uint256 campaignId, uint256 contributionIndex, bool paidOut, bytes signature)",
      "function refundInFlight(uint256 campaignId, uint256 contributionIndex) view returns (bool)",
    ],
    handleFn: "getRefundCheck",
    confirmFn: "confirmRefund",
    statusFn: "refundInFlight",
    isPending: (r) => r === true,
  },
  tip: {
    abi: [
      "function getTipFundedHandle(uint256 tipId) view returns (bytes32)",
      "function confirmFunding(uint256 tipId, bool fundedPlaintext, bytes signature)",
      "function getTip(uint256 tipId) view returns (address supporter, address creator, address vault, uint8 status)",
    ],
    handleFn: "getTipFundedHandle",
    confirmFn: "confirmFunding",
    statusFn: "getTip",
    // TipStatus.Pending
    isPending: (r) => Number(r[3]) === 1,
  },
  fill: {
    abi: [
      "function fillFunded(uint64 fillId) view returns (bytes32)",
      "function confirmFunding(uint64 fillId, bool fundedPlaintext, bytes signature)",
      "function getFill(uint64 fillId) view returns (uint64 offerId, address taker, uint64 fiatAmountAtLockMicroUSD, uint32 lockedAt, uint32 proofSubmittedAt, bytes32 reclaimProofHash, uint8 state)",
    ],
    handleFn: "fillFunded",
    confirmFn: "confirmFunding",
    statusFn: "getFill",
    // FillState.Pending
    isPending: (r) => Number(r[6]) === 6,
  },
  purchase: {
    abi: [
      "function getPurchaseFundedHandle(uint256 purchaseId) view returns (bytes32)",
      "function confirmFunding(uint256 purchaseId, bool fundedPlaintext, bytes signature)",
      "function getPurchase(uint256 purchaseId) view returns (uint256 listingId, address buyer, uint8 kind, uint8 status)",
    ],
    handleFn: "getPurchaseFundedHandle",
    confirmFn: "confirmFunding",
    statusFn: "getPurchase",
    // PurchaseStatus.Pending
    isPending: (r) => Number(r[3]) === 1,
  },
};

/** Where the funded bit comes from, what it settles, how it is submitted. */
export interface FundingGateIO {
  /** False when the contract predates the funding gate (the view does not exist). */
  supported(): Promise<boolean>;
  /** The public ebool handle, or 0n while no node has the creating transaction yet. */
  readHandle(): Promise<bigint>;
  isPending(): Promise<boolean>;
  /** Dry-runs confirmFunding; throws until the Threshold Network result is accepted. */
  simulateConfirm(funded: boolean, signature: `0x${string}`): Promise<void>;
  /** Sends confirmFunding and resolves with the hash once it mined successfully. */
  sendConfirm(funded: boolean, signature: `0x${string}`): Promise<string>;
}

/** The slice of a connected @cofhe/sdk client the gate needs. */
export interface CofheDecryptClient {
  decryptForTx(ctHash: bigint | string): {
    withoutACP(): {
      execute(): Promise<{ decryptedValue: bigint; signature: `0x${string}` }>;
    };
  };
}

export interface SettleOptions {
  /** Time budget per phase (handle visibility, decryption, confirm simulation). Default 120s. */
  timeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  label?: string;
}

export type SettleOutcome =
  | { gated: false; reason: string }
  | {
      gated: true;
      /** The decrypted verdict. true: item is live. false: item is Void. */
      funded: boolean;
      /** Set when this call sent confirmFunding. Absent when the item was already settled. */
      confirmTx?: string;
      alreadySettled: boolean;
      waitedMs: number;
    };

export class FundingGateTimeout extends Error {
  constructor(what: string, detail?: string) {
    super(`funding gate: ${what} not ready in time${detail ? ` (last error: ${detail})` : ""}`);
    this.name = "FundingGateTimeout";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

/**
 * Decrypts the funded bit of a Pending item and submits confirmFunding.
 *
 * Public RPCs lag the coprocessor and each other, so every phase retries: the
 * handle may not be visible yet, the Threshold Network may not have the
 * ciphertext, and the confirm simulation reverts until the node serving it has
 * the handle. An item someone else already settled (the app confirms
 * automatically) is reported as alreadySettled, not as an error.
 */
export async function settleFunding(
  io: FundingGateIO,
  client: CofheDecryptClient,
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const log = opts.log ?? ((l: string) => console.log(l));
  const tag = opts.label ? `${opts.label}: ` : "";
  const t0 = Date.now();

  // One failed probe may be a flaky RPC rather than an old contract, so ask twice.
  let supported = await io.supported();
  if (!supported) {
    await sleep(pollMs);
    supported = await io.supported();
  }
  if (!supported) {
    return { gated: false, reason: "contract predates the funding gate" };
  }

  // Phase 1: the handle. Zero means the node has not seen the creating block,
  // or the item was created before the upgrade and never had a funded check.
  let handle = 0n;
  let phaseEnd = Date.now() + timeoutMs;
  while (Date.now() < phaseEnd) {
    try {
      handle = await io.readHandle();
    } catch {
      handle = 0n;
    }
    if (handle !== 0n) break;
    await sleep(pollMs);
  }
  if (handle === 0n) {
    if (!(await io.isPending().catch(() => false))) {
      return { gated: false, reason: "no funded check recorded for this item (created before the gate)" };
    }
    throw new FundingGateTimeout("funded handle");
  }

  // A settled item has nothing left to confirm. Re-read a few times so a node
  // that is one block behind does not make a fresh item look settled.
  let pending = await io.isPending();
  for (let i = 0; i < 3 && !pending; i++) {
    await sleep(pollMs);
    pending = await io.isPending();
  }

  // Phase 2: decrypt with global allowance (the bit is allowPublic).
  let verdict: { decryptedValue: bigint; signature: `0x${string}` } | null = null;
  let lastErr = "";
  phaseEnd = Date.now() + timeoutMs;
  while (Date.now() < phaseEnd) {
    try {
      verdict = await client.decryptForTx(handle).withoutACP().execute();
      break;
    } catch (e) {
      lastErr = errText(e);
      await sleep(pollMs);
    }
  }
  if (!verdict) throw new FundingGateTimeout("decryption", lastErr);
  const funded = verdict.decryptedValue !== 0n;

  if (!pending) {
    log(`  ${tag}already settled by another caller (decrypted funded=${funded})`);
    return { gated: true, funded, alreadySettled: true, waitedMs: Date.now() - t0 };
  }

  // Phase 3: simulate until the contract accepts the signature, then send.
  lastErr = "";
  let ready = false;
  phaseEnd = Date.now() + timeoutMs;
  while (Date.now() < phaseEnd) {
    if (!(await io.isPending().catch(() => true))) {
      log(`  ${tag}settled by another caller while waiting (decrypted funded=${funded})`);
      return { gated: true, funded, alreadySettled: true, waitedMs: Date.now() - t0 };
    }
    try {
      await io.simulateConfirm(funded, verdict.signature);
      ready = true;
      break;
    } catch (e) {
      lastErr = errText(e);
      await sleep(pollMs);
    }
  }
  if (!ready) throw new FundingGateTimeout("confirmFunding simulation", lastErr);

  const confirmTx = await io.sendConfirm(funded, verdict.signature);

  // The receipt is the source of truth. Poll the status only as a second check:
  // a lagging node can still report Pending right after the receipt.
  let cleared = false;
  for (let i = 0; i < 10 && !cleared; i++) {
    cleared = !(await io.isPending().catch(() => true));
    if (!cleared) await sleep(pollMs);
  }
  if (!cleared) log(`  ${tag}confirm mined (${confirmTx}) but the node still reports Pending`);

  const waitedMs = Date.now() - t0;
  log(`  ${tag}confirmFunding funded=${funded} tx=${confirmTx} (${(waitedMs / 1000).toFixed(1)}s)`);
  return { gated: true, funded, confirmTx, alreadySettled: false, waitedMs };
}

/** Same as settleFunding, but throws when the item ended Void (the payer was short). */
export async function settleFundingExpectFunded(
  io: FundingGateIO,
  client: CofheDecryptClient,
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  const out = await settleFunding(io, client, opts);
  if (out.gated && !out.funded) {
    throw new Error(`${opts.label ?? "item"} was voided by the funding gate (payer balance short, nothing locked)`);
  }
  return out;
}

// ─── viem adapter ───────────────────────────────────────────────────

export interface ViemGateContext {
  publicClient: {
    readContract(args: any): Promise<any>;
    simulateContract(args: any): Promise<any>;
    waitForTransactionReceipt(args: any): Promise<{ status: string }>;
  };
  /** Wallet that submits confirmFunding. Anyone may; the creator's wallet is fine. */
  walletClient: {
    account?: any;
    writeContract(args: any): Promise<`0x${string}`>;
  };
  address: `0x${string}`;
  gas?: bigint;
}

export function viemGateIO(kind: GateKind, ids: readonly bigint[], ctx: ViemGateContext): FundingGateIO {
  const spec = SPECS[kind];
  const abi = parseAbi(spec.abi as readonly string[]) as any;
  const read = (functionName: string) =>
    ctx.publicClient.readContract({ address: ctx.address, abi, functionName, args: ids as bigint[] });
  const confirmArgs = (funded: boolean, signature: `0x${string}`) => [...ids, funded, signature];
  return {
    async supported() {
      try {
        await read(spec.handleFn);
        return true;
      } catch {
        return false;
      }
    },
    async readHandle() {
      return BigInt((await read(spec.handleFn)) as string);
    },
    async isPending() {
      return spec.isPending(await read(spec.statusFn));
    },
    async simulateConfirm(funded, signature) {
      await ctx.publicClient.simulateContract({
        account: ctx.walletClient.account,
        address: ctx.address,
        abi,
        functionName: spec.confirmFn,
        args: confirmArgs(funded, signature),
        gas: ctx.gas ?? 5_000_000n,
      });
    },
    async sendConfirm(funded, signature) {
      const hash = await ctx.walletClient.writeContract({
        address: ctx.address,
        abi,
        functionName: spec.confirmFn,
        args: confirmArgs(funded, signature),
        gas: ctx.gas ?? 5_000_000n,
      });
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status === "reverted") throw new Error(`${spec.confirmFn} reverted on-chain: ${hash}`);
      return hash;
    },
  };
}

// ─── ethers adapter ─────────────────────────────────────────────────

export function ethersGateIO(
  kind: GateKind,
  ids: readonly bigint[],
  address: string,
  signer: Signer,
  gasLimit: bigint = 5_000_000n,
): FundingGateIO {
  const spec = SPECS[kind];
  const c = new Contract(address, spec.abi as string[], signer);
  const confirmArgs = (funded: boolean, signature: `0x${string}`) => [...ids, funded, signature];
  return {
    async supported() {
      try {
        await c.getFunction(spec.handleFn)(...ids);
        return true;
      } catch {
        return false;
      }
    },
    async readHandle() {
      return BigInt((await c.getFunction(spec.handleFn)(...ids)) as string);
    },
    async isPending() {
      return spec.isPending(await c.getFunction(spec.statusFn)(...ids));
    },
    async simulateConfirm(funded, signature) {
      await c.getFunction(spec.confirmFn).staticCall(...confirmArgs(funded, signature), { gasLimit });
    },
    async sendConfirm(funded, signature) {
      const tx = await c.getFunction(spec.confirmFn)(...confirmArgs(funded, signature), { gasLimit });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(`${spec.confirmFn} reverted on-chain: ${tx.hash}`);
      return tx.hash as string;
    },
  };
}

/** The contract views and functions a kind relies on, for tests that pin them to the compiled ABIs. */
export function gateSpec(kind: GateKind): { abi: readonly string[]; handleFn: string; confirmFn: string; statusFn: string } {
  const { abi, handleFn, confirmFn, statusFn } = SPECS[kind];
  return { abi, handleFn, confirmFn, statusFn };
}
