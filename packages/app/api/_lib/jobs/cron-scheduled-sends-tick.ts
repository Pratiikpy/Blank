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
const SUPPORTED_CHAINS = [11155111, 84532, 421614] as const;
type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

const RPC_URLS: Record<SupportedChain, string> = {
  11155111: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
  84532: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  421614: process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
};

/** Per-tick fire cap. Each fire costs ~1 `getScope` read + ~1 UserOp
 *  signature + ~1 RPC submit. Stays well under Vercel's 10s limit. */
const MAX_FIRES_PER_TICK = 25;

const SCOPE_TUPLE =
  "tuple(address recipient, address spendToken, uint128 maxAmountPerCall, uint48 periodSeconds, uint48 validUntil, uint48 lastFiredAt, uint128 maxFeePerGas, uint64 maxTotalGas, address paymaster)";
const VALIDATOR_ABI = [`function getScope(address account, address sessionKey) view returns (${SCOPE_TUPLE})`];

const BLANK_ACCOUNT_ABI = [
  // security-v1: enabled AND enabled in the current owner epoch.
  "function isValidatorEnabled(address validator) view returns (bool)",
];

const ENTRYPOINT_ABI = [
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  // v0.8 canonical userOpHash, read from the EntryPoint rather than
  // re-implemented (v0.8 hashes EIP-712 typed data, paymasterAndData included).
  "function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)",
];

/** Gas budget for one fire. The scope's maxTotalGas must cover these
 *  (plus the paymaster's two limits when sponsored). */
export const FIRE_VERIFICATION_GAS = 600_000n;
export const FIRE_CALL_GAS = 200_000n;
export const FIRE_PRE_VERIFICATION_GAS = 60_000n;

interface ChainSnapshot {
  chainId: number;
  scanned: number;
  fired: number;
  skipped: number;
  errored: number;
  errors: string[];
}

export interface OnChainScope {
  recipient: string;
  spendToken: string;
  maxAmountPerCall: bigint;
  periodSeconds: number;
  validUntil: number;
  lastFiredAt: number;
  maxFeePerGas: bigint;
  maxTotalGas: bigint;
  paymaster: string;
}

export function decodeScope(raw: ArrayLike<unknown>): OnChainScope {
  return {
    recipient: raw[0] as string,
    spendToken: raw[1] as string,
    maxAmountPerCall: raw[2] as bigint,
    periodSeconds: Number(raw[3]),
    validUntil: Number(raw[4]),
    lastFiredAt: Number(raw[5]),
    maxFeePerGas: raw[6] as bigint,
    maxTotalGas: raw[7] as bigint,
    paymaster: raw[8] as string,
  };
}

interface FireParams {
  account: string;
  sessionKey: string;
  scope: OnChainScope;
  encryptedPrivateKey: string;
  chainId: number;
  rpcUrl: string;
  validatorAddr: string;
}

/** SessionKeyValidator.sessionDigest: what the session key signs. */
export function sessionDigest(userOpHash: string, notBefore: number): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint48"], [userOpHash, notBefore]),
  );
}

/**
 * userOp.signature for a session-key fire:
 *   BlankAccount layer:   abi.encode(address validator, bytes inner)
 *   validator layer:      inner = abi.encode(address sessionKey, uint48 notBefore, bytes ecdsaSig)
 * ecdsaSig is a raw (no EIP-191 prefix) signature over sessionDigest(userOpHash, notBefore).
 */
export function encodeSessionSignature(
  validator: string,
  sessionKey: string,
  notBefore: number,
  ecdsaSig: string,
): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const inner = coder.encode(["address", "uint48", "bytes"], [sessionKey, notBefore, ecdsaSig]);
  return coder.encode(["address", "bytes"], [validator, inner]);
}

/** Fees for an unsponsored fire, under the scope's maxFeePerGas.
 *  The validator applies that cap to both maxFee and the priority fee. */
export function chooseSessionFees(
  baseFee: bigint,
  networkPriority: bigint,
  scopeMaxFee: bigint,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  let maxFee = 2n * baseFee + networkPriority;
  if (maxFee > scopeMaxFee) maxFee = scopeMaxFee;
  if (maxFee < baseFee) {
    throw new Error(`base fee ${baseFee} wei is above this schedule's gas cap of ${scopeMaxFee} wei`);
  }
  const priority = networkPriority < maxFee ? networkPriority : maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

const pack128 = (hi: bigint, lo: bigint) =>
  "0x" + hi.toString(16).padStart(32, "0") + lo.toString(16).padStart(32, "0");

/** Build + sign + submit a single scheduled UserOp. Returns the relay's
 *  tx hash on success. Throws with a sanitized error on failure (caller
 *  catches and increments errored counter). */
async function fireScheduledSend(args: FireParams): Promise<string> {
  const provider = new ethers.JsonRpcProvider(args.rpcUrl);
  const entryPoint = new ethers.Contract(ENTRYPOINT_V08, ENTRYPOINT_ABI, provider);
  const { scope } = args;

  // The validator requires execute(spendToken, 0, transfer(recipient, amount<=cap)).
  const transferIface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
  const transferCalldata = transferIface.encodeFunctionData("transfer", [scope.recipient, scope.maxAmountPerCall]);
  const executeIface = new ethers.Interface(["function execute(address target, uint256 value, bytes data)"]);
  const callData = executeIface.encodeFunctionData("execute", [scope.spendToken, 0n, transferCalldata]);

  const [nonce, block] = await Promise.all([
    entryPoint.getNonce(args.account, 0) as Promise<bigint>,
    provider.getBlock("latest"),
  ]);
  if (!block) throw new Error("no latest block");
  // notBefore pins the fire slot to now: slot = max(lastFiredAt + period,
  // notBefore), valid until slot + grace. A stale slot from a missed
  // period would otherwise already be past its grace window.
  const notBefore = Number(block.timestamp);
  const baseFee = block.baseFeePerGas ?? 0n;
  let networkPriority = 1_000_000n;
  try {
    networkPriority = BigInt((await provider.send("eth_maxPriorityFeePerGas", [])) as string);
  } catch { /* keep the floor */ }

  const accountGasLimits = pack128(FIRE_VERIFICATION_GAS, FIRE_CALL_GAS);
  const baseGas = FIRE_VERIFICATION_GAS + FIRE_CALL_GAS + FIRE_PRE_VERIFICATION_GAS;
  let gasFees: string;
  let paymasterAndData = "0x";

  // Sponsored when the scope names the paymaster and the sponsor agrees;
  // otherwise the account's own EntryPoint deposit pays.
  let sponsored = false;
  const { getContracts } = await import("../addresses.js");
  const pmAddr = getContracts(args.chainId)?.BlankPaymaster;
  if (
    pmAddr &&
    scope.paymaster.toLowerCase() === pmAddr.toLowerCase() &&
    process.env.BLANK_PAYMASTER_SIGNER_PK
  ) {
    const lib = await import("../paymaster-sponsor.js");
    if (baseGas + lib.PM_VERIFICATION_GAS + lib.PM_POSTOP_GAS <= scope.maxTotalGas) {
      try {
        const s = await lib.sponsorUserOp(
          lib.ethersSponsorChain(provider, args.chainId, pmAddr),
          lib.loadSponsorSigner(),
          {
            userOp: {
              sender: args.account,
              nonce: nonce.toString(),
              initCode: "0x",
              callData,
              accountGasLimits,
              preVerificationGas: FIRE_PRE_VERIFICATION_GAS.toString(),
              gasFees: pack128(0n, 0n),
            },
            maxFeePerGasCeiling: scope.maxFeePerGas,
          },
        );
        gasFees = s.gasFees;
        paymasterAndData = s.paymasterAndData;
        sponsored = true;
      } catch (err) {
        console.warn(
          `[scheduled-sends-tick] sponsorship refused for ${args.account}, account pays: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  if (!sponsored) {
    if (baseGas > scope.maxTotalGas) {
      throw new Error(`schedule gas cap ${scope.maxTotalGas} is below the ${baseGas} a fire needs`);
    }
    const fees = chooseSessionFees(baseFee, networkPriority, scope.maxFeePerGas);
    gasFees = pack128(fees.maxPriorityFeePerGas, fees.maxFeePerGas);
  }

  const op = {
    sender: args.account,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits,
    preVerificationGas: FIRE_PRE_VERIFICATION_GAS,
    gasFees: gasFees!,
    paymasterAndData,
    signature: "0x",
  };
  const userOpHash = (await entryPoint.getUserOpHash(op)) as string;

  const { signWithSessionKey } = await import("../session-keys-store.js");
  const ecdsaSig = await signWithSessionKey({
    encryptedPrivateKey: args.encryptedPrivateKey,
    digest: sessionDigest(userOpHash, notBefore),
  });
  const signature = encodeSessionSignature(args.validatorAddr, args.sessionKey, notBefore, ecdsaSig);

  // Submit through /api/relay so the relayer EOA submits handleOps.
  // Hard-fail when neither env var is set in production-like environments.
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

  const resp = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userOp: {
        ...op,
        nonce: nonce.toString(),
        preVerificationGas: FIRE_PRE_VERIFICATION_GAS.toString(),
        signature,
      },
      chainId: args.chainId,
    }),
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

  const { listActiveKeysForChain } = await import("../session-keys-store.js");
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
        // The account must have this validator enabled in its current
        // owner epoch. After the security upgrade (new validator) or a
        // guardian recovery (epoch bump) it is not, until the owner
        // enables it again from the Scheduled sends screen, so skip
        // without revoking the row. Older implementations have no
        // isValidatorEnabled and cannot use this validator at all.
        const accountContract = new ethers.Contract(k.account, BLANK_ACCOUNT_ABI, provider);
        let validatorEnabled = false;
        try {
          validatorEnabled = (await accountContract.isValidatorEnabled(validatorAddr)) as boolean;
        } catch {
          validatorEnabled = false;
        }
        if (!validatorEnabled) {
          snap.skipped += 1;
          continue;
        }

        // Read scope state on chain. Authoritative — even if the local
        // row says "active", a chain `revokeScope` makes the scope
        // inert and the cron should treat it as such.
        const scope = decodeScope(await validator.getScope(k.account, k.sessionKey));
        if (scope.recipient === ethers.ZeroAddress) {
          // Revoked on chain — soft-mark the row so we stop polling it.
          const { markRevoked } = await import("../session-keys-store.js");
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
          scope,
          encryptedPrivateKey: k.encryptedPrivateKey,
          chainId,
          rpcUrl: RPC_URLS[chainId],
          validatorAddr,
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
