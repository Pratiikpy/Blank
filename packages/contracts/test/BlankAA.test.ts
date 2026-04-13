import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  BlankAccount + BlankAccountFactory + BlankPaymaster — foundation tests
//
//  Scope:
//   - factory.getAddress is deterministic across calls (CREATE2)
//   - factory.createAccount actually deploys at the predicted address
//   - factory.createAccount is idempotent (calling twice returns the
//     same proxy, second call no-op)
//   - BlankAccount.isValidSignature returns 0xffffffff for an invalid sig
//     (we don't have a real WebAuthn signature to test the success path
//     in solidity — that's covered in the WebAuthn integration session)
//   - BlankPaymaster.setApprovedTarget tracks approvedTargetsCount correctly
//   - BlankPaymaster.setFeeConfig clamps to 10% max
//
//  NOT in scope (covered later when WebAuthn UI ships):
//   - End-to-end UserOp execution through the EntryPoint
//   - Real P-256 signature verify against the precompile / daimo verifier
//   - Paymaster validatePaymasterUserOp on a real UserOp shape
//  Those need WebAuthn-derived test vectors which we'll generate in the
//  next session when porting the relayer.
// ══════════════════════════════════════════════════════════════════

// EntryPoint v0.8 — same address on every chain (CREATE2 deterministic deploy)
const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

async function deployAAFixture() {
  const [owner, user, treasury] = await hre.ethers.getSigners();

  // Deploy a mock EntryPoint locally (the real one isn't on hardhat)
  const EntryPoint = await hre.ethers.getContractFactory(
    "@account-abstraction/contracts/core/EntryPoint.sol:EntryPoint",
  );
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();
  const entryPointAddress = await entryPoint.getAddress();

  // Deploy the factory (which creates the implementation in its constructor)
  const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
  const factory = await Factory.deploy(entryPointAddress);
  await factory.waitForDeployment();

  // Deploy a TestUSDC for paymaster fee token
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  // Deploy the paymaster
  const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
  const paymaster = await Paymaster.deploy(
    entryPointAddress,
    await testUSDC.getAddress(),
    treasury.address,
    1_000_000n, // 1 USDC max fee cap (6 decimals)
    await factory.getAddress(),
  );
  await paymaster.waitForDeployment();

  return { owner, user, treasury, entryPoint, factory, paymaster, testUSDC };
}

describe("BlankAccountFactory", () => {
  it("getAddress is deterministic across calls with same inputs", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    const x = 12345n;
    const y = 67890n;
    const recovery = "0x0000000000000000000000000000000000000000";
    const salt = 1n;

    const a1 = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt);
    const a2 = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt);
    expect(a1).to.equal(a2);
  });

  it("getAddress changes when salt changes", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    const x = 12345n;
    const y = 67890n;
    const recovery = "0x0000000000000000000000000000000000000000";

    const a1 = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, 1n);
    const a2 = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, 2n);
    expect(a1).to.not.equal(a2);
  });

  it("createAccount deploys at the predicted CREATE2 address", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    const x = 11n;
    const y = 22n;
    const recovery = "0x0000000000000000000000000000000000000000";
    const salt = 42n;

    const predicted = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt);
    expect(await hre.ethers.provider.getCode(predicted)).to.equal("0x");

    const tx = await factory.createAccount(x, y, recovery, salt);
    await tx.wait();

    const code = await hre.ethers.provider.getCode(predicted);
    expect(code).to.not.equal("0x");
    expect(code.length).to.be.greaterThan(2);
  });

  it("createAccount is idempotent — second call returns same proxy without re-deploying", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    const x = 33n;
    const y = 44n;
    const recovery = "0x0000000000000000000000000000000000000000";
    const salt = 7n;

    await factory.createAccount(x, y, recovery, salt);
    const codeAfterFirst = await hre.ethers.provider.getCode(
      await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt),
    );

    // Second call should NOT revert and should return the same address
    const tx = await factory.createAccount(x, y, recovery, salt);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    const codeAfterSecond = await hre.ethers.provider.getCode(
      await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt),
    );
    expect(codeAfterSecond).to.equal(codeAfterFirst);
  });
});

describe("BlankAccount.isValidSignature (ERC-1271)", () => {
  it("returns 0xffffffff for an obviously invalid signature", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    // Deploy an account with non-zero owner keys
    const x = 100n;
    const y = 200n;
    const recovery = "0x0000000000000000000000000000000000000000";
    const salt = 0n;
    await factory.createAccount(x, y, recovery, salt);
    const accountAddr = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, salt);

    const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);

    // Random hash + dummy r/s that won't verify against (100, 200)
    const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("hello"));
    const sig = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [42n, 99n],
    );

    const result = await account.isValidSignature(hash, sig);
    expect(result).to.equal("0xffffffff");
  });

  it("never reverts even on completely malformed input", async () => {
    const { factory } = await loadFixture(deployAAFixture);

    const x = 1n;
    const y = 2n;
    const recovery = "0x0000000000000000000000000000000000000000";
    await factory.createAccount(x, y, recovery, 0n);
    const accountAddr = await factory["getAddress(uint256,uint256,address,uint256)"](x, y, recovery, 0n);
    const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);

    // 64 zero bytes = (r=0, s=0) — invalid but parseable
    const hash = hre.ethers.zeroPadValue("0x01", 32);
    const sig = hre.ethers.zeroPadValue("0x", 64);

    // Should return 0xffffffff, NOT revert. ERC-1271 contract MUST NOT revert.
    const result = await account.isValidSignature(hash, sig);
    expect(result).to.equal("0xffffffff");
  });
});

describe("BlankPaymaster admin", () => {
  it("setApprovedTarget tracks approvedTargetsCount correctly", async () => {
    const { paymaster, owner } = await loadFixture(deployAAFixture);

    expect(await paymaster.approvedTargetsCount()).to.equal(0);

    const t1 = "0x000000000000000000000000000000000000dEaD";
    const t2 = "0x000000000000000000000000000000000000bEEF";

    await paymaster.connect(owner).setApprovedTarget(t1, true);
    expect(await paymaster.approvedTargetsCount()).to.equal(1);

    await paymaster.connect(owner).setApprovedTarget(t2, true);
    expect(await paymaster.approvedTargetsCount()).to.equal(2);

    // Idempotent — setting an already-approved target stays at 2
    await paymaster.connect(owner).setApprovedTarget(t1, true);
    expect(await paymaster.approvedTargetsCount()).to.equal(2);

    // Removing decrements
    await paymaster.connect(owner).setApprovedTarget(t1, false);
    expect(await paymaster.approvedTargetsCount()).to.equal(1);

    // Removing-already-removed stays at 1
    await paymaster.connect(owner).setApprovedTarget(t1, false);
    expect(await paymaster.approvedTargetsCount()).to.equal(1);
  });

  it("setFeeConfig rejects fee rates > 10%", async () => {
    const { paymaster, owner } = await loadFixture(deployAAFixture);

    // 10% (1000 bps) is the max — should succeed
    await paymaster.connect(owner).setFeeConfig(1000, 5_000_000n);
    expect(await paymaster.feeRateBps()).to.equal(1000);

    // 10.01% (1001 bps) should revert
    await expect(
      paymaster.connect(owner).setFeeConfig(1001, 5_000_000n),
    ).to.be.revertedWith("BlankPaymaster: fee rate too high");
  });

  it("non-owner cannot change paymaster config", async () => {
    const { paymaster, user } = await loadFixture(deployAAFixture);

    await expect(
      paymaster.connect(user).setFeeConfig(50, 0),
    ).to.be.reverted;

    await expect(
      paymaster.connect(user).setApprovedTarget("0x000000000000000000000000000000000000dEaD", true),
    ).to.be.reverted;
  });
});

describe("Cross-chain compatibility", () => {
  it("EntryPoint v0.8 address constant matches Z0tz / Pimlico published value", () => {
    // Sanity test — if anyone ever changes the constant, this fails
    expect(ENTRYPOINT_V08).to.equal("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
  });
});
