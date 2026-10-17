import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// BlankPaymaster as a verifying paymaster, driven through a real EntryPoint
// v0.8 handleOps. The account's own validation is satisfied by a
// MockValidator so these tests isolate the paymaster checks.

const abi = hre.ethers.AbiCoder.defaultAbiCoder();
const GWEI = 1_000_000_000n;

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

function pack128(hi: bigint, lo: bigint): string {
  return hre.ethers.solidityPacked(["uint128", "uint128"], [hi, lo]);
}

async function epSignerFor(entryPoint: any) {
  const epAddr = await entryPoint.getAddress();
  await hre.network.provider.send("hardhat_impersonateAccount", [epAddr]);
  await hre.network.provider.send("hardhat_setBalance", [epAddr, "0x56BC75E2D63100000"]);
  return hre.ethers.getSigner(epAddr);
}

async function fixture() {
  const [deployer, treasury, beneficiary, attacker] = await hre.ethers.getSigners();
  const signer = hre.ethers.Wallet.createRandom();

  const EntryPoint = await hre.ethers.getContractFactory(
    "@account-abstraction/contracts/core/EntryPoint.sol:EntryPoint",
  );
  const entryPoint = await EntryPoint.deploy();
  await entryPoint.waitForDeployment();
  const epAddr = await entryPoint.getAddress();

  const Factory = await hre.ethers.getContractFactory("BlankAccountFactory");
  const factory = await Factory.deploy(epAddr);
  const rogueFactory = await Factory.deploy(epAddr);

  const usdc = await (await hre.ethers.getContractFactory("TestUSDC")).deploy();
  const usdcAddr = await usdc.getAddress();

  await factory.createAccount(1n, 2n, hre.ethers.ZeroAddress, 0n);
  const accountAddr = await factory["getAddress(uint256,uint256,address,uint256)"](1n, 2n, hre.ethers.ZeroAddress, 0n);
  const account = await hre.ethers.getContractAt("BlankAccount", accountAddr);

  const mockValidator = await (await hre.ethers.getContractFactory("MockValidator")).deploy();
  const mvAddr = await mockValidator.getAddress();
  const ep = await epSignerFor(entryPoint);
  await account.connect(ep).enableValidator(mvAddr);

  const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
  const paymaster = await Paymaster.deploy(
    epAddr, usdcAddr, treasury.address, await factory.getAddress(), signer.address,
  );
  const pmAddr = await paymaster.getAddress();
  await paymaster.setAccountCodeHash(hre.ethers.keccak256(await hre.ethers.provider.getCode(accountAddr)));
  await paymaster.setGasCaps(100n * GWEI, 10n * GWEI, hre.ethers.parseEther("0.5"));
  await paymaster.setApprovedTarget(usdcAddr, true);
  await paymaster.deposit({ value: hre.ethers.parseEther("10") });

  // Account holds USDC and approves the paymaster for fees.
  await usdc.mint(accountAddr, 1_000_000_000n);
  await account.connect(ep).execute(
    usdcAddr, 0n, usdc.interface.encodeFunctionData("approve", [pmAddr, hre.ethers.MaxUint256]),
  );
  await hre.network.provider.send("hardhat_stopImpersonatingAccount", [epAddr]);

  return {
    deployer, treasury, beneficiary, attacker, signer, entryPoint, factory, rogueFactory,
    usdc, usdcAddr, account, accountAddr, mockValidator, mvAddr, paymaster, pmAddr,
  };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

function baseOp(ctx: Ctx, overrides: Partial<PackedUserOp> = {}): PackedUserOp {
  const callData = ctx.account.interface.encodeFunctionData("execute", [
    ctx.usdcAddr, 0n, ctx.usdc.interface.encodeFunctionData("transfer", [ctx.deployer.address, 1n]),
  ]);
  return {
    sender: ctx.accountAddr,
    nonce: 0n,
    initCode: "0x",
    callData,
    accountGasLimits: pack128(1_000_000n, 300_000n),
    preVerificationGas: 60_000n,
    gasFees: pack128(1n * GWEI, 20n * GWEI),
    paymasterAndData: "0x",
    signature: abi.encode(["address", "bytes"], [ctx.mvAddr, "0x"]),
    ...overrides,
  };
}

function pmPrefix(pm: string): string {
  return hre.ethers.solidityPacked(["address", "uint128", "uint128"], [pm, 300_000n, 150_000n]);
}

async function sponsor(
  ctx: Ctx,
  op: PackedUserOp,
  opts: { validUntil?: number; validAfter?: number; signer?: any; pm?: string } = {},
): Promise<PackedUserOp> {
  const validUntil = opts.validUntil ?? 0;
  const validAfter = opts.validAfter ?? 0;
  const pm = opts.pm ?? ctx.pmAddr;
  const stub = pmPrefix(pm) + hre.ethers.solidityPacked(["uint48", "uint48"], [validUntil, validAfter]).slice(2) + "00".repeat(65);
  const hash = await ctx.paymaster.getHash({ ...op, paymasterAndData: stub }, validUntil, validAfter);
  const sig = await (opts.signer ?? ctx.signer).signMessage(hre.ethers.getBytes(hash));
  return {
    ...op,
    paymasterAndData:
      pmPrefix(pm) + hre.ethers.solidityPacked(["uint48", "uint48"], [validUntil, validAfter]).slice(2) + sig.slice(2),
  };
}

async function send(ctx: Ctx, op: PackedUserOp, gasPrice = 2n * GWEI) {
  return ctx.entryPoint.handleOps([op], ctx.beneficiary.address, { gasPrice });
}

/// Asserts handleOps fails in paymaster validation with this exact reason.
async function expectPmRevert(ctx: Ctx, op: PackedUserOp, reason: string) {
  let data: string | undefined;
  try {
    await ctx.entryPoint.handleOps.staticCall([op], ctx.beneficiary.address, { gasPrice: 2n * GWEI });
  } catch (e: any) {
    data = e.data;
  }
  expect(data, "handleOps did not revert").to.not.equal(undefined);
  const parsed = ctx.entryPoint.interface.parseError(data!);
  expect(parsed?.name).to.equal("FailedOpWithRevert");
  expect(parsed!.args.reason).to.equal("AA33 reverted");
  const inner = hre.ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + parsed!.args.inner.slice(10))[0];
  expect(inner).to.equal(reason);
}

describe("BlankPaymaster: verifying paymaster", () => {
  it("sponsors an op signed by the backend signer and leaves the fee at zero when free", async () => {
    const ctx = await loadFixture(fixture);
    const depositBefore = await ctx.entryPoint.balanceOf(ctx.pmAddr);
    const op = await sponsor(ctx, baseOp(ctx));
    await expect(send(ctx, op)).to.emit(ctx.entryPoint, "UserOperationEvent");
    expect(await ctx.entryPoint.balanceOf(ctx.pmAddr)).to.be.lessThan(depositBefore);
    expect(await ctx.usdc.balanceOf(ctx.treasury.address)).to.equal(0n);
  });

  it("H2 exploit: the old caller-written transferAmount layout is rejected", async () => {
    const ctx = await loadFixture(fixture);
    // Old format: 52-byte prefix + 32-byte transferAmount = 0 (free gas).
    const op = baseOp(ctx, { paymasterAndData: pmPrefix(ctx.pmAddr) + "00".repeat(32) });
    await expectPmRevert(ctx, op, "BlankPaymaster: bad paymasterData length");
  });

  it("rejects a signature from any key other than verifyingSigner", async () => {
    const ctx = await loadFixture(fixture);
    const op = await sponsor(ctx, baseOp(ctx), { signer: hre.ethers.Wallet.createRandom() });
    await expect(send(ctx, op))
      .to.be.revertedWithCustomError(ctx.entryPoint, "FailedOp")
      .withArgs(0n, "AA34 signature error");
  });

  it("signature is bound to the op: changing callData after signing fails", async () => {
    const ctx = await loadFixture(fixture);
    const signed = await sponsor(ctx, baseOp(ctx));
    const tampered = {
      ...signed,
      callData: ctx.account.interface.encodeFunctionData("execute", [
        ctx.usdcAddr, 0n, ctx.usdc.interface.encodeFunctionData("transfer", [ctx.deployer.address, 999n]),
      ]),
    };
    await expect(send(ctx, tampered))
      .to.be.revertedWithCustomError(ctx.entryPoint, "FailedOp")
      .withArgs(0n, "AA34 signature error");
  });

  it("signature is bound to the paymaster address", async () => {
    const ctx = await loadFixture(fixture);
    const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
    const other = await Paymaster.deploy(
      await ctx.entryPoint.getAddress(), ctx.usdcAddr, ctx.treasury.address,
      await ctx.factory.getAddress(), ctx.signer.address,
    );
    // Hash computed by this paymaster but submitted to `other`.
    const signed = await sponsor(ctx, baseOp(ctx));
    const moved = { ...signed, paymasterAndData: (await other.getAddress()) + signed.paymasterAndData.slice(42) };
    const h1 = await ctx.paymaster.getHash(moved, 0, 0);
    const h2 = await other.getHash(moved, 0, 0);
    expect(h1).to.not.equal(h2);
  });

  it("H2 exploit: a huge priority fee is rejected (deposit drain)", async () => {
    const ctx = await loadFixture(fixture);
    const op = await sponsor(ctx, baseOp(ctx, { gasFees: pack128(50n * GWEI, 100n * GWEI) }));
    await expectPmRevert(ctx, op, "BlankPaymaster: priority fee over cap");
  });

  it("rejects maxCost above the cap", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.paymaster.setGasCaps(100n * GWEI, 10n * GWEI, 1n);
    const op = await sponsor(ctx, baseOp(ctx));
    await expectPmRevert(ctx, op, "BlankPaymaster: maxCost over cap");
  });

  it("H2 exploit: a sender that is not a Blank account is rejected", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.paymaster.setAccountCodeHash(hre.ethers.keccak256("0x1234"));
    const op = await sponsor(ctx, baseOp(ctx));
    await expectPmRevert(ctx, op, "BlankPaymaster: not a Blank account");
  });

  it("rejects initCode from a factory other than approvedFactory", async () => {
    const ctx = await loadFixture(fixture);
    const rogue = await ctx.rogueFactory.getAddress();
    const sender = await ctx.rogueFactory["getAddress(uint256,uint256,address,uint256)"](5n, 6n, hre.ethers.ZeroAddress, 0n);
    const initCode = rogue + ctx.rogueFactory.interface
      .encodeFunctionData("createAccount", [5n, 6n, hre.ethers.ZeroAddress, 0n]).slice(2);
    const op = await sponsor(ctx, baseOp(ctx, {
      sender, initCode, accountGasLimits: pack128(2_000_000n, 300_000n),
    }));
    await expectPmRevert(ctx, op, "BlankPaymaster: unapproved factory");
  });

  it("charges the fee from actualGasCost in postOp", async () => {
    const ctx = await loadFixture(fixture);
    // 3000 USDC per ETH (6 decimals), 10% markup, 5 USDC cap.
    await ctx.paymaster.setFeeConfig(3_000_000_000n, 1_000n, 5_000_000n);
    const op = await sponsor(ctx, baseOp(ctx));
    const tx = await send(ctx, op);
    const rc = await tx.wait();
    const ev = rc!.logs
      .map((l: any) => { try { return ctx.entryPoint.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "UserOperationEvent");
    const fee = (await ctx.usdc.balanceOf(ctx.treasury.address));
    expect(fee).to.be.greaterThan(0n);
    // postOp sees actualGasCost before its own gas is added, so the fee is
    // at most the conversion of the final reported cost.
    const upper = (ev!.args.actualGasCost * 3_000_000_000n * 11_000n) / (10n ** 18n * 10_000n);
    expect(fee).to.be.lessThanOrEqual(upper);
    await expect(tx).to.emit(ctx.paymaster, "FeeCollected");
  });

  it("validation rejects when the fee allowance does not cover maxCost", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.paymaster.setFeeConfig(3_000_000_000n, 0n, 0n);
    const ep = await epSignerFor(ctx.entryPoint);
    await ctx.account.connect(ep).execute(
      ctx.usdcAddr, 0n, ctx.usdc.interface.encodeFunctionData("approve", [ctx.pmAddr, 0n]),
    );
    const op = await sponsor(ctx, baseOp(ctx));
    await expectPmRevert(ctx, op, "BlankPaymaster: insufficient fee allowance");
  });

  it("H2 exploit: a failed fee pull does not revert postOp and blocks further sponsorship", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.paymaster.setFeeConfig(3_000_000_000n, 0n, 0n);
    // The op itself revokes the allowance during execution, so the postOp
    // pull fails. Old code reverted postOp (paymaster pays, repeatable).
    const callData = ctx.account.interface.encodeFunctionData("execute", [
      ctx.usdcAddr, 0n, ctx.usdc.interface.encodeFunctionData("approve", [ctx.pmAddr, 0n]),
    ]);
    const op = await sponsor(ctx, baseOp(ctx, { callData }));
    const tx = await send(ctx, op);
    await expect(tx).to.emit(ctx.paymaster, "FeeDefaulted");
    const rc = await tx.wait();
    const ev = rc!.logs
      .map((l: any) => { try { return ctx.entryPoint.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "UserOperationEvent");
    expect(ev!.args.success).to.equal(true);
    expect(await ctx.paymaster.feeDefaulted(ctx.accountAddr)).to.equal(true);

    const next = await sponsor(ctx, baseOp(ctx, { nonce: 1n }));
    await expectPmRevert(ctx, next, "BlankPaymaster: unpaid fee");

    await ctx.paymaster.clearFeeDefault(ctx.accountAddr);
    expect(await ctx.paymaster.feeDefaulted(ctx.accountAddr)).to.equal(false);
  });

  it("rate limit: a second op inside minSponsorInterval is not due yet", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.paymaster.setSponsorInterval(3600);
    await send(ctx, await sponsor(ctx, baseOp(ctx)));
    expect(await ctx.paymaster.lastSponsoredAt(ctx.accountAddr)).to.be.greaterThan(0n);

    const second = await sponsor(ctx, baseOp(ctx, { nonce: 1n }));
    await expect(send(ctx, second))
      .to.be.revertedWithCustomError(ctx.entryPoint, "FailedOp")
      .withArgs(0n, "AA32 paymaster expired or not due");

    await time.increase(3601);
    await expect(send(ctx, second)).to.emit(ctx.entryPoint, "UserOperationEvent");
  });

  it("expired signature window is enforced by the EntryPoint", async () => {
    const ctx = await loadFixture(fixture);
    const now = await time.latest();
    const op = await sponsor(ctx, baseOp(ctx), { validUntil: now - 10 });
    await expect(send(ctx, op))
      .to.be.revertedWithCustomError(ctx.entryPoint, "FailedOp")
      .withArgs(0n, "AA32 paymaster expired or not due");
  });

  it("fails closed when gas caps or account code hash are unset", async () => {
    const ctx = await loadFixture(fixture);
    const Paymaster = await hre.ethers.getContractFactory("BlankPaymaster");
    const fresh = await Paymaster.deploy(
      await ctx.entryPoint.getAddress(), ctx.usdcAddr, ctx.treasury.address,
      await ctx.factory.getAddress(), ctx.signer.address,
    );
    await fresh.deposit({ value: hre.ethers.parseEther("1") });
    const freshAddr = await fresh.getAddress();
    const op = baseOp(ctx);
    const stub = pmPrefix(freshAddr) + "00".repeat(12) + "00".repeat(65);
    const hash = await fresh.getHash({ ...op, paymasterAndData: stub }, 0, 0);
    const sig = await ctx.signer.signMessage(hre.ethers.getBytes(hash));
    const signed = { ...op, paymasterAndData: pmPrefix(freshAddr) + "00".repeat(12) + sig.slice(2) };
    await expectPmRevert(ctx, signed, "BlankPaymaster: account code hash unset");
  });

  it("the ERC1967Proxy artifact hash used by deploy-paymaster-v2 equals a real account's code hash", async () => {
    const ctx = await loadFixture(fixture);
    const art = await hre.artifacts.readArtifact("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
    expect(hre.ethers.keccak256(art.deployedBytecode)).to.equal(
      hre.ethers.keccak256(await hre.ethers.provider.getCode(ctx.accountAddr)),
    );
  });

  it("admin setters are owner-only and validate input", async () => {
    const ctx = await loadFixture(fixture);
    await expect(ctx.paymaster.connect(ctx.attacker).setVerifyingSigner(ctx.attacker.address)).to.be.reverted;
    await expect(ctx.paymaster.setVerifyingSigner(hre.ethers.ZeroAddress)).to.be.revertedWith("BlankPaymaster: signer=0");
    await expect(ctx.paymaster.setFeeConfig(1n, 5_001n, 0n)).to.be.revertedWith("BlankPaymaster: markup too high");
    await expect(ctx.paymaster.setGasCaps(1n, 2n, 1n)).to.be.revertedWith("BlankPaymaster: priority > max");
    await expect(ctx.paymaster.setTreasury(hre.ethers.ZeroAddress)).to.be.revertedWith("BlankPaymaster: treasury=0");
    await expect(ctx.paymaster.setSponsorInterval(86_401)).to.be.revertedWith("BlankPaymaster: interval too long");
  });
});
