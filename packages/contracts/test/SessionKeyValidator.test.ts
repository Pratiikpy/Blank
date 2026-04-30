import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  SessionKeyValidator — Phase 4.1 core
//
//  Scope: validate the validator's logic in isolation. We don't need a
//  real BlankAccount UUPS upgrade to test this — we mimic the AA's call
//  pattern by:
//
//    1. Calling `setScope` from a "fake account" signer (impersonates the
//       AA — the validator treats `msg.sender` as the account regardless
//       of whether it's a real contract).
//    2. Building a `PackedUserOperation` struct with `callData` shaped like
//       BlankAccount.execute(target, value, data) and `signature` shaped
//       like `abi.encode(sessionKey, ecdsaSig)`.
//    3. Calling `validateUserOp` from the same fake-account signer and
//       inspecting the returned validationData.
//
//  Tests cover:
//   • setScope / revokeScope happy paths + every revert
//   • validateUserOp signature failure modes (returns SIG_VALIDATION_FAILED)
//   • validateUserOp scope/parsing reverts (BadSelector, TargetIsAccount,
//     TargetNotRecipient, AmountOverCap, UnsupportedInnerSelector, etc.)
//   • Successful ETH and ERC-20 paths return correct validationData
//   • lastFiredAt advances monotonically across calls (validAfter packing)
// ══════════════════════════════════════════════════════════════════

const SIG_VALIDATION_FAILED = 1n;

// BlankAccount.execute(address,uint256,bytes) selector
const SELECTOR_EXECUTE = "0xb61d27f6";
// IERC20.transfer(address,uint256) selector
const SELECTOR_ERC20_TRANSFER = "0xa9059cbb";

interface PackedUserOp {
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

const ZERO_BYTES32 = "0x" + "00".repeat(32);

function emptyUserOp(sender: string): PackedUserOp {
  return {
    sender,
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: ZERO_BYTES32,
    preVerificationGas: 0n,
    gasFees: ZERO_BYTES32,
    paymasterAndData: "0x",
    signature: "0x",
  };
}

function encodeExecuteCallData(
  target: string,
  value: bigint,
  data: string,
): string {
  const iface = new hre.ethers.Interface([
    "function execute(address target, uint256 value, bytes data)",
  ]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}

function encodeErc20Transfer(to: string, amount: bigint): string {
  const iface = new hre.ethers.Interface([
    "function transfer(address to, uint256 amount)",
  ]);
  return iface.encodeFunctionData("transfer", [to, amount]);
}

async function buildSig(
  sessionKey: hre.ethers.HDNodeWallet | hre.ethers.Wallet,
  userOpHash: string,
): Promise<string> {
  // Sign the userOpHash directly (no EIP-191 prefix) — mirrors what the
  // BlankAccount upgrade will pass to validateUserOp via its mode-prefix
  // dispatch. ECDSA.recover(userOpHash, sig) on the validator side.
  const sig = sessionKey.signingKey.sign(userOpHash).serialized;
  return hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [sessionKey.address, sig],
  );
}

async function fixture() {
  const [deployer, account, recipient, attacker, other] =
    await hre.ethers.getSigners();
  const Validator = await hre.ethers.getContractFactory("SessionKeyValidator");
  const validator = await Validator.deploy();
  await validator.waitForDeployment();

  // Deploy a TestUSDC for ERC-20 path tests.
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const usdc = await TestUSDC.deploy();
  await usdc.waitForDeployment();

  // A pre-derived ECDSA wallet acts as the session key (NOT a hardhat signer
  // — must be a key we control to sign arbitrary digests).
  const sessionKey = hre.ethers.Wallet.createRandom();

  return { deployer, account, recipient, attacker, other, validator, usdc, sessionKey };
}

const FAR_FUTURE: bigint = 4_000_000_000n; // year 2096-ish

describe("SessionKeyValidator — setScope", () => {
  it("stores scope and emits ScopeSet", async () => {
    const { account, recipient, validator } = await loadFixture(fixture);
    const sessionKey = hre.ethers.Wallet.createRandom();

    const tx = validator.connect(account).setScope(sessionKey.address, {
      recipient: recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: hre.ethers.parseEther("0.1"),
      periodSeconds: 86400n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });
    await expect(tx)
      .to.emit(validator, "ScopeSet")
      .withArgs(
        account.address,
        sessionKey.address,
        recipient.address,
        hre.ethers.ZeroAddress,
        hre.ethers.parseEther("0.1"),
        86400,
        FAR_FUTURE,
      );

    const stored = await validator.getScope(account.address, sessionKey.address);
    expect(stored.recipient).to.equal(recipient.address);
    expect(stored.spendToken).to.equal(hre.ethers.ZeroAddress);
    expect(stored.maxAmountPerCall).to.equal(hre.ethers.parseEther("0.1"));
    expect(stored.periodSeconds).to.equal(86400);
    expect(stored.validUntil).to.equal(FAR_FUTURE);
    // After audit fix: lastFiredAt anchors to (block.timestamp - periodSeconds)
    // so the first fire's validAfter is the current block.timestamp itself
    // (allowed immediately, but every subsequent call still respects the
    // real-time period cadence). Anchor is non-zero on any chain past 1970.
    const blk = await hre.ethers.provider.getBlock("latest");
    const expectedAnchor = BigInt(blk!.timestamp) - 86400n;
    expect(stored.lastFiredAt).to.equal(expectedAnchor);
  });

  it("rejects zero session key", async () => {
    const { account, recipient, validator } = await loadFixture(fixture);
    await expect(
      validator.connect(account).setScope(hre.ethers.ZeroAddress, {
        recipient: recipient.address,
        spendToken: hre.ethers.ZeroAddress,
        maxAmountPerCall: 100n,
        periodSeconds: 1n,
        validUntil: FAR_FUTURE,
        lastFiredAt: 0n,
      }),
    ).to.be.revertedWithCustomError(validator, "ZeroSessionKey");
  });

  it("rejects zero recipient, zero period, zero amount, zero validUntil", async () => {
    const { account, validator } = await loadFixture(fixture);
    const sk = hre.ethers.Wallet.createRandom().address;
    const base = {
      recipient: "0x000000000000000000000000000000000000dead",
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: 100n,
      periodSeconds: 1n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    };
    await expect(
      validator.connect(account).setScope(sk, { ...base, recipient: hre.ethers.ZeroAddress }),
    ).to.be.revertedWithCustomError(validator, "ZeroRecipient");
    await expect(
      validator.connect(account).setScope(sk, { ...base, periodSeconds: 0n }),
    ).to.be.revertedWithCustomError(validator, "ZeroPeriod");
    await expect(
      validator.connect(account).setScope(sk, { ...base, maxAmountPerCall: 0n }),
    ).to.be.revertedWithCustomError(validator, "ZeroMaxAmount");
    await expect(
      validator.connect(account).setScope(sk, { ...base, validUntil: 0n }),
    ).to.be.revertedWithCustomError(validator, "InvalidValidUntil");
  });

  it("scope is keyed by msg.sender (one account's scope doesn't leak to another)", async () => {
    const { account, other, recipient, validator } = await loadFixture(fixture);
    const sk = hre.ethers.Wallet.createRandom().address;
    const scope = {
      recipient: recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: 100n,
      periodSeconds: 1n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    };
    await validator.connect(account).setScope(sk, scope);
    expect((await validator.getScope(account.address, sk)).recipient).to.equal(recipient.address);
    expect((await validator.getScope(other.address, sk)).recipient).to.equal(hre.ethers.ZeroAddress);
  });
});

describe("SessionKeyValidator — revokeScope", () => {
  it("deletes scope and emits ScopeRevoked", async () => {
    const { account, recipient, validator } = await loadFixture(fixture);
    const sk = hre.ethers.Wallet.createRandom().address;
    await validator.connect(account).setScope(sk, {
      recipient: recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: 100n,
      periodSeconds: 1n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });
    await expect(validator.connect(account).revokeScope(sk))
      .to.emit(validator, "ScopeRevoked")
      .withArgs(account.address, sk);
    expect((await validator.getScope(account.address, sk)).recipient).to.equal(hre.ethers.ZeroAddress);
  });

  it("reverts when no scope exists", async () => {
    const { account, validator } = await loadFixture(fixture);
    const sk = hre.ethers.Wallet.createRandom().address;
    await expect(validator.connect(account).revokeScope(sk)).to.be.revertedWithCustomError(
      validator,
      "ScopeNotFound",
    );
  });
});

describe("SessionKeyValidator — validateUserOp signature checks", () => {
  it("returns SIG_VALIDATION_FAILED when signature doesn't match registered session key", async () => {
    const { account, recipient, validator, sessionKey } = await loadFixture(fixture);
    await validator.connect(account).setScope(sessionKey.address, {
      recipient: recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: hre.ethers.parseEther("0.1"),
      periodSeconds: 1n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });

    const userOp = emptyUserOp(account.address);
    userOp.callData = encodeExecuteCallData(recipient.address, hre.ethers.parseEther("0.05"), "0x");

    const userOpHash = hre.ethers.keccak256("0xdeadbeef");
    // Encode the REGISTERED session-key address but sign with a DIFFERENT
    // private key — exercises the "recovered != sessionKey" branch (the
    // attack scenario where a thief forges a sig claiming to be the
    // session key holder).
    const thief = hre.ethers.Wallet.createRandom();
    const thiefSig = thief.signingKey.sign(userOpHash).serialized;
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [sessionKey.address, thiefSig],
    );

    const result = await validator.connect(account).validateUserOp.staticCall(userOp, userOpHash);
    expect(result).to.equal(SIG_VALIDATION_FAILED);
  });

  it("returns SIG_VALIDATION_FAILED when signature length is short", async () => {
    const { account, recipient, validator, sessionKey } = await loadFixture(fixture);
    await validator.connect(account).setScope(sessionKey.address, {
      recipient: recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: 100n,
      periodSeconds: 1n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });
    const userOp = emptyUserOp(account.address);
    userOp.callData = encodeExecuteCallData(recipient.address, 50n, "0x");
    userOp.signature = "0x1234"; // way too short
    const userOpHash = hre.ethers.keccak256("0xbeef");
    const result = await validator.connect(account).validateUserOp.staticCall(userOp, userOpHash);
    expect(result).to.equal(SIG_VALIDATION_FAILED);
  });

  it("reverts ScopeNotFound when sig matches a key with no scope", async () => {
    const { account, recipient, validator } = await loadFixture(fixture);
    const orphan = hre.ethers.Wallet.createRandom();
    const userOp = emptyUserOp(account.address);
    userOp.callData = encodeExecuteCallData(recipient.address, 50n, "0x");
    const userOpHash = hre.ethers.keccak256("0xfeed");
    userOp.signature = await buildSig(orphan, userOpHash);
    await expect(
      validator.connect(account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(validator, "ScopeNotFound");
  });
});

describe("SessionKeyValidator — validateUserOp callData parsing (ETH path)", () => {
  async function setupEthScope() {
    const f = await loadFixture(fixture);
    await f.validator.connect(f.account).setScope(f.sessionKey.address, {
      recipient: f.recipient.address,
      spendToken: hre.ethers.ZeroAddress,
      maxAmountPerCall: hre.ethers.parseEther("0.1"),
      periodSeconds: 86400n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });
    return f;
  }

  it("rejects non-execute selector", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    userOp.callData = "0xdeadbeef" + "00".repeat(64); // garbage selector
    const userOpHash = hre.ethers.keccak256("0xa1");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "BadSelector");
  });

  it("rejects target == account (would let session key call setOwner / upgrade)", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    // Target the AA itself
    userOp.callData = encodeExecuteCallData(f.account.address, hre.ethers.parseEther("0.05"), "0x");
    const userOpHash = hre.ethers.keccak256("0xa2");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "TargetIsAccount");
  });

  it("rejects wrong recipient", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    userOp.callData = encodeExecuteCallData(f.attacker.address, hre.ethers.parseEther("0.05"), "0x");
    const userOpHash = hre.ethers.keccak256("0xa3");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "TargetNotRecipient");
  });

  it("rejects ETH transfer with non-empty calldata", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    userOp.callData = encodeExecuteCallData(f.recipient.address, hre.ethers.parseEther("0.05"), "0x1234");
    const userOpHash = hre.ethers.keccak256("0xa4");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "InvalidEthCalldata");
  });

  it("rejects amount > maxAmountPerCall", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    // Send 0.5 ETH when cap is 0.1 ETH
    userOp.callData = encodeExecuteCallData(f.recipient.address, hre.ethers.parseEther("0.5"), "0x");
    const userOpHash = hre.ethers.keccak256("0xa5");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "AmountOverCap");
  });

  it("happy path returns validationData with validUntil and a real-time validAfter", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    userOp.callData = encodeExecuteCallData(f.recipient.address, hre.ethers.parseEther("0.05"), "0x");
    const userOpHash = hre.ethers.keccak256("0xa6");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);

    // After the setScope-time anchor fix: lastFiredAt = setupTime - period.
    // First call's validAfter = (setupTime - period) + period = setupTime,
    // which is in the past relative to the current block, so EntryPoint
    // accepts it immediately. We just check it's a real wall-clock value
    // (i.e. not zero / not the broken pre-fix sentinel of `1 + period`).
    const result = await f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash);
    const sigFailed = result & 0xffffffffffffffffffffffffffffffffffffffffn;
    const validUntil = (result >> 160n) & 0xffffffffffffn;
    const validAfter = (result >> 208n) & 0xffffffffffffn;
    expect(sigFailed).to.equal(0n);
    expect(validUntil).to.equal(FAR_FUTURE);
    // validAfter must be a current wall-clock-ish value (≥ 2024 epoch start
    // = 1704067200), proving the anchor fix took effect.
    expect(validAfter).to.be.greaterThan(1_700_000_000n);
  });

  it("lastFiredAt advances by one period per successful fire (audit fix)", async () => {
    const f = await setupEthScope();
    const userOp = emptyUserOp(f.account.address);
    userOp.callData = encodeExecuteCallData(f.recipient.address, hre.ethers.parseEther("0.05"), "0x");
    const userOpHash = hre.ethers.keccak256("0xa7");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);

    const before = await f.validator.getScope(f.account.address, f.sessionKey.address);
    const beforeAnchor = before.lastFiredAt;

    // Real call mutates state.
    await f.validator.connect(f.account).validateUserOp(userOp, userOpHash);
    const afterFirst = await f.validator.getScope(f.account.address, f.sessionKey.address);
    expect(afterFirst.lastFiredAt).to.equal(beforeAnchor + 86400n);

    // Second call: validAfter should be (lastFiredAt after first) + period
    // = beforeAnchor + 2*period. Critically, this is a future timestamp
    // relative to wall clock, so EntryPoint would REJECT — proving the
    // pre-fix bypass is closed.
    userOp.signature = await buildSig(f.sessionKey, hre.ethers.keccak256("0xa8"));
    const result = await f.validator
      .connect(f.account)
      .validateUserOp.staticCall(userOp, hre.ethers.keccak256("0xa8"));
    const validAfter = (result >> 208n) & 0xffffffffffffn;
    expect(validAfter).to.equal(beforeAnchor + 2n * 86400n);

    // The post-fix invariant: validAfter for fire #2 is ALWAYS in the future
    // (block.timestamp + ~period, since beforeAnchor = setupTime - period).
    const blk = await hre.ethers.provider.getBlock("latest");
    expect(validAfter).to.be.greaterThan(BigInt(blk!.timestamp));
  });
});

describe("SessionKeyValidator — validateUserOp callData parsing (ERC-20 path)", () => {
  async function setupErc20Scope() {
    const f = await loadFixture(fixture);
    const usdcAddr = await f.usdc.getAddress();
    await f.validator.connect(f.account).setScope(f.sessionKey.address, {
      recipient: f.recipient.address,
      spendToken: usdcAddr,
      maxAmountPerCall: 100_000_000n, // 100 USDC
      periodSeconds: 86400n,
      validUntil: FAR_FUTURE,
      lastFiredAt: 0n,
    });
    return { ...f, usdcAddr };
  }

  it("rejects non-zero ETH value on ERC-20 path", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    const transferCd = encodeErc20Transfer(f.recipient.address, 50_000_000n);
    userOp.callData = encodeExecuteCallData(f.usdcAddr, 1n, transferCd);
    const userOpHash = hre.ethers.keccak256("0xb1");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "InvalidInnerCalldata");
  });

  it("rejects target != spendToken", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    const transferCd = encodeErc20Transfer(f.recipient.address, 50_000_000n);
    // Wrong target — recipient instead of token.
    userOp.callData = encodeExecuteCallData(f.recipient.address, 0n, transferCd);
    const userOpHash = hre.ethers.keccak256("0xb2");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "TargetNotRecipient");
  });

  it("rejects wrong inner selector (not transfer)", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    // Build a fake `approve(recipient, amount)` calldata.
    const iface = new hre.ethers.Interface(["function approve(address spender, uint256 value)"]);
    const approveCd = iface.encodeFunctionData("approve", [f.recipient.address, 50_000_000n]);
    userOp.callData = encodeExecuteCallData(f.usdcAddr, 0n, approveCd);
    const userOpHash = hre.ethers.keccak256("0xb3");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "UnsupportedInnerSelector");
  });

  it("rejects transfer to non-recipient address", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    const transferCd = encodeErc20Transfer(f.attacker.address, 50_000_000n);
    userOp.callData = encodeExecuteCallData(f.usdcAddr, 0n, transferCd);
    const userOpHash = hre.ethers.keccak256("0xb4");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "TargetNotRecipient");
  });

  it("rejects amount > cap", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    const transferCd = encodeErc20Transfer(f.recipient.address, 200_000_000n); // 200 USDC, cap 100
    userOp.callData = encodeExecuteCallData(f.usdcAddr, 0n, transferCd);
    const userOpHash = hre.ethers.keccak256("0xb5");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);
    await expect(
      f.validator.connect(f.account).validateUserOp.staticCall(userOp, userOpHash),
    ).to.be.revertedWithCustomError(f.validator, "AmountOverCap");
  });

  it("happy path: transfer exactly at cap succeeds, emits SessionFired", async () => {
    const f = await setupErc20Scope();
    const userOp = emptyUserOp(f.account.address);
    const transferCd = encodeErc20Transfer(f.recipient.address, 100_000_000n); // exactly 100 USDC
    userOp.callData = encodeExecuteCallData(f.usdcAddr, 0n, transferCd);
    const userOpHash = hre.ethers.keccak256("0xb6");
    userOp.signature = await buildSig(f.sessionKey, userOpHash);

    // Compute expected nextAllowedAt: lastFiredAt (= setupTime - period) + period
    // = setupTime. Since setupTime ~= block.timestamp at scope creation,
    // we just check the event was emitted and inspect the firedAt value.
    const tx = await f.validator.connect(f.account).validateUserOp(userOp, userOpHash);
    const receipt = await tx.wait();
    const firedEvent = receipt!.logs.find((l) => {
      try {
        const parsed = f.validator.interface.parseLog(l as any);
        return parsed?.name === "SessionFired";
      } catch {
        return false;
      }
    });
    expect(firedEvent, "SessionFired event missing").to.not.be.undefined;
    const parsed = f.validator.interface.parseLog(firedEvent as any)!;
    expect(parsed.args.account).to.equal(f.account.address);
    expect(parsed.args.sessionKey).to.equal(f.sessionKey.address);
    expect(parsed.args.recipient).to.equal(f.recipient.address);
    expect(parsed.args.spendToken).to.equal(f.usdcAddr);
    expect(parsed.args.amount).to.equal(100_000_000n);
    // firedAt is now a real wall-clock value (audit fix), not the old `1` sentinel.
    expect(parsed.args.firedAt).to.be.greaterThan(1_700_000_000n);
  });
});
