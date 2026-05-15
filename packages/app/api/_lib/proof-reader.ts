// Shared PaymentReceipts.getProof reader for the two share-artifact
// endpoints (api/og/proof.tsx + api/share/proof.ts). Both render a
// per-proof preview off the same on-chain tuple; centralizing the
// read + formatters here keeps them from drifting.

import { ethers } from "ethers";
import { RPC_URLS } from "./addresses.js";

// PaymentReceipts deployments per chain. Mirrors packages/contracts/
// deployments/*.json — the server bundler can't read the frontend's
// constants.ts (it references import.meta.env). Operator env-var
// override per chain matches the rest of api/_lib/addresses.ts.
const PAYMENT_RECEIPTS_BY_CHAIN: Record<number, string> = {
  11155111: process.env.BLANK_ETH_SEPOLIA_PAYMENT_RECEIPTS ||
    "0xE2087A39cEa3C77566DF15936c2750511f808148",
  84532: process.env.BLANK_BASE_SEPOLIA_PAYMENT_RECEIPTS ||
    "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c",
};

// Minimal ABI — just getProof. Bypasses the full PaymentReceipts ABI's
// tuple-encoded events so the function bundle stays small.
const GET_PROOF_ABI = [
  "function getProof(uint256 proofId) view returns (address prover, uint64 threshold, uint256 blockNumber, uint256 timestamp, string kind, bool isTrue, bool isReady)",
];

export interface ProofState {
  prover: string;
  threshold: bigint;
  kind: string;
  isTrue: boolean;
  isReady: boolean;
}

export async function readProof(
  chainId: number,
  proofId: bigint,
): Promise<ProofState | null> {
  const rpcUrl = RPC_URLS[chainId];
  const receiptsAddr = PAYMENT_RECEIPTS_BY_CHAIN[chainId];
  if (!rpcUrl || !receiptsAddr) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(receiptsAddr, GET_PROOF_ABI, provider);
    const raw = (await contract.getProof(proofId)) as unknown as readonly [
      string, bigint, bigint, bigint, string, boolean, boolean,
    ];
    return {
      prover: raw[0],
      threshold: raw[1],
      kind: raw[4],
      isTrue: raw[5],
      isReady: raw[6],
    };
  } catch {
    // getProof reverts with "PaymentReceipts: proof not found" for
    // unknown ids. Treat any failure as "not found" rather than 500 —
    // link previewers fall back to a generic state.
    return null;
  }
}

// USDC-style 6-decimals → USD display. Whole dollars when integer; up
// to 2 decimals otherwise, stripped of trailing zeros.
export function formatThresholdUSD(thresholdRaw: bigint): string {
  const dollars = Number(thresholdRaw) / 1_000_000;
  if (dollars >= 1000) {
    return `$${Math.round(dollars).toLocaleString("en-US")}`;
  }
  return `$${dollars.toFixed(2).replace(/\.?0+$/, "")}`;
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function parseProofIdParam(idParam: string | null): bigint | null {
  if (!idParam || !/^\d+$/.test(idParam)) return null;
  try { return BigInt(idParam); } catch { return null; }
}

export function parseChainIdParam(
  chainParam: string | null,
  fallback = 11155111,
): number {
  if (!chainParam) return fallback;
  const n = parseInt(chainParam, 10);
  return Number.isFinite(n) ? n : fallback;
}
