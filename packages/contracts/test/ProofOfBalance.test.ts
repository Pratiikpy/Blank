import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable, FheTypes } from "@cofhe/sdk";

// Wave 5 Block 10 — ProofOfBalance.
//
// Locks the contract invariants:
//   - threshold>0 required
//   - per-proof identity preserved
//   - FHE.gte verdict reveals correctly via publishDecryptResult
//   - replay-reveal blocked (revealed flag)

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = initArgs.length > 0
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function encUint64(ctx: any, signer: any, value: bigint) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  const [enc] = await ctx.client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

async function deployFixture() {
  const [owner, alice] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);
  const proof = await deployProxy("ProofOfBalance");
  return { owner, alice, client, proof };
}

describe("ProofOfBalance", () => {
  it("rejects threshold=0", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx, ctx.alice, 1000n);
    await expect(ctx.proof.connect(ctx.alice).createProof(enc, 0))
      .to.be.revertedWith("ProofOfBalance: threshold=0");
  });

  it("creates proof, emits ProofCreated, getProof returns initial state", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx, ctx.alice, 5_000_000n);
    await expect(ctx.proof.connect(ctx.alice).createProof(enc, 1_000_000))
      .to.emit(ctx.proof, "ProofCreated");
    const p = await ctx.proof.getProof(0);
    expect(p.prover).to.equal(ctx.alice.address);
    expect(p.thresholdMicroUSD).to.equal(1_000_000);
    expect(p.revealed).to.equal(false);
  });

  it("balance >= threshold reveals true; replay reveal reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx, ctx.alice, 5_000_000n); // 5 microUSD
    await ctx.proof.connect(ctx.alice).createProof(enc, 1_000_000); // threshold 1

    const handle = (await ctx.proof.proofs(0)).met;
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const decrypted = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    expect(Boolean(decrypted.decryptedValue)).to.equal(true);

    await expect(
      ctx.proof.connect(ctx.alice).revealProof(0, Boolean(decrypted.decryptedValue), decrypted.signature),
    ).to.emit(ctx.proof, "ProofRevealed").withArgs(0, true);

    const p = await ctx.proof.getProof(0);
    expect(p.revealed).to.equal(true);
    expect(p.revealedValue).to.equal(true);

    await expect(
      ctx.proof.connect(ctx.alice).revealProof(0, Boolean(decrypted.decryptedValue), decrypted.signature),
    ).to.be.revertedWith("ProofOfBalance: already revealed");
  });

  it("balance < threshold reveals false", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx, ctx.alice, 500_000n); // half a microUSD
    await ctx.proof.connect(ctx.alice).createProof(enc, 1_000_000);

    const handle = (await ctx.proof.proofs(0)).met;
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const decrypted = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    expect(Boolean(decrypted.decryptedValue)).to.equal(false);
    await ctx.proof.connect(ctx.alice).revealProof(0, Boolean(decrypted.decryptedValue), decrypted.signature);
    expect((await ctx.proof.getProof(0)).revealedValue).to.equal(false);
  });

  it("unknown proofId revealProof reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.proof.connect(ctx.alice).revealProof(999, false, "0x"))
      .to.be.revertedWith("ProofOfBalance: unknown proof");
  });
});
