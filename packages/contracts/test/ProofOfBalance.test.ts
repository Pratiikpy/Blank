import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable } from "@cofhe/sdk";

// ProofOfBalance is retired: the "balance" was a value the prover encrypted
// themselves, so a true verdict proved nothing about funds.

async function deployProxy(name: string) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), Factory.interface.encodeFunctionData("initialize"));
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function deployFixture() {
  const [owner, alice] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);
  const proof = await deployProxy("ProofOfBalance");
  return { owner, alice, client, proof };
}

describe("ProofOfBalance (retired)", () => {
  it("createProof reverts, even for a self-chosen balance that would have 'proven' $1B", async () => {
    const ctx = await loadFixture(deployFixture);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
    const enc = await ctx.client
      .encryptInputs([Encryptable.uint64((1n << 64n) - 1n)])
      .setConsumingContract(await ctx.proof.getAddress())
      .execute();
    await expect(ctx.proof.connect(ctx.alice).createProof(...enc, 1_000_000_000_000_000n))
      .to.be.revertedWith("ProofOfBalance: retired");
    expect(await ctx.proof.nextProofId()).to.equal(0n);
  });

  it("revealProof reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.proof.connect(ctx.alice).revealProof(0, true, "0x"))
      .to.be.revertedWith("ProofOfBalance: retired");
  });

  it("getProof still reads (empty) records", async () => {
    const ctx = await loadFixture(deployFixture);
    const p = await ctx.proof.getProof(0);
    expect(p.prover).to.equal(hre.ethers.ZeroAddress);
    expect(p.revealed).to.equal(false);
  });
});
