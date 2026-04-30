import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  BlankAccount validator-dispatch — Phase 4.1 UUPS upgrade
//
//  Covers:
//   • Legacy P-256 signature path (64 bytes) still works post-upgrade
//   • Validator dispatch (>64-byte sig) forwards to enabled validators
//   • Disabled validators return SIG_VALIDATION_FAILED
//   • Zero validator address returns SIG_VALIDATION_FAILED
//   • enableValidator / disableValidator are gated to self-or-EntryPoint
//   • The shim userOp passed to the validator carries the INNER sig (not
//     the outer wrapper) — ensures the validator decodes correctly
//
//  Test pattern: use a MockValidator that captures its inputs so we can
//  assert the dispatch logic without needing real session-key signatures.
//  We bypass the EntryPoint by calling `_validateSignature` indirectly:
//  there's no public surface for it on BaseAccount, so we EXERCISE it via
//  the EntryPoint's `handleOps` (or a test-only helper). For unit-test
//  granularity we test the public surface (enableValidator gating) and
//  the dispatch via a wrapper that exposes _validateSignature for tests.
//
//  We expose the internal via a test wrapper contract — keeps production
//  code clean while letting us hit the dispatch directly.
// ══════════════════════════════════════════════════════════════════

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

const ZERO_BYTES32 = "0x" + "00".repeat(32);

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

async function fixture() {
  const [owner, validatorOwner, attacker] = await hre.ethers.getSigners();

  // Deploy a real EntryPoint + Factory + create a single account so we have
  // a deployed proxy to test against.
  const EntryPoint = await hre.ethers.getContractFactory(
    "@account-abstraction/contracts/core/EntryPoint.sol:EntryPoint",
  );
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
  const factory = await Factory.deploy(await entryPoint.getAddress());
  await factory.waitForDeployment();

  // Use a deterministic test pubkey (we don't need real WebAuthn here —
  // the legacy P-256 path tests verify against this pubkey, which would
  // only succeed for a valid (r,s) signature. We're testing dispatch logic
  // not crypto correctness — that's covered in Blank.test.ts already).
  const ownerX = 12345n;
  const ownerY = 67890n;
  const recoveryModule = hre.ethers.ZeroAddress;
  const salt = 1n;

  await factory.createAccount(ownerX, ownerY, recoveryModule, salt);
  const accountAddr = await factory["getAddress(uint256,uint256,address,uint256)"](
    ownerX,
    ownerY,
    recoveryModule,
    salt,
  );
  const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);

  // Deploy mock validator
  const MockValidator = await hre.ethers.getContractFactory("MockValidator");
  const mockValidator = await MockValidator.deploy();
  await mockValidator.waitForDeployment();

  return {
    owner,
    validatorOwner,
    attacker,
    entryPoint,
    factory,
    account,
    accountAddr,
    mockValidator,
  };
}

describe("BlankAccount — validator dispatch storage + auth", () => {
  it("enabledValidators starts as default-zero (no validators authorized)", async () => {
    const { account, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    expect(await account.enabledValidators(validatorAddr)).to.equal(false);
  });

  it("enableValidator reverts when called from external EOA", async () => {
    const { account, mockValidator, attacker } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    await expect(
      account.connect(attacker).enableValidator(validatorAddr),
    ).to.be.revertedWith("BlankAccount: unauthorized");
  });

  it("disableValidator reverts when called from external EOA", async () => {
    const { account, mockValidator, attacker } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    await expect(
      account.connect(attacker).disableValidator(validatorAddr),
    ).to.be.revertedWith("BlankAccount: unauthorized");
  });

  it("enableValidator rejects zero address (when called from EntryPoint)", async () => {
    const { account, entryPoint } = await loadFixture(fixture);
    // Impersonate the entryPoint so we satisfy onlySelfOrEntryPoint.
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await expect(
      account.connect(epSigner).enableValidator(hre.ethers.ZeroAddress),
    ).to.be.revertedWith("BlankAccount: zero validator");
  });
});

describe("BlankAccount — validator-enable via EntryPoint impersonation", () => {
  async function enableViaEntryPoint(
    account: any,
    entryPoint: any,
    validatorAddr: string,
  ) {
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await account.connect(epSigner).enableValidator(validatorAddr);
  }

  it("enableValidator flips the map and emits ValidatorEnabled", async () => {
    const { account, entryPoint, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();

    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);

    await expect(account.connect(epSigner).enableValidator(validatorAddr))
      .to.emit(account, "ValidatorEnabled")
      .withArgs(validatorAddr);

    expect(await account.enabledValidators(validatorAddr)).to.equal(true);
  });

  it("disableValidator flips the map and emits ValidatorDisabled", async () => {
    const { account, entryPoint, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    await enableViaEntryPoint(account, entryPoint, validatorAddr);
    expect(await account.enabledValidators(validatorAddr)).to.equal(true);

    const epAddr = await entryPoint.getAddress();
    const epSigner = await hre.ethers.getSigner(epAddr);
    await expect(account.connect(epSigner).disableValidator(validatorAddr))
      .to.emit(account, "ValidatorDisabled")
      .withArgs(validatorAddr);

    expect(await account.enabledValidators(validatorAddr)).to.equal(false);
  });
});

describe("BlankAccount — validateUserOp dispatch (via EntryPoint)", () => {
  // Helper: BaseAccount.validateUserOp is `external` and only callable by
  // the entryPoint. We impersonate it to exercise _validateSignature
  // through its public ingress.
  async function callValidateUserOp(
    account: any,
    entryPoint: any,
    userOp: PackedUserOp,
    userOpHash: string,
    missingFunds: bigint,
  ) {
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    return account
      .connect(epSigner)
      .validateUserOp.staticCall(userOp, userOpHash, missingFunds);
  }

  it("legacy 64-byte P-256 sig path: invalid sig returns SIG_VALIDATION_FAILED (1)", async () => {
    const { account, entryPoint, accountAddr } = await loadFixture(fixture);
    const userOp = emptyUserOp(accountAddr);
    // 64-byte sig = abi.encode(r=0, s=0). Will fail P-256 verify against
    // the test pubkey (12345, 67890) which isn't a real curve point — but
    // the path takes us through P256.verify which returns false → 1.
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [0n, 0n],
    );
    const userOpHash = hre.ethers.keccak256("0xdeadbeef");
    const result = await callValidateUserOp(account, entryPoint, userOp, userOpHash, 0n);
    expect(result).to.equal(1n); // SIG_VALIDATION_FAILED — sig doesn't verify
  });

  it("validator dispatch: disabled validator returns SIG_VALIDATION_FAILED", async () => {
    const { account, entryPoint, accountAddr, mockValidator } = await loadFixture(fixture);
    const userOp = emptyUserOp(accountAddr);
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [await mockValidator.getAddress(), "0x1234"],
    );
    const userOpHash = hre.ethers.keccak256("0xfeed");
    const result = await callValidateUserOp(account, entryPoint, userOp, userOpHash, 0n);
    expect(result).to.equal(1n);
  });

  it("validator dispatch: zero validator returns SIG_VALIDATION_FAILED", async () => {
    const { account, entryPoint, accountAddr } = await loadFixture(fixture);
    const userOp = emptyUserOp(accountAddr);
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [hre.ethers.ZeroAddress, "0x"],
    );
    const userOpHash = hre.ethers.keccak256("0xbeef");
    const result = await callValidateUserOp(account, entryPoint, userOp, userOpHash, 0n);
    expect(result).to.equal(1n);
  });

  it("validator dispatch: enabled validator forwards inner sig and returns its validationData", async () => {
    const { account, entryPoint, accountAddr, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();

    // Enable + set the mock to return a custom validationData (e.g. a packed
    // (validUntil=100, validAfter=50) — verifies the return value bubbles up).
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await account.connect(epSigner).enableValidator(validatorAddr);

    // Pack expected validationData: aggregator(0) | validUntil(100) << 160 | validAfter(50) << 208
    const expectedData = (100n << 160n) | (50n << 208n);
    await mockValidator.setNextReturn(expectedData);

    const userOp = emptyUserOp(accountAddr);
    const innerSig = "0xcafebabe";
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [validatorAddr, innerSig],
    );
    const userOpHash = hre.ethers.keccak256("0xabad1dea");
    const result = await callValidateUserOp(account, entryPoint, userOp, userOpHash, 0n);
    expect(result).to.equal(expectedData);
  });

  it("validator dispatch: shim userOp carries inner sig (not outer wrapper)", async () => {
    const { account, entryPoint, accountAddr, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await account.connect(epSigner).enableValidator(validatorAddr);
    await mockValidator.setNextReturn(0n);

    const userOp = emptyUserOp(accountAddr);
    const innerSig = "0xdeadbeefcafebabe";
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [validatorAddr, innerSig],
    );
    const userOpHash = hre.ethers.keccak256("0xc0ffee");
    // Real call (not staticCall) so the mock's storage is updated.
    await account.connect(epSigner).validateUserOp(userOp, userOpHash, 0n);

    // The mock should have seen the INNER sig, not the outer wrapper.
    expect(await mockValidator.lastSignatureSeen()).to.equal(innerSig);
    expect(await mockValidator.lastHashSeen()).to.equal(userOpHash);
    expect(await mockValidator.lastSenderSeen()).to.equal(accountAddr);
  });

  it("validator dispatch: re-disabling blocks subsequent dispatch", async () => {
    const { account, entryPoint, accountAddr, mockValidator } = await loadFixture(fixture);
    const validatorAddr = await mockValidator.getAddress();
    const epAddr = await entryPoint.getAddress();
    await hre.ethers.provider.send("hardhat_impersonateAccount", [epAddr]);
    await hre.ethers.provider.send("hardhat_setBalance", [epAddr, "0x1000000000000000000"]);
    const epSigner = await hre.ethers.getSigner(epAddr);
    await account.connect(epSigner).enableValidator(validatorAddr);
    await mockValidator.setNextReturn(0n);
    await account.connect(epSigner).disableValidator(validatorAddr);

    const userOp = emptyUserOp(accountAddr);
    userOp.signature = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [validatorAddr, "0x1234"],
    );
    const userOpHash = hre.ethers.keccak256("0xdead");
    const result = await callValidateUserOp(account, entryPoint, userOp, userOpHash, 0n);
    expect(result).to.equal(1n);
  });
});
