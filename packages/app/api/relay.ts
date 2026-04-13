/**
 * /api/relay — sponsor a UserOp via the EntryPoint
 *
 * Flow:
 *   1. Frontend builds + signs a PackedUserOperation with the user's passkey
 *   2. POSTs serialized UserOp + chainId here
 *   3. Server validates: chainId is supported, sender shape, signature non-empty,
 *      callData uses BlankAccount.execute selector
 *   4. Server submits via entryPoint.handleOps([userOp], beneficiary) using
 *      the relayer wallet (RELAYER_PRIVATE_KEY env var)
 *   5. Returns transaction hash
 *
 * The relayer pays gas. The paymaster (configured separately) decides whether
 * to refund the relayer in feeToken — for buildathon scope we just sponsor
 * everything that targets an approved-paymaster-target.
 *
 * Trust model: relayer only ever submits, never signs anything that affects
 * the user's smart account. The only thing the relayer can do maliciously is
 * refuse to submit (in which case user is no worse off than before).
 */

import { ethers } from "ethers";

// ─── Config ───────────────────────────────────────────────────────────

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const EXECUTE_SELECTOR = "0xb61d27f6"; // BlankAccount.execute(address,uint256,bytes)
const EXECUTE_BATCH_SELECTOR = "0x47e1da2a"; // BlankAccount.executeBatch (allowlisted)

const SUPPORTED_CHAINS: Record<number, { rpcUrl: string; entryPoint: string }> = {
  11155111: {
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
    entryPoint: ENTRYPOINT_V08,
  },
  84532: {
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    entryPoint: ENTRYPOINT_V08,
  },
};

const ENTRYPOINT_ABI = [
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)",
];

// ─── Rate limiting (in-memory, per-IP) ────────────────────────────────
// Same limitation as /api/agent/derive — Vercel cold starts wipe the map.
// Move to Vercel KV before high-traffic production. For testnet hackathon
// scope this is acceptable; abuse just means slower throughput.

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10; // 10 UserOps per IP per minute
const rateMap = new Map<string, number[]>();

function ipFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].split(",")[0].trim();
  return "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const calls = (rateMap.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (calls.length >= RATE_MAX) {
    rateMap.set(ip, calls);
    return true;
  }
  rateMap.set(ip, [...calls, now]);
  return false;
}

// ─── Validation ───────────────────────────────────────────────────────

interface SerializedUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
}

function validateUserOp(op: SerializedUserOp): { ok: true } | { ok: false; error: string } {
  if (!op.sender || !ethers.isAddress(op.sender)) return { ok: false, error: "invalid sender address" };
  try { BigInt(op.nonce); } catch { return { ok: false, error: "invalid nonce" }; }
  if (!ethers.isHexString(op.callData)) return { ok: false, error: "callData must be hex" };
  if (op.callData.length < 10) return { ok: false, error: "callData too short" };
  if (!ethers.isHexString(op.signature) || op.signature.length < 4) {
    return { ok: false, error: "signature missing or malformed" };
  }
  if (!ethers.isHexString(op.accountGasLimits) || op.accountGasLimits.length !== 66) {
    return { ok: false, error: "accountGasLimits must be 32-byte hex" };
  }
  if (!ethers.isHexString(op.gasFees) || op.gasFees.length !== 66) {
    return { ok: false, error: "gasFees must be 32-byte hex" };
  }

  // Only allow BlankAccount.execute or executeBatch — narrows attack surface.
  // Anything else routed through here can target arbitrary contracts.
  const selector = op.callData.slice(0, 10).toLowerCase();
  if (selector !== EXECUTE_SELECTOR && selector !== EXECUTE_BATCH_SELECTOR) {
    return { ok: false, error: `relayer only sponsors execute / executeBatch — got selector ${selector}` };
  }

  return { ok: true };
}

// ─── Handler ──────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const ip = ipFromHeaders(req.headers ?? {});
  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate limited — try again in a minute" });
    return;
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    res.status(500).json({ error: "server not configured — missing RELAYER_PRIVATE_KEY" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { res.status(400).json({ error: "invalid JSON body" }); return; }
  }

  const { userOp, chainId } = body ?? {};
  if (typeof chainId !== "number" || !SUPPORTED_CHAINS[chainId]) {
    res.status(400).json({ error: `unsupported chainId — must be one of ${Object.keys(SUPPORTED_CHAINS).join(", ")}` });
    return;
  }
  if (!userOp) {
    res.status(400).json({ error: "userOp missing from body" });
    return;
  }

  const validation = validateUserOp(userOp as SerializedUserOp);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const cfg = SUPPORTED_CHAINS[chainId];
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const wallet = new ethers.Wallet(relayerKey, provider);
  const entryPoint = new ethers.Contract(cfg.entryPoint, ENTRYPOINT_ABI, wallet);

  // ethers expects BigInts for uint256 fields — re-hydrate from strings
  const op = userOp as SerializedUserOp;
  const ethersOp = {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };

  try {
    const tx = await entryPoint.handleOps([ethersOp], wallet.address, {
      // EntryPoint loop has overhead beyond the UserOp's own gas — give it room.
      gasLimit: 15_000_000n,
    });
    const receipt = await tx.wait();
    res.status(200).json({
      hash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      status: receipt?.status ?? "submitted",
      relayer: wallet.address,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(502).json({ error: `entryPoint.handleOps failed: ${msg}` });
  }
}
