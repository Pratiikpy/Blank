import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// BlankAccount audit fixes:
//   L1  ERC-1271 verifies a digest bound to this account and chain
//   L2  owner rotation revokes every enabled validator

// Real P-256 math: hardhat's default hardfork (osaka) ships the P256VERIFY
// precompile at 0x100, which P256.verify calls first. noble is reached
// through ethers' own dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { p256 } = require(require.resolve("@noble/curves/p256", {
  paths: [require("path").dirname(require.resolve("ethers"))],
}));

const abi = hre.ethers.AbiCoder.defaultAbiCoder();
const MAGIC = "0x1626ba7e";
const SK = p256.utils.randomPrivateKey();
const PUB = p256.getPublicKey(SK, false);
const X = BigInt("0x" + Buffer.from(PUB.slice(1, 33)).toString("hex"));
const Y = BigInt("0x" + Buffer.from(PUB.slice(33, 65)).toString("hex"));

function signDigest(digest: string): string {
  const sig = p256.sign(hre.ethers.getBytes(digest), SK, { prehash: false, lowS: true });
  return abi.encode(["uint256", "uint256"], [sig.r, sig.s]);
}

async function fixture() {
  const [deployer, recovery, beneficiary] = await hre.ethers.getSigners();
  const EntryPoint = await hre.ethers.getContractFactory(
    "@account-abstraction/contracts/core/EntryPoint.sol:EntryPoint",
  );
  const entryPoint = await EntryPoint.deploy();
  const epAddr = await entryPoint.getAddress();
  const factory = await (await hre.ethers.getContractFactory("BlankAccountFactory")).deploy(epAddr);

  await factory.createAccount(X, Y, recovery.address, 0n);
  await factory.createAccount(X, Y, recovery.address, 1n);
  const addrA = await factory["getAddress(uint256,uint256,address,uint256)"](X, Y, recovery.address, 0n);
  const addrB = await factory["getAddress(uint256,uint256,address,uint256)"](X, Y, recovery.address, 1n);
  const accountA = await hre.ethers.getContractAt("BlankAccount", addrA);
  const accountB = await hre.ethers.getContractAt("BlankAccount", addrB);

  const mockValidator = await (await hre.ethers.getContractFactory("MockValidator")).deploy();

  return { deployer, recovery, beneficiary, entryPoint, epAddr, factory, accountA, accountB, addrA, addrB, mockValidator };
}

async function wrapped(account: string, hash: string): Promise<string> {
  const { chainId } = await hre.ethers.provider.getNetwork();
  return hre.ethers.TypedDataEncoder.hash(
    { name: "BlankAccount", version: "1", chainId, verifyingContract: account },
    { BlankAccountMessage: [{ name: "hash", type: "bytes32" }] },
    { hash },
  );
}

describe("BlankAccount: ERC-1271 replay protection (L1)", () => {
  const H = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("blank message"));

  it("replaySafeHash matches a standard EIP-712 typed-data hash", async () => {
    const ctx = await loadFixture(fixture);
    expect(await ctx.accountA.replaySafeHash(H)).to.equal(await wrapped(ctx.addrA, H));
  });

  it("accepts a signature over the wrapped digest", async () => {
    const ctx = await loadFixture(fixture);
    const sig = signDigest(await wrapped(ctx.addrA, H));
    expect(await ctx.accountA.isValidSignature(H, sig)).to.equal(MAGIC);
  });

  it("L1 exploit: a signature over the raw hash is no longer accepted", async () => {
    const ctx = await loadFixture(fixture);
    // Old behaviour accepted this: the passkey signed H itself.
    expect(await ctx.accountA.isValidSignature(H, signDigest(H))).to.equal("0xffffffff");
  });

  it("L1 exploit: a signature for account A does not verify on account B with the same passkey", async () => {
    const ctx = await loadFixture(fixture);
    const sig = signDigest(await wrapped(ctx.addrA, H));
    expect(await ctx.accountA.isValidSignature(H, sig)).to.equal(MAGIC);
    expect(await ctx.accountB.isValidSignature(H, sig)).to.equal("0xffffffff");
  });
});

describe("BlankAccount: owner rotation revokes validators (L2)", () => {
  async function opFor(ctx: any, nonce: bigint) {
    return {
      sender: ctx.addrA,
      nonce,
      initCode: "0x",
      callData: ctx.accountA.interface.encodeFunctionData("execute", [ctx.deployer.address, 0n, "0x"]),
      accountGasLimits: hre.ethers.solidityPacked(["uint128", "uint128"], [500_000n, 100_000n]),
      preVerificationGas: 50_000n,
      gasFees: hre.ethers.solidityPacked(["uint128", "uint128"], [1_000_000_000n, 2_000_000_000n]),
      paymasterAndData: "0x",
      signature: abi.encode(["address", "bytes"], [await ctx.mockValidator.getAddress(), "0x"]),
    };
  }

  it("L2 exploit: a session validator enabled before recovery stops working after it", async () => {
    const ctx = await loadFixture(fixture);
    const mv = await ctx.mockValidator.getAddress();
    await hre.network.provider.send("hardhat_impersonateAccount", [ctx.epAddr]);
    await hre.network.provider.send("hardhat_setBalance", [ctx.epAddr, "0x56BC75E2D63100000"]);
    const ep = await hre.ethers.getSigner(ctx.epAddr);
    await ctx.accountA.connect(ep).enableValidator(mv);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [ctx.epAddr]);
    await ctx.entryPoint.depositTo(ctx.addrA, { value: hre.ethers.parseEther("1") });

    expect(await ctx.accountA.isValidatorEnabled(mv)).to.equal(true);
    await expect(
      ctx.entryPoint.handleOps([await opFor(ctx, 0n)], ctx.beneficiary.address, { gasPrice: 2_000_000_000n }),
    ).to.emit(ctx.entryPoint, "UserOperationEvent");

    await expect(ctx.accountA.connect(ctx.recovery).setOwner(55n, 66n))
      .to.emit(ctx.accountA, "ValidatorsReset").withArgs(1n);
    expect(await ctx.accountA.validatorEpoch()).to.equal(1n);
    expect(await ctx.accountA.isValidatorEnabled(mv)).to.equal(false);

    await expect(
      ctx.entryPoint.handleOps([await opFor(ctx, 1n)], ctx.beneficiary.address, { gasPrice: 2_000_000_000n }),
    )
      .to.be.revertedWithCustomError(ctx.entryPoint, "FailedOp")
      .withArgs(0n, "AA24 signature error");

    // The new owner can re-enable it explicitly.
    await hre.network.provider.send("hardhat_impersonateAccount", [ctx.epAddr]);
    await ctx.accountA.connect(await hre.ethers.getSigner(ctx.epAddr)).enableValidator(mv);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [ctx.epAddr]);
    expect(await ctx.accountA.isValidatorEnabled(mv)).to.equal(true);
  });
});
