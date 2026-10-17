// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  sponsorUserOp,
  computePaymasterHash,
  chooseGasFees,
  decodeCallTargets,
  parseInitCode,
  pack128,
  unpack128,
  paymasterPrefix,
  SponsorError,
  PM_VERIFICATION_GAS,
  PM_POSTOP_GAS,
  SPONSOR_VALIDITY_SECONDS,
  type SponsorChain,
  type PaymasterConfig,
  type PackedOp,
} from "./paymaster-sponsor.js";

// The verifying-paymaster sponsor. Every check BlankPaymaster makes on-chain
// is mirrored here so a bad op is refused before the backend key signs it,
// plus the one check the contract cannot make: the sender must be the
// factory's CREATE2 address for a passkey. Hash parity with the deployed
// contract was verified separately against a hardhat BlankPaymaster
// (computePaymasterHash == getHash, and a sponsored op landed via handleOps).

const SIGNER = new ethers.Wallet("0x" + "11".repeat(32));
const PAYMASTER = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000fa";
const SENDER = ethers.getAddress("0x" + "5e".repeat(20));
const TARGET = ethers.getAddress("0x" + "7a".repeat(20));
const OTHER = ethers.getAddress("0x" + "0b".repeat(20));
const CODE = "0x6080604052";
const CODE_HASH = ethers.keccak256(CODE);
const OWNER_X = 111n;
const OWNER_Y = 222n;
const GWEI = 1_000_000_000n;
const NOW = 1_800_000_000;

const executeIface = new ethers.Interface([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] datas)",
]);
const factoryIface = new ethers.Interface([
  "function createAccount(uint256 ownerX, uint256 ownerY, address recoveryModule, uint256 salt)",
]);
const exec = (to: string) => executeIface.encodeFunctionData("execute", [to, 0n, "0x1234"]);

function baseConfig(over: Partial<PaymasterConfig> = {}): PaymasterConfig {
  return {
    verifyingSigner: SIGNER.address,
    approvedFactory: FACTORY,
    accountCodeHash: CODE_HASH,
    maxFeePerGasCap: 50n * GWEI,
    maxPriorityFeePerGasCap: 5n * GWEI,
    maxCostCap: ethers.parseEther("0.02"),
    approvedTargetsCount: 1n,
    whitelistEnabled: false,
    whitelisted: false,
    feeDefaulted: false,
    feeTokenPerEth: 0n,
    minSponsorInterval: 0,
    lastSponsoredAt: 0,
    ...over,
  };
}

interface FakeState {
  cfg: PaymasterConfig;
  code: Record<string, string>;
  approved: Set<string>;
  baseFee: bigint;
  priority: bigint;
  owner: { x: bigint; y: bigint } | null;
  hashOverride?: string;
  fee?: { fee: bigint; balance: bigint; allowance: bigint };
  selfAdmin: Record<"implementation" | "validator" | "recoveryModule", Set<string>>;
}

const IMPL = ethers.getAddress("0x" + "1e".repeat(20));
const VALIDATOR = ethers.getAddress("0x" + "5a".repeat(20));
const MODULE = ethers.getAddress("0x" + "9d".repeat(20));
const accountIface = new ethers.Interface([
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function enableValidator(address validator)",
  "function disableValidator(address validator)",
  "function setRecoveryModule(address newModule)",
  "function setOwner(uint256 newX, uint256 newY)",
  "function withdrawGasDepositTo(address to, uint256 amount)",
]);
const selfExec = (data: string, value = 0n) => executeIface.encodeFunctionData("execute", [SENDER, value, data]);

let st: FakeState;

function fakeChain(): SponsorChain {
  return {
    chainId: 84532,
    paymaster: PAYMASTER,
    now: async () => NOW,
    baseFeePerGas: async () => st.baseFee,
    maxPriorityFeePerGas: async () => st.priority,
    getCode: async (a) => st.code[a.toLowerCase()] ?? "0x",
    paymasterConfig: async () => st.cfg,
    isApprovedTarget: async (t) => st.approved.has(t.toLowerCase()),
    isApprovedSelfAdmin: async (kind, a) => st.selfAdmin[kind].has(a.toLowerCase()),
    // CREATE2 stand-in: only (OWNER_X, OWNER_Y, 0, 0) derives SENDER.
    factoryGetAddress: async (f, x, y, r, s) =>
      f.toLowerCase() === FACTORY.toLowerCase() && x === OWNER_X && y === OWNER_Y && r === ethers.ZeroAddress && s === 0n
        ? SENDER
        : OTHER,
    accountOwner: async () => st.owner,
    paymasterGetHash: async (op, vu, va) => st.hashOverride ?? computePaymasterHash(op, 84532, PAYMASTER, vu, va),
    feeTokenState: async () => st.fee ?? { fee: 0n, balance: 0n, allowance: 0n },
  };
}

function op(over: Record<string, string> = {}) {
  return {
    sender: SENDER,
    nonce: "3",
    initCode: "0x",
    callData: exec(TARGET),
    accountGasLimits: pack128(2_000_000n, 2_000_000n),
    preVerificationGas: "100000",
    gasFees: pack128(0n, 0n),
    ...over,
  };
}

const claim = { ownerX: OWNER_X.toString(), ownerY: OWNER_Y.toString() };

beforeEach(() => {
  st = {
    cfg: baseConfig(),
    code: { [SENDER.toLowerCase()]: CODE },
    approved: new Set([TARGET.toLowerCase()]),
    baseFee: 1n * GWEI,
    priority: GWEI / 10n,
    owner: null,
    selfAdmin: {
      implementation: new Set([IMPL.toLowerCase()]),
      validator: new Set([VALIDATOR.toLowerCase()]),
      recoveryModule: new Set([MODULE.toLowerCase()]),
    },
  };
});

async function refusal(p: Promise<unknown>): Promise<SponsorError> {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(SponsorError);
  return e as SponsorError;
}

describe("sponsorUserOp — happy path", () => {
  it("returns a 129-byte paymasterAndData whose signature recovers to the verifying signer over getHash", async () => {
    const r = await sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim });
    const pmd = ethers.getBytes(r.paymasterAndData);
    expect(pmd.length).toBe(129);
    expect(ethers.getAddress(ethers.hexlify(pmd.slice(0, 20)))).toBe(ethers.getAddress(PAYMASTER));
    expect(BigInt(ethers.hexlify(pmd.slice(20, 36)))).toBe(PM_VERIFICATION_GAS);
    expect(BigInt(ethers.hexlify(pmd.slice(36, 52)))).toBe(PM_POSTOP_GAS);
    expect(Number(BigInt(ethers.hexlify(pmd.slice(52, 58))))).toBe(NOW + SPONSOR_VALIDITY_SECONDS);
    expect(Number(BigInt(ethers.hexlify(pmd.slice(58, 64))))).toBe(0);

    const signedOp: PackedOp = {
      sender: SENDER, nonce: 3n, initCode: "0x", callData: exec(TARGET),
      accountGasLimits: pack128(2_000_000n, 2_000_000n), preVerificationGas: 100_000n,
      gasFees: r.gasFees, paymasterAndData: r.paymasterAndData, signature: "0x",
    };
    const hash = computePaymasterHash(signedOp, 84532, PAYMASTER, r.validUntil, r.validAfter);
    const sig = ethers.hexlify(pmd.slice(64));
    expect(ethers.verifyMessage(ethers.getBytes(hash), sig)).toBe(SIGNER.address);
  });

  it("gas fees land under every cap and the op's maxCost under maxCostCap", async () => {
    const r = await sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim });
    const maxFee = BigInt(r.maxFeePerGas);
    const prio = BigInt(r.maxPriorityFeePerGas);
    expect(maxFee).toBeLessThanOrEqual(st.cfg.maxFeePerGasCap);
    expect(prio).toBeLessThanOrEqual(st.cfg.maxPriorityFeePerGasCap);
    expect(prio).toBeLessThanOrEqual(maxFee);
    expect(maxFee).toBeGreaterThanOrEqual(st.baseFee);
    const total = 2_000_000n + 2_000_000n + 100_000n + PM_VERIFICATION_GAS + PM_POSTOP_GAS;
    expect(total * maxFee).toBeLessThanOrEqual(st.cfg.maxCostCap);
    expect(unpack128(r.gasFees)).toEqual([prio, maxFee]);
  });

  it("first op: the factory and keys come from initCode itself (no claim needed)", async () => {
    st.code = {};
    const initCode = FACTORY + factoryIface.encodeFunctionData("createAccount", [OWNER_X, OWNER_Y, ethers.ZeroAddress, 0n]).slice(2);
    const r = await sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ initCode }) });
    expect(ethers.getBytes(r.paymasterAndData).length).toBe(129);
  });

  it("deployed account with no claim: falls back to the account's on-chain owner keys", async () => {
    st.owner = { x: OWNER_X, y: OWNER_Y };
    await expect(sponsorUserOp(fakeChain(), SIGNER, { userOp: op() })).resolves.toBeTruthy();
  });

  it("no allowlist configured (approvedTargetsCount = 0) -> nothing is signed, as on-chain", async () => {
    st.cfg = baseConfig({ approvedTargetsCount: 0n });
    st.approved.clear();
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: exec(OTHER) }), account: claim }));
    expect(e.code).toBe("NOT_CONFIGURED");
  });

  it("the three approved account adoption steps are signed (single and batched)", async () => {
    for (const d of [
      accountIface.encodeFunctionData("upgradeToAndCall", [IMPL, "0x"]),
      accountIface.encodeFunctionData("enableValidator", [VALIDATOR]),
      accountIface.encodeFunctionData("setRecoveryModule", [MODULE]),
    ]) {
      await expect(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: selfExec(d) }), account: claim })).resolves.toBeTruthy();
    }
    const batch = executeIface.encodeFunctionData("executeBatch", [
      [SENDER, SENDER, TARGET],
      [0n, 0n, 0n],
      [
        accountIface.encodeFunctionData("enableValidator", [VALIDATOR]),
        accountIface.encodeFunctionData("setRecoveryModule", [MODULE]),
        "0x1234",
      ],
    ]);
    await expect(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: batch }), account: claim })).resolves.toBeTruthy();
  });

  it("maxFeePerGasCeiling (session scope cap) is honoured", async () => {
    const r = await sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim, maxFeePerGasCeiling: 1_500_000_000n });
    expect(BigInt(r.maxFeePerGas)).toBe(1_500_000_000n);
  });
});

describe("sponsorUserOp — refusals (nothing is signed)", () => {
  it("sender is not the factory's CREATE2 address for the claimed keys", async () => {
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: { ownerX: "1", ownerY: "2" } }));
    expect(e.code).toBe("NOT_BLANK_ACCOUNT");
  });

  it("an ERC1967 proxy with the right code hash at a non-factory address is refused (code hash alone is not enough)", async () => {
    st.code[OTHER.toLowerCase()] = CODE;
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ sender: OTHER }), account: claim }));
    expect(e.code).toBe("NOT_BLANK_ACCOUNT");
  });

  it("wrong runtime code", async () => {
    st.code[SENDER.toLowerCase()] = "0xdead";
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("NOT_BLANK_ACCOUNT");
  });

  it("initCode naming another factory", async () => {
    st.code = {};
    const initCode = OTHER + factoryIface.encodeFunctionData("createAccount", [OWNER_X, OWNER_Y, ethers.ZeroAddress, 0n]).slice(2);
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ initCode }) }));
    expect(e.code).toBe("NOT_BLANK_ACCOUNT");
  });

  it("undeployed account without initCode", async () => {
    st.code = {};
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("NOT_BLANK_ACCOUNT");
  });

  it("arbitrary calls into the account itself are refused", async () => {
    const datas = [
      "0x1234",
      accountIface.encodeFunctionData("setOwner", [5n, 6n]),
      accountIface.encodeFunctionData("withdrawGasDepositTo", [OTHER, 1n]),
      accountIface.encodeFunctionData("disableValidator", [VALIDATOR]),
      executeIface.encodeFunctionData("execute", [OTHER, 0n, "0x"]),
      "0x",
    ];
    for (const d of datas) {
      const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: selfExec(d) }), account: claim }));
      expect(e.code).toBe("SELF_CALL");
      expect(e.status).toBe(403);
    }
  });

  it("self-calls with unapproved arguments, init data, value, trailing or dirty bytes are refused", async () => {
    const enable = accountIface.encodeFunctionData("enableValidator", [VALIDATOR]);
    const datas: Array<[string, bigint, RegExp]> = [
      [accountIface.encodeFunctionData("upgradeToAndCall", [OTHER, "0x"]), 0n, /not approved/],
      [accountIface.encodeFunctionData("enableValidator", [OTHER]), 0n, /not approved/],
      [accountIface.encodeFunctionData("setRecoveryModule", [OTHER]), 0n, /not approved/],
      [accountIface.encodeFunctionData("setRecoveryModule", [ethers.ZeroAddress]), 0n, /not approved/],
      [accountIface.encodeFunctionData("upgradeToAndCall", [IMPL, enable]), 0n, /no init data/],
      [accountIface.encodeFunctionData("upgradeToAndCall", [IMPL, "0x"]) + "00", 0n, /no init data/],
      [enable, 1n, /must not send ETH/],
      [enable + "00", 0n, /malformed/],
      [enable.slice(0, 10) + "ff" + enable.slice(12), 0n, /malformed/],
    ];
    for (const [d, v, msg] of datas) {
      const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: selfExec(d, v) }), account: claim }));
      expect(e.code).toBe("SELF_CALL");
      expect(e.message).toMatch(msg);
    }
  });

  it("a bad self-call inside executeBatch is refused", async () => {
    const batch = executeIface.encodeFunctionData("executeBatch", [
      [SENDER, SENDER],
      [0n, 0n],
      [accountIface.encodeFunctionData("enableValidator", [VALIDATOR]), accountIface.encodeFunctionData("setOwner", [1n, 2n])],
    ]);
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: batch }), account: claim }));
    expect(e.code).toBe("SELF_CALL");
  });

  it("target not on the allowlist (single and batch)", async () => {
    let e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: exec(OTHER) }), account: claim }));
    expect(e.code).toBe("TARGET_NOT_APPROVED");
    const batch = executeIface.encodeFunctionData("executeBatch", [[TARGET, OTHER], [0n, 0n], ["0x", "0x"]]);
    e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: batch }), account: claim }));
    expect(e.code).toBe("TARGET_NOT_APPROVED");
  });

  it("selector other than execute / executeBatch", async () => {
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ callData: "0x12345678" + "00".repeat(32) }), account: claim }));
    expect(e.code).toBe("BAD_REQUEST");
  });

  it("network base fee above what the caps allow for this much gas", async () => {
    st.baseFee = 10n * GWEI; // 4.37M gas x 10 gwei = 0.0437 ETH > 0.02 cap
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("GAS_OVER_CAP");
  });

  it("backend key is not the paymaster's verifying signer", async () => {
    const e = await refusal(sponsorUserOp(fakeChain(), ethers.Wallet.createRandom(), { userOp: op(), account: claim }));
    expect(e.code).toBe("NOT_CONFIGURED");
    expect(e.status).toBe(503);
  });

  it("paymaster misconfigured: caps unset / code hash unset / no factory", async () => {
    st.cfg = baseConfig({ maxCostCap: 0n });
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }))).code).toBe("NOT_CONFIGURED");
    st.cfg = baseConfig({ accountCodeHash: ethers.ZeroHash });
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }))).code).toBe("NOT_CONFIGURED");
    st.cfg = baseConfig({ approvedFactory: ethers.ZeroAddress });
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }))).code).toBe("NOT_CONFIGURED");
  });

  it("local hash and the deployed contract's getHash disagree -> refuse instead of signing", async () => {
    st.hashOverride = ethers.ZeroHash;
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("NOT_CONFIGURED");
  });

  it("account flagged for an unpaid fee / not whitelisted", async () => {
    st.cfg = baseConfig({ feeDefaulted: true });
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }))).code).toBe("FEE_DEFAULTED");
    st.cfg = baseConfig({ whitelistEnabled: true, whitelisted: false });
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }))).code).toBe("NOT_WHITELISTED");
  });

  it("inside the per-sender sponsor interval -> 429 with retry-after", async () => {
    st.cfg = baseConfig({ minSponsorInterval: 60, lastSponsoredAt: NOW - 20 });
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.retryAfterSeconds).toBe(40);
  });

  it("fee token configured and the account cannot pay it", async () => {
    st.cfg = baseConfig({ feeTokenPerEth: 3_000_000_000n });
    st.fee = { fee: 500n, balance: 1000n, allowance: 0n };
    const e = await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op(), account: claim }));
    expect(e.code).toBe("FEE_UNPAYABLE");
  });

  it("malformed op fields", async () => {
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ sender: "0x12" }) }))).code).toBe("BAD_REQUEST");
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ accountGasLimits: "0x01" }) }))).code).toBe("BAD_REQUEST");
    expect((await refusal(sponsorUserOp(fakeChain(), SIGNER, { userOp: op({ nonce: "x" }) }))).code).toBe("BAD_REQUEST");
  });
});

describe("decodeCallTargets mirrors BlankPaymaster._checkTargets", () => {
  it("execute -> one target; canonical executeBatch -> all targets", () => {
    expect(decodeCallTargets(exec(TARGET))).toEqual([TARGET]);
    const batch = executeIface.encodeFunctionData("executeBatch", [[TARGET, OTHER], [0n, 0n], ["0x", "0x"]]);
    expect(decodeCallTargets(batch)).toEqual([TARGET, OTHER]);
  });

  it("rejects a non-canonical targets offset (the account would read different targets)", () => {
    const batch = executeIface.encodeFunctionData("executeBatch", [[TARGET], [0n], ["0x"]]);
    const tampered = batch.slice(0, 10) + (0x80).toString(16).padStart(64, "0") + batch.slice(74);
    expect(() => decodeCallTargets(tampered)).toThrow(/non-canonical/);
  });

  it("rejects an empty or oversized batch", () => {
    const empty = executeIface.encodeFunctionData("executeBatch", [[], [], []]);
    expect(() => decodeCallTargets(empty)).toThrow(/1 to 20/);
    const n = 21;
    const big = executeIface.encodeFunctionData("executeBatch", [Array(n).fill(TARGET), Array(n).fill(0n), Array(n).fill("0x")]);
    expect(() => decodeCallTargets(big)).toThrow(/1 to 20/);
  });
});

describe("parseInitCode", () => {
  it("round-trips createAccount(x, y, recovery, salt)", () => {
    const initCode = FACTORY + factoryIface.encodeFunctionData("createAccount", [7n, 8n, OTHER, 9n]).slice(2);
    const p = parseInitCode(initCode);
    expect(p.factory).toBe(ethers.getAddress(FACTORY));
    expect([p.ownerX, p.ownerY, p.recoveryModule, p.salt]).toEqual([7n, 8n, OTHER, 9n]);
  });

  it("rejects a different selector or length", () => {
    expect(() => parseInitCode(FACTORY + "deadbeef" + "00".repeat(128))).toThrow(SponsorError);
    expect(() => parseInitCode(FACTORY + "20b66d7f")).toThrow(SponsorError);
  });
});

describe("chooseGasFees", () => {
  const caps = { maxFeePerGasCap: 50n * GWEI, maxPriorityFeePerGasCap: 5n * GWEI, maxCostCap: ethers.parseEther("0.02") };

  it("2 x baseFee + tip when that fits", () => {
    expect(chooseGasFees({ baseFee: GWEI, networkPriority: GWEI / 10n, totalGas: 1_000_000n, ...caps }))
      .toEqual({ maxFeePerGas: 2n * GWEI + GWEI / 10n, maxPriorityFeePerGas: GWEI / 10n });
  });

  it("clamped by maxCostCap / totalGas", () => {
    const r = chooseGasFees({ baseFee: GWEI, networkPriority: GWEI, totalGas: 10_000_000n, ...caps });
    expect(r.maxFeePerGas).toBe(ethers.parseEther("0.02") / 10_000_000n);
  });

  it("priority clamped to its cap and to maxFee", () => {
    const r = chooseGasFees({ baseFee: 1n, networkPriority: 100n * GWEI, totalGas: 1_000n, ...caps });
    expect(r.maxPriorityFeePerGas).toBe(r.maxFeePerGas < 5n * GWEI ? r.maxFeePerGas : 5n * GWEI);
  });

  it("refuses when the capped fee is below the base fee", () => {
    expect(() => chooseGasFees({ baseFee: 60n * GWEI, networkPriority: 0n, totalGas: 1n, ...caps })).toThrow(SponsorError);
  });
});

describe("computePaymasterHash", () => {
  it("binds chain id, paymaster and the validity window", () => {
    const o: PackedOp = {
      sender: SENDER, nonce: 1n, initCode: "0x", callData: exec(TARGET),
      accountGasLimits: pack128(1n, 2n), preVerificationGas: 3n, gasFees: pack128(4n, 5n),
      paymasterAndData: paymasterPrefix(PAYMASTER, 6n, 7n), signature: "0x",
    };
    const h = computePaymasterHash(o, 1, PAYMASTER, 10, 0);
    expect(computePaymasterHash(o, 2, PAYMASTER, 10, 0)).not.toBe(h);
    expect(computePaymasterHash(o, 1, OTHER, 10, 0)).not.toBe(h);
    expect(computePaymasterHash(o, 1, PAYMASTER, 11, 0)).not.toBe(h);
    expect(computePaymasterHash({ ...o, paymasterAndData: paymasterPrefix(PAYMASTER, 6n, 8n) }, 1, PAYMASTER, 10, 0)).not.toBe(h);
    // The signature bytes after the 52-byte prefix are not hashed.
    expect(computePaymasterHash({ ...o, paymasterAndData: o.paymasterAndData + "ff".repeat(77) }, 1, PAYMASTER, 10, 0)).toBe(h);
  });
});
