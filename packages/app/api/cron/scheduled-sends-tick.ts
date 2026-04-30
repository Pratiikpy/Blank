/**
 * /api/cron/scheduled-sends-tick — Phase 4.1 Vercel Cron entrypoint.
 *
 * Walks every NOT-revoked session-key row in Supabase, queries the
 * SessionKeyValidator on chain for the current scope state, and fires
 * UserOps for any scope whose `lastFiredAt + periodSeconds <= now`.
 *
 * Trust model:
 *   • Authoritative scope state is on chain. The Supabase row is just
 *     the encrypted-key adjunct + a label.
 *   • Cron NEVER signs anything outside the bounds of the on-chain
 *     scope. Even with full key compromise, attacker is limited to
 *     `maxAmountPerCall` per fire (validator-enforced) to a fixed
 *     recipient (validator-enforced) at most once per period
 *     (EntryPoint-enforced via packed validAfter).
 *
 * Per-tick budget: process at most MAX_FIRES_PER_TICK so a flood of
 * due scopes can't exhaust the cron's wall-clock budget. Skipped scopes
 * fire on the next tick.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 */

import { ethers } from "ethers";

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const SUPPORTED_CHAINS = [11155111, 84532] as const;
type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

const RPC_URLS: Record<SupportedChain, string> = {
  11155111: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  84532: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

/** Per-tick fire cap. Each fire costs ~1 `getScope` read + ~1 UserOp
 *  signature + ~1 RPC submit. Stays well under Vercel's 10s limit. */
const MAX_FIRES_PER_TICK = 25;

const VALIDATOR_ABI = [
  "function getScope(address account, address sessionKey) view returns (tuple(address recipient, address spendToken, uint128 maxAmountPerCall, uint48 periodSeconds, uint48 validUntil, uint48 lastFiredAt))",
];

const BLANK_ACCOUNT_ABI = [
  "function enabledValidators(address) view returns (bool)",
];

const ENTRYPOINT_ABI = [
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  // v0.8 canonical userOpHash. We READ this from the chain rather than
  // hand-rolling the EIP-712 typed-data hash because (a) the EntryPoint
  // is the authority and (b) library drift across v0.7→v0.8 trapped
  // the previous hand-rolled implementation in this file.
  "function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)",
];

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

interface ChainSnapshot {
  chainId: number;
  scanned: number;
  fired: number;
  skipped: number;
  errored: number;
  errors: string[];
}

interface FireParams {
  account: string;
  sessionKey: string;
  recipient: string;
  spendToken: string;
  maxAmountPerCall: bigint;
  validUntil: number;
  encryptedPrivateKey: string;
  chainId: number;
  rpcUrl: string;
}

/** Build + sign + submit a single scheduled UserOp. Returns the relay's
 *  tx hash on success. Throws with a sanitized error on failure (caller
 *  catches and increments errored counter). */
async function fireScheduledSend(args: FireParams): Promise<string> {
  const provider = new ethers.JsonRpcProvider(args.rpcUrl);
  const entryPoint = new ethers.Contract(ENTRYPOINT_V08, ENTRYPOINT_ABI, provider);
  const validatorAddr = process.env[`VITE_BLANK_${args.chainId}_SESSION_KEY_VALIDATOR`];
  if (!validatorAddr || !/^0x[0-9a-fA-F]{40}$/.test(validatorAddr)) {
    throw new Error("SessionKeyValidator address not configured for this chain");
  }

  // Encode inner ERC-20 transfer(recipient, maxAmountPerCall) — the
  // validator enforces that the AA's execute target is exactly the
  // spendToken AND inner data is transfer(scope.recipient, amount<=cap).
  const transferIface = new ethers.Interface([
    "function transfer(address to, uint256 amount)",
  ]);
  const transferCalldata = transferIface.encodeFunctionData("transfer", [
    args.recipient,
    args.maxAmountPerCall,
  ]);

  // Encode outer execute(spendToken, 0, transferCalldata).
  const executeIface = new ethers.Interface([
    "function execute(address target, uint256 value, bytes data)",
  ]);
  const callData = executeIface.encodeFunctionData("execute", [
    args.spendToken,
    0n,
    transferCalldata,
  ]);

  // Get the AA's current nonce (key=0).
  const nonce = (await entryPoint.getNonce(args.account, 0)) as bigint;

  // Pack accountGasLimits = (verificationGasLimit << 128) | callGasLimit.
  // Conservative budgets: validator dispatch + transfer.
  const verificationGasLimit = 600_000n;
  const callGasLimit = 200_000n;
  const accountGasLimits =
    "0x" + verificationGasLimit.toString(16).padStart(32, "0") + callGasLimit.toString(16).padStart(32, "0");
  // gasFees = (maxPriorityFeePerGas << 128) | maxFeePerGas. Use modest
  // testnet defaults; relayer's fee config could override but for testnet
  // these stick.
  const maxPriorityFeePerGas = 1_500_000_000n; // 1.5 gwei
  const maxFeePerGas = 30_000_000_000n; // 30 gwei
  const gasFees =
    "0x" +
    maxPriorityFeePerGas.toString(16).padStart(32, "0") +
    maxFeePerGas.toString(16).padStart(32, "0");

  // Read the canonical v0.8 userOpHash directly from the EntryPoint.
  // v0.8 uses EIP-712 typed-data hashing (not v0.7's
  // keccak(packed || entryPoint || chainId)) — replicating that math
  // here is fragile against library drift, so we let the EntryPoint
  // do it. The contract gives us the SAME hash the validator + EntryPoint
  // will use during validation, so signature recovery succeeds.
  // Signature must be empty for the read because it's part of the struct
  // shape (the EntryPoint omits it from the hash internally).
  const preVerificationGas = 60_000n;
  const userOpForHashStruct = {
    sender: args.account,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData: "0x",
    signature: "0x",
  };
  const userOpHash = (await entryPoint.getUserOpHash(userOpForHashStruct)) as string;

  // Sign the userOpHash with the session key (decrypt-in-memory, sign,
  // discard). Then wrap in BlankAccount's outer (validator, innerSig)
  // format so the AA's _validateSignature dispatches to our validator.
  const { signWithSessionKey } = await import("../_lib/session-keys-store.js");
  const ecdsaSig = await signWithSessionKey({
    encryptedPrivateKey: args.encryptedPrivateKey,
    digest: userOpHash,
  });
  // SessionKeyValidator expects userOp.signature = abi.encode(sessionKey, innerSig).
  const innerSig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [args.sessionKey, ecdsaSig],
  );
  // BlankAccount's _validateSignature expects abi.encode(validator, innerSig)
  // when sig.length != 64 → routes to the validator.
  const outerSig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [validatorAddr, innerSig],
  );

  // Submit to /api/relay using the same shape the frontend uses. We
  // proxy through relay rather than calling EntryPoint directly so the
  // relayer's ETH funds gas (paymaster sponsorship layer is preserved).
  // Hard-fail when neither env var is set in production-like environments
  // — silently falling back to localhost would mean every cron fire
  // ECONNREFUSEs and the operator gets no obvious "your env is misconfigured"
  // signal, just opaque per-scope errors.
  let relayUrl: string;
  if (process.env.PUBLIC_APP_URL) {
    relayUrl = `${process.env.PUBLIC_APP_URL}/api/relay`;
  } else if (process.env.VERCEL_URL) {
    relayUrl = `https://${process.env.VERCEL_URL}/api/relay`;
  } else if (process.env.NODE_ENV !== "production") {
    relayUrl = "http://localhost:3000/api/relay";
  } else {
    throw new Error(
      "relay URL unconfigured — set PUBLIC_APP_URL or rely on VERCEL_URL on Vercel deploys",
    );
  }

  const userOpForRelay = {
    sender: args.account,
    nonce: nonce.toString(),
    initCode: "0x",
    callData,
    accountGasLimits,
    preVerificationGas: preVerificationGas.toString(),
    gasFees,
    paymasterAndData: "0x",
    signature: outerSig,
  };
  const resp = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userOp: userOpForRelay, chainId: args.chainId }),
  });
  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(`relay rejected (${resp.status}): ${errBody.error ?? "unknown"}`);
  }
  const result = (await resp.json()) as { hash: string };
  return result.hash;
}

export default async function handler(req: any, res: any) {
  // Fail CLOSED on missing CRON_SECRET — an unauthenticated attacker
  // hammering this endpoint could burn every active scope's per-period
  // budget for free (the validator advances `lastFiredAt` even on
  // execution-phase reverts, locking real users out of their scopes
  // until next period). Treat missing config as misconfiguration, not
  // bypass.
  const expected = process.env.CRON_SECRET;
  const provided = req.headers["authorization"];
  if (!expected || provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { listActiveKeysForChain } = await import("../_lib/session-keys-store.js");
  const snapshots: ChainSnapshot[] = [];

  for (const chainId of SUPPORTED_CHAINS) {
    const snap: ChainSnapshot = {
      chainId,
      scanned: 0,
      fired: 0,
      skipped: 0,
      errored: 0,
      errors: [],
    };
    snapshots.push(snap);

    let keys: Awaited<ReturnType<typeof listActiveKeysForChain>>;
    try {
      keys = await listActiveKeysForChain(chainId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      snap.errors.push(`list:${msg.slice(0, 120)}`);
      continue;
    }
    snap.scanned = keys.length;
    if (keys.length === 0) continue;

    const provider = new ethers.JsonRpcProvider(RPC_URLS[chainId]);
    const validatorAddr = process.env[`VITE_BLANK_${chainId}_SESSION_KEY_VALIDATOR`];
    if (!validatorAddr || !/^0x[0-9a-fA-F]{40}$/.test(validatorAddr)) {
      snap.errors.push("config:VITE_BLANK_<chain>_SESSION_KEY_VALIDATOR unset");
      continue;
    }
    const validator = new ethers.Contract(validatorAddr, VALIDATOR_ABI, provider);
    const nowSec = Math.floor(Date.now() / 1000);
    let firedThisTick = 0;

    for (const k of keys) {
      if (firedThisTick >= MAX_FIRES_PER_TICK) {
        snap.skipped += 1;
        continue;
      }
      try {
        // Read account-side validator-enabled flag first. If the user
        // called BlankAccount.disableValidator (revokes ALL session keys
        // routed via this validator), every fire would silently
        // SIG_VALIDATION_FAILED at the AA gate. Mark the row revoked so
        // we stop polling it and clutter logs with each tick.
        const accountContract = new ethers.Contract(
          k.account,
          BLANK_ACCOUNT_ABI,
          provider,
        );
        const validatorEnabled = (await accountContract.enabledValidators(
          validatorAddr,
        )) as boolean;
        if (!validatorEnabled) {
          const { markRevoked } = await import("../_lib/session-keys-store.js");
          await markRevoked({
            account: k.account,
            sessionKey: k.sessionKey,
            chainId,
          });
          snap.skipped += 1;
          continue;
        }

        // Read scope state on chain. Authoritative — even if the local
        // row says "active", a chain `revokeScope` makes the scope
        // inert and the cron should treat it as such.
        const scopeRaw = await validator.getScope(k.account, k.sessionKey);
        const scope = {
          recipient: scopeRaw[0] as string,
          spendToken: scopeRaw[1] as string,
          maxAmountPerCall: scopeRaw[2] as bigint,
          periodSeconds: Number(scopeRaw[3]),
          validUntil: Number(scopeRaw[4]),
          lastFiredAt: Number(scopeRaw[5]),
        };
        if (scope.recipient === ethers.ZeroAddress) {
          // Revoked on chain — soft-mark the row so we stop polling it.
          const { markRevoked } = await import("../_lib/session-keys-store.js");
          await markRevoked({
            account: k.account,
            sessionKey: k.sessionKey,
            chainId,
          });
          snap.skipped += 1;
          continue;
        }
        if (scope.validUntil > 0 && scope.validUntil <= nowSec) {
          snap.skipped += 1;
          continue;
        }
        // Due check: lastFiredAt + period <= now.
        const nextAllowed = scope.lastFiredAt + scope.periodSeconds;
        if (nextAllowed > nowSec) {
          snap.skipped += 1;
          continue;
        }

        const txHash = await fireScheduledSend({
          account: k.account,
          sessionKey: k.sessionKey,
          recipient: scope.recipient,
          spendToken: scope.spendToken,
          maxAmountPerCall: scope.maxAmountPerCall,
          validUntil: scope.validUntil,
          encryptedPrivateKey: k.encryptedPrivateKey,
          chainId,
          rpcUrl: RPC_URLS[chainId],
        });
        console.log(
          `[scheduled-sends-tick] fired chainId=${chainId} account=${k.account}` +
            ` sessionKey=${k.sessionKey} hash=${txHash}`,
        );
        snap.fired += 1;
        firedThisTick += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        snap.errored += 1;
        snap.errors.push(`${k.sessionKey.slice(0, 10)}…:${msg.slice(0, 120)}`);
        console.warn(
          `[scheduled-sends-tick] error chainId=${chainId} sessionKey=${k.sessionKey}: ${msg}`,
        );
      }
    }
  }

  res.status(200).json({
    status: "ok",
    snapshots,
  });
}
