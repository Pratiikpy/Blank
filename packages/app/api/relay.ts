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
import { checkRateLimit, writeRateLimitHeaders } from "./_lib/rate-limit";
import { getSigner } from "./_lib/signer";

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
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
];

// ─── Rate limiting ────────────────────────────────────────────────────
// Shared limiter: uses Vercel KV when KV_REST_API_URL + KV_REST_API_TOKEN
// are set (correct across cold starts + instances), falls back to an
// in-memory Map for local dev. 10 UserOps per IP per minute.

function ipFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].split(",")[0].trim();
  return "unknown";
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

// ─── Relay serialization + local nonce counter ────────────────────
// The relayer EOA can only submit one tx per nonce. Concurrent calls
// race for the same nonce, and even a back-to-back confirm-then-read
// of "pending" can return stale because public RPCs lag behind the
// chain tip by seconds.
//
// Solution: serialize per-chain, AND maintain a local nonce counter that
// we increment after each successful submission. Providers eventually
// converge; the counter keeps us one step ahead.
//
// Scoped per chainId since each chain has its own nonce sequence.
const relayQueues: Map<number, Promise<unknown>> = new Map();
const nextNonceByChain: Map<number, number> = new Map();

async function serialize<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const prev = relayQueues.get(chainId) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn()); // run even if prev rejected
  relayQueues.set(chainId, next);
  try {
    return await next;
  } finally {
    // Only clear if this is the tail (no newer entry queued on top)
    if (relayQueues.get(chainId) === next) relayQueues.delete(chainId);
  }
}

/**
 * Pick a safe nonce: max(local counter, chain pending). Call
 * `commitNonce(n)` after a successful submission to advance the local
 * counter. If submission fails the counter is untouched — the next
 * serialize() turn will re-read chain state and choose again.
 */
async function pickNonce(
  chainId: number,
  provider: ethers.JsonRpcProvider,
  relayerAddress: string,
): Promise<number> {
  const chainPending = await provider.getTransactionCount(relayerAddress, "pending");
  const local = nextNonceByChain.get(chainId) ?? 0;
  return Math.max(local, chainPending);
}

function commitNonce(chainId: number, used: number) {
  const local = nextNonceByChain.get(chainId) ?? 0;
  if (used + 1 > local) nextNonceByChain.set(chainId, used + 1);
}

// ─── Handler ──────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const ip = ipFromHeaders(req.headers ?? {});
  const rl = await checkRateLimit({ ip, key: "relay", windowMs: 60_000, max: 10 });
  writeRateLimitHeaders(res, rl);
  if (!rl.ok) {
    res.status(429).json({ error: `Rate limit exceeded — try again in ${rl.resetSeconds}s` });
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

  let signer;
  try {
    signer = getSigner("relayer", provider);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "signer init failed" });
    return;
  }
  const wallet = signer.ethersSigner; // for ethers.Contract compatibility
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
    const relayerAddress = await signer.getAddress();
    // Serialize per-chain so concurrent /api/relay calls don't race on
    // relayer nonce. Inside the queued critical section we read the
    // pending nonce and submit atomically — no other handler can interleave.
    const { tx, receipt } = await serialize(chainId, async () => {
      // Two independent safety mechanisms combine:
      //   1. Serialization (outer): only one relay call per chain
      //      executes at a time, so nonce picks are consistent with
      //      chain state captured at pick-time.
      //   2. Retry (inner): when the chosen nonce collides (dev HMR
      //      resets in-memory counter; public RPC lag) we reset the
      //      counter from chain "pending" and try once more.
      //
      // Up to 2 attempts. First attempt uses max(local, chain-pending);
      // if it fails with a nonce-ish error, reset local and use chain
      // "pending" straight.
      const attempt = async (
        chosenNonce: number,
      ): Promise<{ tx: typeof submittedTx; receipt: Awaited<ReturnType<typeof submittedTx.wait>> }> => {
        // Derive a tight gasLimit instead of a fixed 15M. At 25 gwei on
        // ETH Sepolia, 15M means Ethereum asks the relayer to reserve
        // 0.375 ETH — if the relayer has less, the tx fails at the
        // intrinsic-cost check before even reaching EntryPoint.
        //
        // accountGasLimits packs (verificationGasLimit, callGasLimit).
        // Sum those + preVerificationGas + buffer → real upper bound.
        const packedGas = BigInt(ethersOp.accountGasLimits);
        const verifGas = (packedGas >> 128n) & 0xffffffffffffffffffffffffffffffffn;
        const callGas = packedGas & 0xffffffffffffffffffffffffffffffffn;
        const preVerif = BigInt(ethersOp.preVerificationGas);
        // EntryPoint overhead + wiggle room. Initcode paths cost more.
        const hasInitCode = ethersOp.initCode !== "0x" && ethersOp.initCode.length > 2;
        const overhead = hasInitCode ? 500_000n : 200_000n;
        const computed = verifGas + callGas + preVerif + overhead;
        // Minimum floor for simple calls, hard ceiling at 8M to avoid
        // wasteful preauth holds on the relayer balance.
        const FLOOR = 1_500_000n;
        const CEILING = 8_000_000n;
        let gasLimit = computed < FLOOR ? FLOOR : computed;
        if (gasLimit > CEILING) gasLimit = CEILING;
        const submittedTx = await entryPoint.handleOps([ethersOp], relayerAddress, {
          gasLimit,
          nonce: chosenNonce,
        });
        commitNonce(chainId, chosenNonce);
        const submittedReceipt = await submittedTx.wait();
        return { tx: submittedTx, receipt: submittedReceipt };
      };

      // Forward-declare for the attempt signature to satisfy TS
      let submittedTx: Awaited<ReturnType<typeof entryPoint.handleOps>>;
      void submittedTx;

      const firstNonce = await pickNonce(chainId, provider, relayerAddress);
      try {
        return await attempt(firstNonce);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const nonceLike = /nonce|already been used|replacement|underpriced|execution reverted/i.test(msg);
        if (!nonceLike) throw err;
        // Reset local counter by re-reading chain + bumping past the
        // just-attempted nonce, then try once more.
        const chainPending = await provider.getTransactionCount(relayerAddress, "pending");
        const retryNonce = Math.max(chainPending, firstNonce + 1);
        nextNonceByChain.set(chainId, retryNonce);
        console.warn(`[relay] nonce conflict on ${firstNonce}, retrying with ${retryNonce} (${msg.slice(0, 80)})`);
        return await attempt(retryNonce);
      }
    });

    // #76: on-chain revert at the EntryPoint level returns status=0.
    // Without this, we'd return 200 OK and the frontend would cheerfully
    // render "success" while nothing actually happened.
    if (!receipt || receipt.status === 0) {
      res.status(502).json({
        error: "tx reverted on-chain",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber ?? null,
      });
      return;
    }

    // #77: EntryPoint.handleOps succeeds atomically even when the inner
    // UserOp reverted — it emits UserOperationEvent(success=false) instead
    // of bubbling the revert. We MUST decode the logs to surface this.
    let userOpSuccess = true;
    let revertReason: string | null = null;
    try {
      const iface = new ethers.Interface(ENTRYPOINT_ABI);
      for (const log of receipt.logs ?? []) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (!parsed) continue;
          if (parsed.name === "UserOperationEvent" && parsed.args.success === false) {
            userOpSuccess = false;
          }
          if (parsed.name === "UserOperationRevertReason") {
            revertReason = parsed.args.revertReason as string;
          }
        } catch {
          // not an EntryPoint log — skip
        }
      }
    } catch {
      // parsing failed — fall through; we've at least captured receipt.status
    }

    if (!userOpSuccess) {
      res.status(502).json({
        error: "UserOp inner call reverted",
        revertReason: revertReason ?? "unknown (EntryPoint emitted UserOperationEvent.success=false)",
        hash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
      return;
    }

    // Return the FULL receipt so the frontend doesn't have to re-poll the
    // RPC for it. Free public RPC tiers (sepolia.base.org) rate-limit the
    // waitForTransactionReceipt polling loop hard enough that callers
    // routinely time out at viem's 180s default — even though the tx is
    // already mined (we just confirmed it via tx.wait() above). Pre-serialize
    // the logs because ethers' Log objects don't survive JSON.
    const serializedLogs = (receipt.logs ?? []).map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      blockNumber: Number(l.blockNumber),
      transactionHash: l.transactionHash,
      transactionIndex: l.index,
      logIndex: l.index,
      removed: l.removed,
    }));
    res.status(200).json({
      hash: tx.hash,
      blockNumber: typeof receipt.blockNumber === "bigint" ? receipt.blockNumber.toString() : receipt.blockNumber,
      blockHash: receipt.blockHash,
      status: receipt.status === 1 ? "success" : "reverted",
      userOpSuccess: true,
      relayer: relayerAddress,
      logs: serializedLogs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(502).json({ error: `entryPoint.handleOps failed: ${msg}` });
  }
}
