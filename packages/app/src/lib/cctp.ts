// Circle CCTP V2 — burn-and-mint USDC bridge between Ethereum Sepolia
// and Base Sepolia.
//
// Protocol overview:
//   1. Approve TokenMessengerV2 to spend USDC on the source chain.
//   2. Call TokenMessengerV2.depositForBurn(...) — emits MessageSent.
//   3. Poll Circle's Iris attestation API until status === "complete".
//   4. On the destination chain, call MessageTransmitterV2.receiveMessage(
//      message, attestation) to mint USDC to the recipient.
//
// V2 differs from V1 in three ways we care about:
//   • depositForBurn now takes 7 args (added destinationCaller, maxFee,
//     minFinalityThreshold). We always pass bytes32(0) for destinationCaller
//     so anyone can broadcast the receiveMessage on the destination side.
//   • minFinalityThreshold = 1000 → "Fast Transfer" (~15s, charges fee in
//     burnToken units), 2000 → "Finalized" (~15 min, no fee). We default
//     to FAST on testnet because the fee is symbolic and the 15s round-trip
//     makes the demo land cleanly in one session.
//   • Attestation API: /v2/messages/{sourceDomain}?transactionHash={hash}.
//     Returns an array of messages — usually one per tx — with a top-level
//     `attestation` field that is null until status becomes "complete".
//
// Source: Circle's own CCTP-V2 reference (see references/cctp-contracts).
// Addresses below verified 2026-04-26 against Circle's public docs.

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import {
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  ARB_SEPOLIA_ID,
  type SupportedChainId,
} from "./constants";

// ─── V2 deployment addresses ─────────────────────────────────────────
//
// Both contracts are at the SAME address on Ethereum Sepolia and Base
// Sepolia thanks to Circle's Create2-deterministic deployment. We still
// expose them per-chain for forward-compat (V2.1 might break that).

export const CCTP_TOKEN_MESSENGER_V2: Partial<Record<SupportedChainId, Address>> = {
  [ETH_SEPOLIA_ID]: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  [BASE_SEPOLIA_ID]: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  // Same Create2-deterministic address on Arb Sepolia (verified on-chain).
  [ARB_SEPOLIA_ID]: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
};

export const CCTP_MESSAGE_TRANSMITTER_V2: Partial<Record<SupportedChainId, Address>> = {
  [ETH_SEPOLIA_ID]: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  [BASE_SEPOLIA_ID]: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  // Same Create2-deterministic address on Arb Sepolia (verified on-chain).
  [ARB_SEPOLIA_ID]: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
};

/** Native USDC issued by Circle on each testnet — NOT the FHE-vault wrapper.
 *  CCTP only burns/mints native USDC; users must unshield first. */
export const CCTP_USDC: Partial<Record<SupportedChainId, Address>> = {
  [ETH_SEPOLIA_ID]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  [BASE_SEPOLIA_ID]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Circle native USDC on Arb Sepolia (verified on-chain).
  [ARB_SEPOLIA_ID]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};

/** Circle CCTP domain IDs. Distinct from EVM chain IDs. */
export const CCTP_DOMAIN: Partial<Record<SupportedChainId, number>> = {
  [ETH_SEPOLIA_ID]: 0,
  [BASE_SEPOLIA_ID]: 6,
  // Circle CCTP domain for Arbitrum Sepolia.
  [ARB_SEPOLIA_ID]: 3,
};

/** Finality thresholds, V2-specific. Values below 1000 default to 1000;
 *  values 1001-2000 default to 2000 (server-side, by Circle). */
export const CCTP_FINALITY = {
  /** ~15 seconds. Charges a fee in burnToken units. */
  FAST: 1000,
  /** ~15 minutes. Free. Source chain must reach hard finality. */
  FINALIZED: 2000,
} as const;

// ─── Minimal ABIs for the V2 calls we make ───────────────────────────

export const TokenMessengerV2Abi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export const MessageTransmitterV2Abi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  // Surface the MessageSent event so the burn-tx receipt can be parsed
  // for the message bytes that Iris hashes for attestation.
  {
    type: "event",
    name: "MessageSent",
    inputs: [{ name: "message", type: "bytes", indexed: false }],
    anonymous: false,
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Convert a 20-byte address into the bytes32 form expected by CCTP V2's
 *  `mintRecipient` and `destinationCaller` parameters. Addresses are
 *  right-padded with zeros at the lower bytes (left-padded in big-endian
 *  storage), matching `bytes32(uint256(uint160(addr)))` on the Solidity
 *  side. */
export function addressToBytes32(addr: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [addr]) as Hex;
}

/** keccak256 of the message bytes — the lookup key Iris uses for V1 and
 *  for backwards-compat in V2 responses. */
export function hashMessage(message: Hex): Hex {
  return keccak256(message);
}

// ─── Iris attestation polling ────────────────────────────────────────

const IRIS_TESTNET_BASE = "https://iris-api-sandbox.circle.com";

export interface AttestationResult {
  message: Hex;
  attestation: Hex;
}

interface IrisV2Message {
  message: string;
  attestation: string | null;
  status: "pending_confirmations" | "complete" | string;
  cctpVersion: number;
}

interface IrisV2Response {
  messages?: IrisV2Message[];
  error?: string;
}

export interface PollAttestationOptions {
  /** Source chain CCTP domain ID. */
  sourceDomain: number;
  /** Burn transaction hash on the source chain. */
  txHash: Hex;
  /** Polling interval in ms (default 4000). */
  pollIntervalMs?: number;
  /** Hard cap in ms before giving up (default 30 min — covers FINALIZED). */
  timeoutMs?: number;
  /** AbortSignal so the UI can cancel the poll on unmount. */
  signal?: AbortSignal;
  /** Called every poll with the latest status string. */
  onProgress?: (status: string) => void;
}

/**
 * Poll Iris until the burn message is attested. Resolves with `{ message,
 * attestation }` ready to feed into `receiveMessage`.
 *
 * Endpoint shape (V2):
 *   GET /v2/messages/{sourceDomainId}?transactionHash={txHash}
 *
 * Response shape (when complete):
 *   { messages: [{ message, attestation, status: "complete", cctpVersion: 2 }] }
 *
 * If multiple messages were emitted in one tx (rare, e.g. a hook+burn
 * combo), we pick the first one whose `cctpVersion === 2` and `status ===
 * "complete"`. Throws on AbortSignal abort.
 */
export async function pollAttestation(opts: PollAttestationOptions): Promise<AttestationResult> {
  const interval = opts.pollIntervalMs ?? 4000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
  const url = `${IRIS_TESTNET_BASE}/v2/messages/${opts.sourceDomain}?transactionHash=${opts.txHash}`;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new Error("Attestation poll aborted");
    }
    let res: Response;
    try {
      res = await fetch(url, { signal: opts.signal });
    } catch (err) {
      // Network blip — keep polling unless aborted.
      if (opts.signal?.aborted) throw err;
      await sleep(interval, opts.signal);
      continue;
    }

    if (res.status === 404) {
      // The burn tx hasn't propagated to Iris yet — usually within ~10-30s
      // of submission. Keep polling.
      opts.onProgress?.("propagating");
      await sleep(interval, opts.signal);
      continue;
    }

    let body: IrisV2Response;
    try {
      body = (await res.json()) as IrisV2Response;
    } catch {
      await sleep(interval, opts.signal);
      continue;
    }

    if (!res.ok || !body.messages || body.messages.length === 0) {
      opts.onProgress?.(body.error ?? `http-${res.status}`);
      await sleep(interval, opts.signal);
      continue;
    }

    const ready = body.messages.find(
      (m) => m.cctpVersion === 2 && m.status === "complete" && m.attestation,
    );
    if (ready && ready.attestation) {
      opts.onProgress?.("complete");
      return {
        message: ready.message as Hex,
        attestation: ready.attestation as Hex,
      };
    }

    // Not yet finalized — surface the latest status to the UI.
    const latest = body.messages[0];
    opts.onProgress?.(latest.status ?? "pending");
    await sleep(interval, opts.signal);
  }
  throw new Error("Attestation timed out");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

// ─── Bridge plan helpers (UI-facing) ─────────────────────────────────

export interface BridgeQuote {
  /** USDC units (6 decimals) being burned on the source chain. */
  amountUnits: bigint;
  /** Bytes32-encoded recipient on the destination chain. */
  mintRecipient32: Hex;
  /** Empty bytes32 — anyone can broadcast the receive on dest. */
  destinationCaller32: Hex;
  /** Max fee in burnToken units. Used only for FAST transfers. */
  maxFee: bigint;
  /** Either CCTP_FINALITY.FAST or CCTP_FINALITY.FINALIZED. */
  minFinalityThreshold: number;
  /** Source TokenMessengerV2 to approve + call. */
  sourceTokenMessenger: Address;
  /** Source USDC contract that gets approved + burned. */
  sourceUsdc: Address;
  /** Destination MessageTransmitterV2 to receive message on. */
  destMessageTransmitter: Address;
  /** Destination CCTP domain (already encoded as uint32 in burn args). */
  destDomain: number;
}

/** Build the parameters for a single end-to-end bridge run.
 *
 *  `recipient` is the address to mint to on the destination chain. For
 *  same-account bridging (most common), pass the user's own address — AA
 *  smart-account addresses are deterministic across chains, so the AA at
 *  `0xabc…` on Sepolia owns the same address on Base Sepolia. */
export function planBridge(input: {
  sourceChain: SupportedChainId;
  destChain: SupportedChainId;
  recipient: Address;
  amountUnits: bigint;
  speed?: "fast" | "finalized";
  /** Override the auto-derived fast-transfer cap (defaults to amount/200,
   *  i.e. 0.5%). Ignored for finalized speed. */
  maxFeeUnits?: bigint;
}): BridgeQuote {
  if (input.sourceChain === input.destChain) {
    throw new Error("source and destination must differ");
  }
  if (input.amountUnits <= 0n) {
    throw new Error("amount must be > 0");
  }
  const speed = input.speed ?? "fast";
  const minFinalityThreshold =
    speed === "finalized" ? CCTP_FINALITY.FINALIZED : CCTP_FINALITY.FAST;

  // Cap the fast-transfer fee at 0.5% of the amount by default. Finalized
  // transfers ignore maxFee server-side but the contract still requires
  // the value, so we pass 0 in that case.
  const maxFee =
    speed === "finalized"
      ? 0n
      : input.maxFeeUnits ?? input.amountUnits / 200n;

  const sourceTokenMessenger = CCTP_TOKEN_MESSENGER_V2[input.sourceChain];
  const sourceUsdc = CCTP_USDC[input.sourceChain];
  const destMessageTransmitter = CCTP_MESSAGE_TRANSMITTER_V2[input.destChain];
  const destDomain = CCTP_DOMAIN[input.destChain];
  if (!sourceTokenMessenger || !sourceUsdc || !destMessageTransmitter || destDomain === undefined) {
    throw new Error(
      `CCTP bridge is not supported between chains ${input.sourceChain} and ${input.destChain}`
    );
  }

  return {
    amountUnits: input.amountUnits,
    mintRecipient32: addressToBytes32(input.recipient),
    destinationCaller32:
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    maxFee,
    minFinalityThreshold,
    sourceTokenMessenger,
    sourceUsdc,
    destMessageTransmitter,
    destDomain,
  };
}
