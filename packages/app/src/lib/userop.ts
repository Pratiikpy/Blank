import { encodeAbiParameters, encodePacked, type Hex, type Address, type PublicClient } from "viem";

// ─────────────────────────────────────────────────────────────────────
//  userop — PackedUserOperation v0.8 builder.
//
//  ERC-4337 v0.8 packs accountGasLimits and gasFees into single bytes32
//  fields (high 128 bits = first arg, low 128 bits = second). EntryPoint
//  hashes via EIP-712 — instead of reimplementing the typed-data hashing
//  off-chain (high error surface), we use entryPoint.getUserOpHash() as
//  the on-chain authoritative computation.
//
//  Reference:
//    @account-abstraction/contracts/interfaces/PackedUserOperation.sol
//    @account-abstraction/contracts/core/EntryPoint.sol getUserOpHash
// ─────────────────────────────────────────────────────────────────────

/** EntryPoint v0.8 — same address on every EVM (CREATE2 deterministic). */
export const ENTRYPOINT_V08: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

/** Solidity execute(address,uint256,bytes) selector. */
export const EXECUTE_SELECTOR: Hex = "0xb61d27f6";
/** Solidity executeBatch(address[],uint256[],bytes[]) selector. */
export const EXECUTE_BATCH_SELECTOR: Hex = "0x47e1da2a";

export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;       // 32 bytes — verificationGasLimit (16) || callGasLimit (16)
  preVerificationGas: bigint;
  gasFees: Hex;                // 32 bytes — maxPriorityFeePerGas (16) || maxFeePerGas (16)
  paymasterAndData: Hex;
  signature: Hex;
}

export interface UserOpFields {
  sender: Address;
  nonce: bigint;
  initCode?: Hex;
  callData: Hex;
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  paymasterAndData?: Hex;
  signature?: Hex;
}

/** Pack two uint128s into a single bytes32 (high << 128 | low). */
function packUint128Pair(high: bigint, low: bigint): Hex {
  const MAX = (1n << 128n) - 1n;
  if (high > MAX || low > MAX) throw new Error("packUint128Pair: value exceeds uint128 max");
  const packed = (high << 128n) | low;
  return ("0x" + packed.toString(16).padStart(64, "0")) as Hex;
}

/**
 * Build a PackedUserOperation v0.8 with sane CoFHE defaults.
 *
 * CoFHE precompile breaks gas estimation, so we ALWAYS use a manual
 * verificationGasLimit + callGasLimit floor (5M each) to guarantee
 * the UserOp doesn't OOG inside an FHE.* call. preVerificationGas
 * stays at the protocol minimum.
 */
export function buildUserOp(fields: UserOpFields): PackedUserOperation {
  // Defaults sized to fit the BlankPaymaster's typical deposit (~0.005-0.02 ETH).
  // EntryPoint reserves `(verifGas + callGas + preVerif + pmVerif + pmPostOp) ×
  // maxFeePerGas` upfront from the paymaster, so total gas cap × max fee must
  // stay within deposit. With 2M+2M+100k+200k+100k = 4.4M gas at 1 gwei =
  // 0.0044 ETH per UserOp — fits 1+ ops in a 0.005 ETH deposit.
  //
  // Heavier ops (FHE encrypt/decrypt inside the inner call) should pass
  // larger callGasLimit explicitly. Most simple calls (approve, transfer,
  // shield) finish in <500k actual gas.
  const verificationGasLimit = fields.verificationGasLimit ?? 2_000_000n;
  const callGasLimit = fields.callGasLimit ?? 2_000_000n;
  const maxPriorityFeePerGas = fields.maxPriorityFeePerGas ?? 100_000_000n;   // 0.1 gwei
  const maxFeePerGas = fields.maxFeePerGas ?? 1_000_000_000n;                 // 1 gwei

  return {
    sender: fields.sender,
    nonce: fields.nonce,
    initCode: fields.initCode ?? "0x",
    callData: fields.callData,
    accountGasLimits: packUint128Pair(verificationGasLimit, callGasLimit),
    preVerificationGas: fields.preVerificationGas ?? 100_000n,
    gasFees: packUint128Pair(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: fields.paymasterAndData ?? "0x",
    signature: fields.signature ?? "0x",
  };
}

/**
 * Encode BlankAccount.execute(target, value, data) calldata.
 * This is the standard ERC-4337 single-call wrapper — for batches use
 * BlankAccount.executeBatch with a different selector.
 */
export function encodeExecuteCall(target: Address, value: bigint, data: Hex): Hex {
  // execute(address target, uint256 value, bytes data)
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [target, value, data],
  );
  return (EXECUTE_SELECTOR + args.slice(2)) as Hex;
}

/**
 * Encode BlankAccount.executeBatch(targets, values, datas) calldata.
 * Used to bundle approve+send (or any multi-call sequence) into a single
 * UserOp = single passphrase prompt for the user.
 */
export function encodeExecuteBatchCall(
  targets: readonly Address[],
  values: readonly bigint[],
  datas: readonly Hex[],
): Hex {
  if (targets.length !== values.length || targets.length !== datas.length) {
    throw new Error("encodeExecuteBatchCall: array length mismatch");
  }
  const args = encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }],
    [targets, values, datas],
  );
  return (EXECUTE_BATCH_SELECTOR + args.slice(2)) as Hex;
}

/**
 * Encode BlankAccountFactory.createAccount(x, y, recovery, salt) for
 * the initCode field. EntryPoint executes initCode = factory(20 bytes)
 * + calldata for the factory's createAccount call.
 */
export function encodeFactoryInitCode(
  factory: Address,
  ownerX: Hex,
  ownerY: Hex,
  recoveryModule: Address,
  salt: bigint,
): Hex {
  // createAccount(uint256 x, uint256 y, address recoveryModule, uint256 salt)
  // Correct selector computed from keccak256("createAccount(uint256,uint256,address,uint256)")[0:4].
  // The previous value (0x12cd5db8) did not match any function in the deployed
  // factory bytecode, so SenderCreator's low-level call returned empty, making
  // EntryPoint revert with AA13 "initCode failed or OOG" on every first-time
  // UserOp. This only surfaced against fresh passkeys on prod — dev tests
  // happened to reuse passkeys whose counterfactual was already deployed, so
  // the initCode path was never exercised.
  const selector = "0x20b66d7f" as Hex;
  const args = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [BigInt(ownerX), BigInt(ownerY), recoveryModule, salt],
  );
  return encodePacked(["address", "bytes"], [factory, (selector + args.slice(2)) as Hex]);
}

/**
 * BlankPaymaster is a verifying paymaster. paymasterAndData is
 *   paymaster(20) | verificationGas(16) | postOpGas(16)
 *   | validUntil(6) | validAfter(6) | signature(65)    = 129 bytes
 * and the signature comes from the backend (/api/paymaster/sponsor), which
 * also picks gasFees under the paymaster's caps. The passkey must sign the
 * userOpHash only after both are in the op: v0.8 hashes paymasterAndData.
 */
export const BLANK_PAYMASTER_DATA_LENGTH = 129;

export interface SponsorAccountClaim {
  /** Passkey pubkey the account was CREATED with (CREATE2 input). */
  ownerX: Hex;
  ownerY: Hex;
  recoveryModule?: Address;
  salt?: bigint;
}

export interface Sponsorship {
  paymasterAndData: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  validUntil: number;
}

/** Thrown when the sponsor refuses. `code` mirrors the server's SponsorErrorCode. */
export class SponsorshipError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = "SponsorshipError";
  }
}

/** Decode the three fields a verifying paymasterAndData carries. */
export function decodeBlankPaymasterData(pmd: Hex): {
  paymaster: Address;
  verificationGasLimit: bigint;
  postOpGasLimit: bigint;
  validUntil: number;
  validAfter: number;
  signature: Hex;
} {
  const hex = pmd.slice(2);
  if (hex.length !== BLANK_PAYMASTER_DATA_LENGTH * 2) {
    throw new Error(`paymasterAndData must be ${BLANK_PAYMASTER_DATA_LENGTH} bytes`);
  }
  return {
    paymaster: ("0x" + hex.slice(0, 40)) as Address,
    verificationGasLimit: BigInt("0x" + hex.slice(40, 72)),
    postOpGasLimit: BigInt("0x" + hex.slice(72, 104)),
    validUntil: Number(BigInt("0x" + hex.slice(104, 116))),
    validAfter: Number(BigInt("0x" + hex.slice(116, 128))),
    signature: ("0x" + hex.slice(128)) as Hex,
  };
}

/**
 * Ask the backend to sponsor `userOp`. The op's signature and
 * paymasterAndData are ignored by the server; everything else is signed
 * over, so build the op completely (nonce, initCode, callData, gas limits)
 * before calling.
 */
export async function requestSponsorship(args: {
  chainId: number;
  userOp: PackedUserOperation;
  account?: SponsorAccountClaim;
  fetchImpl?: typeof fetch;
}): Promise<Sponsorship> {
  const f = args.fetchImpl ?? fetch;
  const res = await f("/api/paymaster/sponsor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chainId: args.chainId,
      userOp: serializeUserOp({ ...args.userOp, paymasterAndData: "0x", signature: "0x" }),
      account: args.account
        ? {
            ownerX: BigInt(args.account.ownerX).toString(),
            ownerY: BigInt(args.account.ownerY).toString(),
            recoveryModule: args.account.recoveryModule,
            salt: (args.account.salt ?? 0n).toString(),
          }
        : undefined,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new SponsorshipError(
      typeof body.error === "string" ? `Gas sponsorship refused: ${body.error}` : `sponsor HTTP ${res.status}`,
      typeof body.code === "string" ? body.code : "HTTP_ERROR",
      res.status,
    );
  }
  const pmd = body.paymasterAndData;
  if (typeof pmd !== "string" || (pmd.length - 2) / 2 !== BLANK_PAYMASTER_DATA_LENGTH) {
    throw new SponsorshipError("sponsor returned malformed paymasterAndData", "BAD_RESPONSE", 502);
  }
  return {
    paymasterAndData: pmd as Hex,
    maxFeePerGas: BigInt(body.maxFeePerGas as string),
    maxPriorityFeePerGas: BigInt(body.maxPriorityFeePerGas as string),
    validUntil: Number(body.validUntil),
  };
}

/** Put a sponsorship into the op: paymasterAndData plus the fees it was signed with. */
export function applySponsorship(userOp: PackedUserOperation, s: Sponsorship): PackedUserOperation {
  return {
    ...userOp,
    gasFees: packUint128Pair(s.maxPriorityFeePerGas, s.maxFeePerGas),
    paymasterAndData: s.paymasterAndData,
  };
}

/** True when any call in this BlankAccount callData targets the account itself.
 *  The paymaster never sponsors those (upgrade, enableValidator, recovery module). */
export function callDataTargetsSelf(callData: Hex, account: Address): boolean {
  const sel = callData.slice(0, 10).toLowerCase();
  const self = account.toLowerCase();
  if (sel === EXECUTE_SELECTOR) {
    return ("0x" + callData.slice(10 + 24, 10 + 64)).toLowerCase() === self;
  }
  if (sel === EXECUTE_BATCH_SELECTOR) {
    const body = callData.slice(10);
    const word = (i: number) => body.slice(i * 64, i * 64 + 64);
    const offset = Number(BigInt("0x" + word(0))) / 32;
    const n = Number(BigInt("0x" + word(offset)));
    for (let i = 0; i < n && i < 64; i++) {
      if (("0x" + word(offset + 1 + i).slice(24)).toLowerCase() === self) return true;
    }
  }
  return false;
}

/**
 * Encode the BlankAccount signature field — abi.encode(uint256 r, uint256 s).
 * This is what _validateSignature decodes to verify the P-256 sig.
 */
export function encodeP256Signature(r: Hex, s: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [BigInt(r), BigInt(s)],
  );
}

/** EntryPoint ABI subset we need on the client side. */
export const ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "getUserOpHash",
    inputs: [
      {
        type: "tuple",
        name: "userOp",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getNonce",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
    stateMutability: "view",
  },
  // EntryPoint StakeManager — `balanceOf` returns the deposit (ETH that
  // funds gas pre-payment) for an account. Used by:
  //   • `usePaymasterHealth` to detect when BlankPaymaster is running low
  //   • Operations alerting cron (server-side) for proactive top-ups
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Compute the userOpHash by calling entryPoint.getUserOpHash on-chain.
 * Free read — gives us the exact hash EntryPoint will check against.
 */
export async function computeUserOpHash(
  publicClient: PublicClient,
  userOp: PackedUserOperation,
  entryPoint: Address = ENTRYPOINT_V08,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: ENTRYPOINT_ABI,
    functionName: "getUserOpHash",
    args: [userOp],
  })) as Hex;
}

/** Read the next nonce for a smart account from the EntryPoint.
 *
 *  Bypasses viem's default 4s eth_call cache by reading at the explicit
 *  "pending" block tag. Without this, back-to-back UserOps within the
 *  4-second cache window read the same pre-tx nonce and the second
 *  submission gets AA25 (invalid account nonce) at EntryPoint. This
 *  was the actual root cause of the P5/P6/P8 wave-4 failures that the
 *  paymaster + retry + poll fixes only masked. */
export async function getNextNonce(
  publicClient: PublicClient,
  sender: Address,
  key: bigint = 0n,
  entryPoint: Address = ENTRYPOINT_V08,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: ENTRYPOINT_ABI,
    functionName: "getNonce",
    args: [sender, key],
    blockTag: "pending",
  })) as bigint;
}

/**
 * Serialize a PackedUserOperation for HTTP transport (BigInts → strings,
 * everything else stays as-is). The server reverses this with deserialize.
 */
export function serializeUserOp(userOp: PackedUserOperation): Record<string, string> {
  return {
    sender: userOp.sender,
    nonce: userOp.nonce.toString(),
    initCode: userOp.initCode,
    callData: userOp.callData,
    accountGasLimits: userOp.accountGasLimits,
    preVerificationGas: userOp.preVerificationGas.toString(),
    gasFees: userOp.gasFees,
    paymasterAndData: userOp.paymasterAndData,
    signature: userOp.signature,
  };
}
