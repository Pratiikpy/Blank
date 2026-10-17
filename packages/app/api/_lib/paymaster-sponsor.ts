/**
 * Verifying-paymaster sponsorship for BlankAccount UserOps.
 *
 * BlankPaymaster only sponsors a UserOp that carries a signature from its
 * `verifyingSigner` over `getHash(userOp, validUntil, validAfter)`. This
 * module is the only holder of that key (env BLANK_PAYMASTER_SIGNER_PK). It
 * signs only after it has checked, against live chain state, everything the
 * contract will check plus one thing the contract cannot:
 *
 *   - the sender is the CREATE2 address the approved factory derives for a
 *     passkey (factory.getAddress(x, y, recovery, salt) == sender). The
 *     contract's code-hash check alone accepts any ERC1967 proxy, including
 *     one pointing at an attacker's implementation.
 *   - gas prices and maxCost sit under the paymaster's caps. The fee is
 *     chosen here, from the network base fee, so the op lands under them.
 *   - every call target is on the paymaster's allowlist, decoded exactly the
 *     way BlankPaymaster._checkTargets decodes it. A call into the sender
 *     itself must pass the _checkSelfCall mirror (checkSelfCall below).
 *   - the sender is not flagged for an unpaid fee, is whitelisted when the
 *     whitelist is on, and is not inside its sponsor interval.
 *
 * Returns paymasterAndData =
 *   paymaster(20) | pmVerificationGas(16) | pmPostOpGas(16)
 *   | validUntil(6) | validAfter(6) | signature(65)
 * plus the gas fees it was signed with. The caller must put both into the
 * UserOp unchanged, and only then compute the userOpHash for the passkey:
 * in EntryPoint v0.8 paymasterAndData is part of that hash.
 */

import { ethers } from "ethers";

export const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const EXECUTE_SELECTOR = "0xb61d27f6";
const EXECUTE_BATCH_SELECTOR = "0x47e1da2a";
const CREATE_ACCOUNT_SELECTOR = "0x20b66d7f";

/** Gas the paymaster's own validation and postOp may use. Signed into the hash. */
export const PM_VERIFICATION_GAS = 150_000n;
export const PM_POSTOP_GAS = 120_000n;
/** How long a sponsorship signature stays valid. */
export const SPONSOR_VALIDITY_SECONDS = 600;
const MAX_BATCH_TARGETS = 20;
const UINT128_MAX = (1n << 128n) - 1n;

export interface SerializedUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  paymasterAndData?: string;
  signature?: string;
}

/** Init parameters the client claims for its account (its passkey pubkey). */
export interface AccountInitClaim {
  ownerX: string;
  ownerY: string;
  recoveryModule?: string;
  salt?: string;
}

export interface SponsorRequest {
  chainId: number;
  userOp: SerializedUserOp;
  account?: AccountInitClaim;
  /** Extra ceiling on maxFeePerGas (the cron passes the session scope's cap). */
  maxFeePerGasCeiling?: bigint;
}

export interface SponsorResult {
  paymaster: string;
  paymasterAndData: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gasFees: string;
  paymasterVerificationGasLimit: string;
  paymasterPostOpGasLimit: string;
  validUntil: number;
  validAfter: number;
}

export type SponsorErrorCode =
  | "BAD_REQUEST"
  | "NOT_CONFIGURED"
  | "NOT_BLANK_ACCOUNT"
  | "SELF_CALL"
  | "TARGET_NOT_APPROVED"
  | "GAS_OVER_CAP"
  | "FEE_DEFAULTED"
  | "NOT_WHITELISTED"
  | "RATE_LIMITED"
  | "FEE_UNPAYABLE";

export class SponsorError extends Error {
  constructor(
    public readonly code: SponsorErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SponsorError";
  }
}

/** Every chain read the sponsor needs. The ethers implementation is below;
 *  tests pass a fake. */
export interface SponsorChain {
  chainId: number;
  paymaster: string;
  now(): Promise<number>;
  baseFeePerGas(): Promise<bigint>;
  maxPriorityFeePerGas(): Promise<bigint>;
  getCode(address: string): Promise<string>;
  paymasterConfig(sender: string): Promise<PaymasterConfig>;
  isApprovedTarget(target: string): Promise<boolean>;
  isApprovedSelfAdmin(kind: SelfAdminKind, address: string): Promise<boolean>;
  factoryGetAddress(factory: string, x: bigint, y: bigint, recovery: string, salt: bigint): Promise<string>;
  accountOwner(account: string): Promise<{ x: bigint; y: bigint } | null>;
  paymasterGetHash(op: PackedOp, validUntil: number, validAfter: number): Promise<string>;
  feeTokenState(sender: string, maxCost: bigint): Promise<{ fee: bigint; balance: bigint; allowance: bigint }>;
}

export interface PaymasterConfig {
  verifyingSigner: string;
  approvedFactory: string;
  accountCodeHash: string;
  maxFeePerGasCap: bigint;
  maxPriorityFeePerGasCap: bigint;
  maxCostCap: bigint;
  approvedTargetsCount: bigint;
  whitelistEnabled: boolean;
  whitelisted: boolean;
  feeDefaulted: boolean;
  feeTokenPerEth: bigint;
  minSponsorInterval: number;
  lastSponsoredAt: number;
}

export interface PackedOp {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: bigint;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
}

// ─── Pure helpers ──────────────────────────────────────────────────────

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);
const isWord = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export function pack128(high: bigint, low: bigint): string {
  if (high < 0n || low < 0n || high > UINT128_MAX || low > UINT128_MAX) {
    throw new Error("pack128: value out of uint128 range");
  }
  return "0x" + high.toString(16).padStart(32, "0") + low.toString(16).padStart(32, "0");
}

export function unpack128(word: string): [bigint, bigint] {
  const v = BigInt(word);
  return [v >> 128n, v & UINT128_MAX];
}

/** paymaster(20) | verificationGas(16) | postOpGas(16): the part getHash covers. */
export function paymasterPrefix(paymaster: string, verificationGas: bigint, postOpGas: bigint): string {
  return ethers.solidityPacked(["address", "uint128", "uint128"], [paymaster, verificationGas, postOpGas]);
}

/** Mirror of BlankPaymaster.getHash. Checked against the contract on every
 *  sponsorship, so any drift between the two refuses instead of signing. */
export function computePaymasterHash(
  op: PackedOp,
  chainId: number,
  paymaster: string,
  validUntil: number,
  validAfter: number,
): string {
  const pmd = ethers.getBytes(op.paymasterAndData);
  if (pmd.length < 52) throw new Error("paymasterAndData shorter than the 52-byte prefix");
  const gasWord = BigInt(ethers.hexlify(pmd.slice(20, 52)));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "address", "uint256", "bytes32", "bytes32", "bytes32", "uint256",
        "uint256", "bytes32", "uint256", "address", "uint48", "uint48",
      ],
      [
        op.sender,
        op.nonce,
        ethers.keccak256(op.initCode),
        ethers.keccak256(op.callData),
        op.accountGasLimits,
        gasWord,
        op.preVerificationGas,
        op.gasFees,
        chainId,
        paymaster,
        validUntil,
        validAfter,
      ],
    ),
  );
}

/** Decode the call targets exactly as BlankPaymaster._checkTargets does. */
export function decodeCallTargets(callData: string): string[] {
  const data = ethers.getBytes(callData);
  if (data.length < 4) throw new SponsorError("BAD_REQUEST", "callData is empty", 400);
  const selector = ethers.hexlify(data.slice(0, 4)).toLowerCase();
  const word = (at: number) => BigInt(ethers.hexlify(data.slice(at, at + 32)));
  if (selector === EXECUTE_SELECTOR) {
    if (data.length < 36) throw new SponsorError("BAD_REQUEST", "malformed execute callData", 400);
    return [ethers.getAddress(ethers.hexlify(data.slice(16, 36)))];
  }
  if (selector === EXECUTE_BATCH_SELECTOR) {
    if (data.length < 100) throw new SponsorError("BAD_REQUEST", "malformed executeBatch callData", 400);
    if (word(4) !== 0x60n) throw new SponsorError("BAD_REQUEST", "non-canonical executeBatch encoding", 400);
    const lenAt = 4 + 0x60;
    if (data.length < lenAt + 32) throw new SponsorError("BAD_REQUEST", "truncated executeBatch callData", 400);
    const n = word(lenAt);
    if (n === 0n || n > BigInt(MAX_BATCH_TARGETS)) {
      throw new SponsorError("BAD_REQUEST", `executeBatch must have 1 to ${MAX_BATCH_TARGETS} calls`, 400);
    }
    const count = Number(n);
    if (data.length < lenAt + 32 + count * 32) throw new SponsorError("BAD_REQUEST", "executeBatch targets truncated", 400);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const slot = lenAt + 32 + i * 32;
      out.push(ethers.getAddress(ethers.hexlify(data.slice(slot + 12, slot + 32))));
    }
    return out;
  }
  throw new SponsorError("BAD_REQUEST", `only execute / executeBatch are sponsored, got ${selector}`, 400);
}

export interface DecodedCall {
  target: string;
  value: bigint;
  data: string;
}

const accountCallsIface = new ethers.Interface([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas)",
]);

/** Every (target, value, data) the account will run. Targets come from
 *  decodeCallTargets (the contract's byte-level view); value and data from a
 *  full ABI decode, which is what the account and the paymaster's
 *  _checkSelfCall decode. */
export function decodeCalls(callData: string): DecodedCall[] {
  const targets = decodeCallTargets(callData);
  const selector = callData.slice(0, 10).toLowerCase();
  let decoded: ethers.Result;
  try {
    decoded = accountCallsIface.decodeFunctionData(selector === EXECUTE_SELECTOR ? "execute" : "executeBatch", callData);
  } catch {
    throw new SponsorError("BAD_REQUEST", "callData does not ABI-decode", 400);
  }
  if (selector === EXECUTE_SELECTOR) {
    return [{ target: targets[0], value: decoded[1] as bigint, data: (decoded[2] as string).toLowerCase() }];
  }
  const values = decoded[1] as bigint[];
  const datas = decoded[2] as string[];
  if (values.length !== targets.length || datas.length !== targets.length) {
    throw new SponsorError("BAD_REQUEST", "executeBatch arrays differ in length", 400);
  }
  return targets.map((target, i) => ({ target, value: values[i], data: datas[i].toLowerCase() }));
}

export const UPGRADE_TO_AND_CALL_SELECTOR = ethers.id("upgradeToAndCall(address,bytes)").slice(0, 10);
export const ENABLE_VALIDATOR_SELECTOR = ethers.id("enableValidator(address)").slice(0, 10);
export const SET_RECOVERY_MODULE_SELECTOR = ethers.id("setRecoveryModule(address)").slice(0, 10);

export type SelfAdminKind = "implementation" | "validator" | "recoveryModule";

/** First argument word as an address; refuses dirty high bits like the contract. */
function firstArgAddress(data: string): string {
  const word = data.slice(10, 74);
  if (!/^0{24}/.test(word)) throw new SponsorError("SELF_CALL", "malformed account settings call", 403);
  return ethers.getAddress("0x" + word.slice(24));
}

/**
 * Mirror of BlankPaymaster._checkSelfCall. A call into the account itself is
 * signed only when it is one of:
 *   upgradeToAndCall(impl, "")  impl approved, no init data
 *   enableValidator(v)          v approved
 *   setRecoveryModule(m)        m approved
 * with value 0 and canonical encoding. Everything else (setOwner,
 * withdrawGasDepositTo, disableValidator, nested execute) is refused.
 */
export async function checkSelfCall(chain: SponsorChain, value: bigint, data: string): Promise<void> {
  if (value !== 0n) throw new SponsorError("SELF_CALL", "account settings calls must not send ETH", 403);
  const bytes = (data.length - 2) / 2;
  const sel = data.slice(0, 10).toLowerCase();
  let kind: SelfAdminKind;
  if (bytes >= 4 && sel === UPGRADE_TO_AND_CALL_SELECTOR) {
    const tail = data.slice(74);
    if (bytes !== 100 || tail !== (0x40).toString(16).padStart(64, "0") + "0".repeat(64)) {
      throw new SponsorError("SELF_CALL", "an account upgrade is sponsored only with no init data", 403);
    }
    kind = "implementation";
  } else if (bytes >= 4 && sel === ENABLE_VALIDATOR_SELECTOR) {
    if (bytes !== 36) throw new SponsorError("SELF_CALL", "malformed account settings call", 403);
    kind = "validator";
  } else if (bytes >= 4 && sel === SET_RECOVERY_MODULE_SELECTOR) {
    if (bytes !== 36) throw new SponsorError("SELF_CALL", "malformed account settings call", 403);
    kind = "recoveryModule";
  } else {
    throw new SponsorError(
      "SELF_CALL",
      "only the account upgrade, session-key validator and recovery-module changes are sponsored. Pay gas from the account.",
      403,
    );
  }
  const addr = firstArgAddress(data);
  if (!(await chain.isApprovedSelfAdmin(kind, addr))) {
    const what = kind === "implementation" ? "implementation" : kind === "validator" ? "validator" : "recovery module";
    throw new SponsorError("SELF_CALL", `${what} ${addr} is not approved for sponsorship`, 403);
  }
}

/** Parse initCode = factory(20) | createAccount(x, y, recoveryModule, salt). */
export function parseInitCode(initCode: string): {
  factory: string; ownerX: bigint; ownerY: bigint; recoveryModule: string; salt: bigint;
} {
  const bytes = ethers.getBytes(initCode);
  if (bytes.length !== 20 + 4 + 128) {
    throw new SponsorError("NOT_BLANK_ACCOUNT", "initCode is not a BlankAccountFactory.createAccount call", 403);
  }
  const factory = ethers.getAddress(ethers.hexlify(bytes.slice(0, 20)));
  const selector = ethers.hexlify(bytes.slice(20, 24)).toLowerCase();
  if (selector !== CREATE_ACCOUNT_SELECTOR) {
    throw new SponsorError("NOT_BLANK_ACCOUNT", "initCode does not call createAccount", 403);
  }
  const [ownerX, ownerY, recoveryModule, salt] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint256", "address", "uint256"],
    bytes.slice(24),
  );
  return { factory, ownerX, ownerY, recoveryModule, salt };
}

/** EntryPoint v0.8 prefund: every gas limit times maxFeePerGas. */
export function totalGasOf(op: Pick<PackedOp, "accountGasLimits" | "preVerificationGas">, pmVerif: bigint, pmPostOp: bigint): bigint {
  const [verif, call] = unpack128(op.accountGasLimits);
  return verif + call + op.preVerificationGas + pmVerif + pmPostOp;
}

/**
 * Pick gas fees that land under every cap:
 *   priority = min(network tip, priority cap)
 *   maxFee   = min(2 * baseFee + priority, fee cap, maxCostCap / totalGas, ceiling)
 * Refuses when that leaves maxFee below the current base fee, because the op
 * would then cost the relayer more than the EntryPoint pays back.
 */
export function chooseGasFees(args: {
  baseFee: bigint;
  networkPriority: bigint;
  totalGas: bigint;
  maxFeePerGasCap: bigint;
  maxPriorityFeePerGasCap: bigint;
  maxCostCap: bigint;
  ceiling?: bigint;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (args.totalGas <= 0n) throw new SponsorError("BAD_REQUEST", "UserOp has no gas limits", 400);
  let maxFee = 2n * args.baseFee + args.networkPriority;
  if (maxFee > args.maxFeePerGasCap) maxFee = args.maxFeePerGasCap;
  const byCost = args.maxCostCap / args.totalGas;
  if (maxFee > byCost) maxFee = byCost;
  if (args.ceiling !== undefined && maxFee > args.ceiling) maxFee = args.ceiling;
  if (maxFee < args.baseFee || maxFee === 0n) {
    throw new SponsorError(
      "GAS_OVER_CAP",
      `network base fee ${args.baseFee} wei is above what sponsorship allows for ${args.totalGas} gas ` +
        `(max ${maxFee} wei/gas). Lower the gas limits or pay gas from the account.`,
      409,
    );
  }
  let priority = args.networkPriority;
  if (priority > args.maxPriorityFeePerGasCap) priority = args.maxPriorityFeePerGasCap;
  if (priority > maxFee) priority = maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

export function validateSerializedUserOp(op: unknown): PackedOp {
  if (!op || typeof op !== "object") throw new SponsorError("BAD_REQUEST", "userOp missing", 400);
  const o = op as Record<string, unknown>;
  if (typeof o.sender !== "string" || !ethers.isAddress(o.sender)) throw new SponsorError("BAD_REQUEST", "invalid sender", 400);
  let nonce: bigint;
  let preVerificationGas: bigint;
  try {
    nonce = BigInt(o.nonce as string);
    preVerificationGas = BigInt(o.preVerificationGas as string);
  } catch {
    throw new SponsorError("BAD_REQUEST", "nonce / preVerificationGas must be integers", 400);
  }
  if (nonce < 0n || preVerificationGas < 0n) throw new SponsorError("BAD_REQUEST", "negative nonce or gas", 400);
  if (!isHex(o.initCode)) throw new SponsorError("BAD_REQUEST", "initCode must be hex", 400);
  if (!isHex(o.callData) || o.callData.length < 10) throw new SponsorError("BAD_REQUEST", "callData must be hex", 400);
  if (!isWord(o.accountGasLimits)) throw new SponsorError("BAD_REQUEST", "accountGasLimits must be 32-byte hex", 400);
  return {
    sender: ethers.getAddress(o.sender),
    nonce,
    initCode: o.initCode,
    callData: o.callData,
    accountGasLimits: o.accountGasLimits,
    preVerificationGas,
    gasFees: isWord(o.gasFees) ? o.gasFees : pack128(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

// ─── Core ──────────────────────────────────────────────────────────────

export async function sponsorUserOp(
  chain: SponsorChain,
  signer: { address: string; signMessage(message: Uint8Array): Promise<string> },
  req: Omit<SponsorRequest, "chainId">,
): Promise<SponsorResult> {
  const op = validateSerializedUserOp(req.userOp);
  const sender = op.sender;
  const cfg = await chain.paymasterConfig(sender);

  if (cfg.verifyingSigner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new SponsorError(
      "NOT_CONFIGURED",
      `sponsor key ${signer.address} is not the paymaster's verifying signer`,
      503,
    );
  }
  if (cfg.accountCodeHash === ethers.ZeroHash) {
    throw new SponsorError("NOT_CONFIGURED", "paymaster account code hash is unset", 503);
  }
  if (cfg.maxCostCap === 0n || cfg.maxFeePerGasCap === 0n) {
    throw new SponsorError("NOT_CONFIGURED", "paymaster gas caps are unset", 503);
  }
  if (cfg.approvedTargetsCount === 0n) {
    throw new SponsorError("NOT_CONFIGURED", "paymaster has no approved targets", 503);
  }
  if (cfg.feeDefaulted) throw new SponsorError("FEE_DEFAULTED", "this account has an unpaid paymaster fee", 403);
  if (cfg.whitelistEnabled && !cfg.whitelisted) {
    throw new SponsorError("NOT_WHITELISTED", "sponsorship is limited to whitelisted accounts", 403);
  }

  await checkBlankAccount(chain, cfg, op, req.account);

  const calls = decodeCalls(op.callData);
  for (const c of calls) {
    if (c.target.toLowerCase() === sender.toLowerCase()) {
      // Checked even when the allowlist is off: the backend only signs the
      // three adoption steps, never any other change to the account.
      await checkSelfCall(chain, c.value, c.data);
    } else if (!(await chain.isApprovedTarget(c.target))) {
      throw new SponsorError("TARGET_NOT_APPROVED", `target ${c.target} is not on the paymaster allowlist`, 403);
    }
  }

  const now = await chain.now();
  if (cfg.minSponsorInterval > 0 && cfg.lastSponsoredAt > 0) {
    const earliest = cfg.lastSponsoredAt + cfg.minSponsorInterval;
    if (earliest > now) {
      throw new SponsorError("RATE_LIMITED", `next sponsored op allowed in ${earliest - now}s`, 429, earliest - now);
    }
  }

  const totalGas = totalGasOf(op, PM_VERIFICATION_GAS, PM_POSTOP_GAS);
  const [baseFee, networkPriority] = await Promise.all([chain.baseFeePerGas(), chain.maxPriorityFeePerGas()]);
  const fees = chooseGasFees({
    baseFee,
    networkPriority,
    totalGas,
    maxFeePerGasCap: cfg.maxFeePerGasCap,
    maxPriorityFeePerGasCap: cfg.maxPriorityFeePerGasCap,
    maxCostCap: cfg.maxCostCap,
    ceiling: req.maxFeePerGasCeiling,
  });
  const maxCost = totalGas * fees.maxFeePerGas;
  if (maxCost > cfg.maxCostCap) {
    throw new SponsorError("GAS_OVER_CAP", "UserOp maxCost is over the paymaster cap", 409);
  }

  if (cfg.feeTokenPerEth > 0n) {
    const ft = await chain.feeTokenState(sender, maxCost);
    if (ft.fee > 0n && (ft.balance < ft.fee || ft.allowance < ft.fee)) {
      throw new SponsorError(
        "FEE_UNPAYABLE",
        `paymaster fee of ${ft.fee} token units needs balance and allowance on the account`,
        402,
      );
    }
  }

  const gasFees = pack128(fees.maxPriorityFeePerGas, fees.maxFeePerGas);
  const validUntil = now + SPONSOR_VALIDITY_SECONDS;
  const validAfter = 0;
  const prefix = paymasterPrefix(chain.paymaster, PM_VERIFICATION_GAS, PM_POSTOP_GAS);
  const signed: PackedOp = { ...op, gasFees, paymasterAndData: prefix };

  const local = computePaymasterHash(signed, chain.chainId, chain.paymaster, validUntil, validAfter);
  const onChain = await chain.paymasterGetHash(signed, validUntil, validAfter);
  if (local.toLowerCase() !== onChain.toLowerCase()) {
    throw new SponsorError("NOT_CONFIGURED", "paymaster hash layout does not match the deployed contract", 503);
  }

  const signature = await signer.signMessage(ethers.getBytes(onChain));
  const paymasterAndData = ethers.concat([
    prefix,
    ethers.solidityPacked(["uint48", "uint48"], [validUntil, validAfter]),
    signature,
  ]);

  return {
    paymaster: chain.paymaster,
    paymasterAndData,
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    gasFees,
    paymasterVerificationGasLimit: PM_VERIFICATION_GAS.toString(),
    paymasterPostOpGasLimit: PM_POSTOP_GAS.toString(),
    validUntil,
    validAfter,
  };
}

/**
 * The sender must be the factory's CREATE2 address for some passkey.
 *  - First op (initCode set): the factory and keys come from initCode itself.
 *  - Deployed account: try the keys the client claims, then the account's
 *    current owner keys. Accounts whose owner was rotated by recovery keep
 *    their original init keys on the device that bound them.
 * Then the deployed code must match the paymaster's account code hash.
 */
async function checkBlankAccount(
  chain: SponsorChain,
  cfg: PaymasterConfig,
  op: PackedOp,
  claim: AccountInitClaim | undefined,
): Promise<void> {
  const sender = op.sender;
  const code = await chain.getCode(sender);
  const deployed = code !== "0x" && code.length > 2;
  const factory = cfg.approvedFactory;
  if (factory === ethers.ZeroAddress) {
    throw new SponsorError("NOT_CONFIGURED", "paymaster has no approved factory", 503);
  }

  if (op.initCode !== "0x") {
    if (deployed) throw new SponsorError("BAD_REQUEST", "initCode set for an account that is already deployed", 400);
    const init = parseInitCode(op.initCode);
    if (init.factory.toLowerCase() !== factory.toLowerCase()) {
      throw new SponsorError("NOT_BLANK_ACCOUNT", "initCode names a factory the paymaster does not approve", 403);
    }
    const predicted = await chain.factoryGetAddress(factory, init.ownerX, init.ownerY, init.recoveryModule, init.salt);
    if (predicted.toLowerCase() !== sender.toLowerCase()) {
      throw new SponsorError("NOT_BLANK_ACCOUNT", "sender is not the factory address for the initCode keys", 403);
    }
    return;
  }

  if (!deployed) {
    throw new SponsorError("NOT_BLANK_ACCOUNT", "account is not deployed and the op has no initCode", 403);
  }
  if (ethers.keccak256(code).toLowerCase() !== cfg.accountCodeHash.toLowerCase()) {
    throw new SponsorError("NOT_BLANK_ACCOUNT", "sender code is not a BlankAccount proxy", 403);
  }

  const candidates: Array<{ x: bigint; y: bigint; recovery: string; salt: bigint }> = [];
  if (claim) {
    try {
      const recovery = claim.recoveryModule && ethers.isAddress(claim.recoveryModule)
        ? claim.recoveryModule
        : ethers.ZeroAddress;
      candidates.push({
        x: BigInt(claim.ownerX),
        y: BigInt(claim.ownerY),
        recovery,
        salt: claim.salt ? BigInt(claim.salt) : 0n,
      });
    } catch {
      throw new SponsorError("BAD_REQUEST", "account.ownerX / ownerY must be integers", 400);
    }
  }
  const owner = await chain.accountOwner(sender);
  if (owner) candidates.push({ x: owner.x, y: owner.y, recovery: ethers.ZeroAddress, salt: 0n });

  for (const c of candidates) {
    const predicted = await chain.factoryGetAddress(factory, c.x, c.y, c.recovery, c.salt);
    if (predicted.toLowerCase() === sender.toLowerCase()) return;
  }
  throw new SponsorError(
    "NOT_BLANK_ACCOUNT",
    "sender is not the approved factory's address for any of the supplied passkey keys",
    403,
  );
}

// ─── ethers-backed chain + signer ──────────────────────────────────────

const PAYMASTER_ABI = [
  "function verifyingSigner() view returns (address)",
  "function approvedFactory() view returns (address)",
  "function accountCodeHash() view returns (bytes32)",
  "function maxFeePerGasCap() view returns (uint256)",
  "function maxPriorityFeePerGasCap() view returns (uint256)",
  "function maxCostCap() view returns (uint256)",
  "function approvedTargetsCount() view returns (uint256)",
  "function approvedTargets(address) view returns (bool)",
  "function approvedImplementations(address) view returns (bool)",
  "function approvedValidators(address) view returns (bool)",
  "function approvedRecoveryModules(address) view returns (bool)",
  "function whitelistEnabled() view returns (bool)",
  "function whitelisted(address) view returns (bool)",
  "function feeDefaulted(address) view returns (bool)",
  "function feeTokenPerEth() view returns (uint256)",
  "function minSponsorInterval() view returns (uint48)",
  "function lastSponsoredAt(address) view returns (uint48)",
  "function feeToken() view returns (address)",
  "function quoteFee(uint256) view returns (uint256)",
  "function getHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
];
const FACTORY_ABI = [
  "function getAddress(uint256 ownerX, uint256 ownerY, address recoveryModule, uint256 salt) view returns (address)",
];
const ACCOUNT_ABI = [
  "function ownerX() view returns (uint256)",
  "function ownerY() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

export function ethersSponsorChain(
  provider: ethers.JsonRpcProvider,
  chainId: number,
  paymaster: string,
): SponsorChain {
  const pm = new ethers.Contract(paymaster, PAYMASTER_ABI, provider);
  return {
    chainId,
    paymaster: ethers.getAddress(paymaster),
    async now() {
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("no latest block");
      return Number(block.timestamp);
    },
    async baseFeePerGas() {
      const block = await provider.getBlock("latest");
      return block?.baseFeePerGas ?? 0n;
    },
    async maxPriorityFeePerGas() {
      try {
        const hex = (await provider.send("eth_maxPriorityFeePerGas", [])) as string;
        return BigInt(hex);
      } catch {
        return 1_000_000n; // 0.001 gwei, testnet L2 floor
      }
    },
    getCode: (address) => provider.getCode(address),
    async paymasterConfig(sender) {
      const [
        verifyingSigner, approvedFactory, accountCodeHash, maxFeePerGasCap, maxPriorityFeePerGasCap,
        maxCostCap, approvedTargetsCount, whitelistEnabled, whitelisted, feeDefaulted, feeTokenPerEth,
        minSponsorInterval, lastSponsoredAt,
      ] = await Promise.all([
        pm.verifyingSigner(), pm.approvedFactory(), pm.accountCodeHash(), pm.maxFeePerGasCap(),
        pm.maxPriorityFeePerGasCap(), pm.maxCostCap(), pm.approvedTargetsCount(), pm.whitelistEnabled(),
        pm.whitelisted(sender), pm.feeDefaulted(sender), pm.feeTokenPerEth(), pm.minSponsorInterval(),
        pm.lastSponsoredAt(sender),
      ]);
      return {
        verifyingSigner, approvedFactory, accountCodeHash,
        maxFeePerGasCap, maxPriorityFeePerGasCap, maxCostCap, approvedTargetsCount,
        whitelistEnabled, whitelisted, feeDefaulted, feeTokenPerEth,
        minSponsorInterval: Number(minSponsorInterval),
        lastSponsoredAt: Number(lastSponsoredAt),
      };
    },
    isApprovedTarget: (target) => pm.approvedTargets(target) as Promise<boolean>,
    async isApprovedSelfAdmin(kind, address) {
      try {
        if (kind === "implementation") return (await pm.approvedImplementations(address)) as boolean;
        if (kind === "validator") return (await pm.approvedValidators(address)) as boolean;
        return (await pm.approvedRecoveryModules(address)) as boolean;
      } catch {
        // A paymaster deployed before self-call approvals has no such view.
        return false;
      }
    },
    async factoryGetAddress(factory, x, y, recovery, salt) {
      const f = new ethers.Contract(factory, FACTORY_ABI, provider);
      // Contract#getAddress() is ethers' own "address of this contract";
      // name the factory function explicitly.
      return (await f.getFunction("getAddress(uint256,uint256,address,uint256)")(x, y, recovery, salt)) as string;
    },
    async accountOwner(account) {
      try {
        const a = new ethers.Contract(account, ACCOUNT_ABI, provider);
        const [x, y] = await Promise.all([a.ownerX(), a.ownerY()]);
        return { x: x as bigint, y: y as bigint };
      } catch {
        return null;
      }
    },
    async paymasterGetHash(op, validUntil, validAfter) {
      return (await pm.getHash(op, validUntil, validAfter)) as string;
    },
    async feeTokenState(sender, maxCost) {
      const [fee, token] = await Promise.all([pm.quoteFee(maxCost), pm.feeToken()]);
      const erc = new ethers.Contract(token, ERC20_ABI, provider);
      const [balance, allowance] = await Promise.all([erc.balanceOf(sender), erc.allowance(sender, paymaster)]);
      return { fee, balance, allowance };
    },
  };
}

/** The verifying-signer key. Throws NOT_CONFIGURED when the env var is missing or malformed. */
export function loadSponsorSigner(): ethers.Wallet {
  const pk = process.env.BLANK_PAYMASTER_SIGNER_PK?.trim();
  if (!pk) throw new SponsorError("NOT_CONFIGURED", "BLANK_PAYMASTER_SIGNER_PK is not set", 503);
  try {
    return new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  } catch {
    throw new SponsorError("NOT_CONFIGURED", "BLANK_PAYMASTER_SIGNER_PK is not a valid private key", 503);
  }
}

export const SPONSOR_RPC_URLS: Record<number, string[]> = {
  11155111: [process.env.SEPOLIA_RPC_URL, "https://ethereum-sepolia-rpc.publicnode.com"].filter(
    (u): u is string => !!u,
  ),
  84532: [process.env.BASE_SEPOLIA_RPC_URL, "https://base-sepolia-rpc.publicnode.com"].filter(
    (u): u is string => !!u,
  ),
  421614: [process.env.ARB_SEPOLIA_RPC_URL, "https://sepolia-rollup.arbitrum.io/rpc"].filter(
    (u): u is string => !!u,
  ),
};
