/**
 * /api/faucet/usdc — Drip 100 testnet USDC to a smart-account address.
 *
 * Usage:
 *   POST /api/faucet/usdc
 *   { "address": "0x…", "chainId": 11155111 }
 *
 * Returns:
 *   { ok: true, hash: "0x…", amount: "100000000" }   — minted 100 USDC
 *   { ok: false, error: "rate_limited" | ... }       — see status code
 *
 * Rate limits (defense in depth):
 *   • Per-IP: 30 requests / hour (covers both auto + manual paths)
 *   • Per-address: 5 requests / hour (prevents draining via N IPs to one wallet)
 *   • Per-address: 24 requests / day (cap aggregate per AA)
 *
 * Auth: NONE. The contract's `mint(to, amount)` is permissionless on
 * testnet. The endpoint exists only to:
 *   1. Cover gas for the user (relayer pays the mint tx fee)
 *   2. Apply rate limits (the contract has none)
 *   3. Centralise the auto-drip trigger from `/api/relay.ts`
 *
 * In production, this whole endpoint is removed. There is no real-money
 * equivalent.
 */

import { ethers } from "ethers";
import { getContracts, ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "../_lib/addresses.js";
import { checkRateLimit, writeRateLimitHeaders } from "../_lib/rate-limit.js";

/** 100 USDC (6 decimals). Cheap enough for a one-time drip per AA. */
const FAUCET_AMOUNT_UNITS = 100_000_000n;

const SUPPORTED_CHAIN_RPCS: Record<number, string> = {
  [ETH_SEPOLIA_ID]: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  [BASE_SEPOLIA_ID]: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

const TEST_USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
];

interface FaucetBody {
  address: string;
  chainId: number;
}

function getIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!;
  return req.socket?.remoteAddress ?? "unknown";
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as FaucetBody;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (!isHexAddress(body.address)) {
    res.status(400).json({ error: "address must be a 0x-prefixed 40-char hex string" });
    return;
  }
  const chainId = Number(body.chainId);
  if (!SUPPORTED_CHAIN_RPCS[chainId]) {
    res.status(400).json({ error: `chainId ${chainId} is not supported` });
    return;
  }

  // ── Rate limits ─────────────────────────────────────────────────────
  // Per-IP limit catches drive-by abuse.
  const ip = getIp(req);
  const ipLimit = await checkRateLimit({ ip, key: "faucet-usdc", windowMs: 3_600_000, max: 30 });
  writeRateLimitHeaders(res, ipLimit);
  if (!ipLimit.ok) {
    res.status(429).json({ error: "rate_limited", scope: "ip" });
    return;
  }
  // Per-address limit: same address can't be drained from many IPs.
  // Stored under the lowercase address as the "ip" key for the limiter.
  const addressLower = body.address.toLowerCase();
  const addrLimit = await checkRateLimit({
    ip: addressLower,
    key: "faucet-usdc-addr",
    windowMs: 3_600_000,
    max: 5,
  });
  if (!addrLimit.ok) {
    res.status(429).json({ error: "rate_limited", scope: "address" });
    return;
  }
  // Daily per-address ceiling — caps aggregate per AA at 24 mints/day so a
  // patient attacker can't pump 5/hr × 24h = 120 mints out of one wallet.
  // Plan §7.2 explicitly asked for this; the per-hour limit alone isn't
  // enough on a 24h horizon.
  const addrDayLimit = await checkRateLimit({
    ip: addressLower,
    key: "faucet-usdc-addr-day",
    windowMs: 86_400_000,
    max: 24,
  });
  if (!addrDayLimit.ok) {
    res.status(429).json({ error: "rate_limited", scope: "address-day" });
    return;
  }

  // ── Pre-flight: relayer key configured? ─────────────────────────────
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    res.status(503).json({ error: "RELAYER_PRIVATE_KEY not configured" });
    return;
  }

  // ── Submit the mint tx ──────────────────────────────────────────────
  try {
    const contracts = getContracts(chainId);
    if (!contracts) {
      res.status(503).json({ error: `no contracts configured for chain ${chainId}` });
      return;
    }
    const provider = new ethers.JsonRpcProvider(SUPPORTED_CHAIN_RPCS[chainId]);
    const signer = new ethers.Wallet(relayerKey, provider);
    const testUsdc = new ethers.Contract(contracts.TestUSDC, TEST_USDC_ABI, signer);

    const tx = await testUsdc.mint(body.address, FAUCET_AMOUNT_UNITS);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      res.status(502).json({ error: "mint tx reverted", hash: tx.hash });
      return;
    }

    res.status(200).json({
      ok: true,
      hash: tx.hash,
      amount: FAUCET_AMOUNT_UNITS.toString(),
      address: body.address,
      chainId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.slice(0, 280) });
  }
}
