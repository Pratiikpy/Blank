import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// InvoiceApprovalResolver is a plain (non-FHE) condition resolver, so these
// tests need no cofhe mock. One signer plays "the escrow" (the caller that
// registers a condition); conditions are keyed by (escrow, escrowId).

const abi = hre.ethers.AbiCoder.defaultAbiCoder();
const encodeData = (buyer: string, deadline: number | bigint) =>
  abi.encode(["address", "uint64"], [buyer, deadline]);

async function deployFixture() {
  // escrowSigner stands in for the escrow contract; buyer + stranger are EOAs.
  const [escrowSigner, buyer, stranger] = await hre.ethers.getSigners();
  const Resolver = await hre.ethers.getContractFactory("InvoiceApprovalResolver");
  const resolver = await Resolver.deploy();
  await resolver.waitForDeployment();
  return { resolver, escrowSigner, buyer, stranger, escrow: escrowSigner.address };
}

describe("InvoiceApprovalResolver", () => {
  it("stores config on onConditionSet and exposes it via getCondition", async () => {
    const { resolver, escrowSigner, buyer, escrow } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 30 * 86400;
    await expect(resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline)))
      .to.emit(resolver, "ConditionSet")
      .withArgs(escrow, 0, buyer.address, deadline);

    const c = await resolver.getCondition(escrow, 0);
    expect(c.buyer).to.equal(buyer.address);
    expect(c.autoReleaseDeadline).to.equal(deadline);
    expect(c.isApproved).to.equal(false);
    expect(c.set).to.equal(true);
  });

  it("rejects a second onConditionSet for the same escrowId from the same escrow", async () => {
    const { resolver, escrowSigner, buyer } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 30 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));
    await expect(
      resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline)),
    ).to.be.revertedWithCustomError(resolver, "AlreadyConfigured");
  });

  // M5 exploit: an attacker used to pre-set the next sequential escrowId,
  // which made the real escrow's create revert (AlreadyConfigured) or bound
  // the attacker's buyer and deadline to it.
  it("a stranger pre-setting escrowId cannot block or hijack the real escrow's condition", async () => {
    const { resolver, escrowSigner, buyer, stranger, escrow } = await loadFixture(deployFixture);
    const soon = (await time.latest()) + 60;
    await resolver.connect(stranger).onConditionSet(0, encodeData(stranger.address, soon));

    const deadline = (await time.latest()) + 30 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));
    const c = await resolver.getCondition(escrow, 0);
    expect(c.buyer).to.equal(buyer.address);

    await time.increase(120);
    // The stranger's condition is met for the stranger only.
    expect(await resolver.connect(stranger).isConditionMet(0)).to.equal(true);
    expect(await resolver.connect(escrowSigner).isConditionMet(0)).to.equal(false);
    // And the stranger cannot approve the real escrow's condition.
    await expect(resolver.connect(stranger).approve(escrow, 0)).to.be.revertedWithCustomError(resolver, "NotBuyer");
  });

  it("rejects zero buyer and a past deadline", async () => {
    const { resolver, escrowSigner, buyer } = await loadFixture(deployFixture);
    const future = (await time.latest()) + 30 * 86400;
    await expect(
      resolver.connect(escrowSigner).onConditionSet(0, encodeData(hre.ethers.ZeroAddress, future)),
    ).to.be.revertedWithCustomError(resolver, "InvalidBuyer");
    const past = (await time.latest()) - 1;
    await expect(
      resolver.connect(escrowSigner).onConditionSet(1, encodeData(buyer.address, past)),
    ).to.be.revertedWithCustomError(resolver, "InvalidDeadline");
  });

  it("is not met before approval or deadline, met after the buyer approves", async () => {
    const { resolver, escrowSigner, buyer, escrow } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 30 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));

    expect(await resolver.connect(escrowSigner).isConditionMet(0)).to.equal(false);

    await expect(resolver.connect(buyer).approve(escrow, 0))
      .to.emit(resolver, "Approved")
      .withArgs(escrow, 0, buyer.address);
    expect(await resolver.connect(escrowSigner).isConditionMet(0)).to.equal(true);
    expect(await resolver.approved(escrow, 0)).to.equal(true);
  });

  it("is met once the auto-release deadline passes, with no approval", async () => {
    const { resolver, escrowSigner, buyer } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 2 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));

    expect(await resolver.connect(escrowSigner).isConditionMet(0)).to.equal(false);
    await time.increase(2 * 86400 + 1);
    expect(await resolver.connect(escrowSigner).isConditionMet(0)).to.equal(true);
  });

  it("only the recorded buyer can approve", async () => {
    const { resolver, escrowSigner, buyer, stranger, escrow } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 30 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));
    await expect(resolver.connect(stranger).approve(escrow, 0)).to.be.revertedWithCustomError(resolver, "NotBuyer");
  });

  it("approve on an unconfigured escrow reverts", async () => {
    const { resolver, buyer, escrow } = await loadFixture(deployFixture);
    await expect(resolver.connect(buyer).approve(escrow, 7)).to.be.revertedWithCustomError(resolver, "NotConfigured");
  });

  it("isConditionMet only sees the caller's own conditions", async () => {
    const { resolver, escrowSigner, buyer, stranger } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 30 * 86400;
    await resolver.connect(escrowSigner).onConditionSet(0, encodeData(buyer.address, deadline));
    await time.increase(30 * 86400 + 1);
    expect(await resolver.connect(stranger).isConditionMet(0)).to.equal(false);
  });

  it("advertises the IConditionResolver interface via ERC-165", async () => {
    const { resolver } = await loadFixture(deployFixture);
    const id1 = BigInt(resolver.interface.getFunction("isConditionMet").selector);
    const id2 = BigInt(resolver.interface.getFunction("onConditionSet").selector);
    const ifaceId = "0x" + (id1 ^ id2).toString(16).padStart(8, "0");
    expect(await resolver.supportsInterface(ifaceId)).to.equal(true);
    expect(await resolver.supportsInterface("0xffffffff")).to.equal(false);
  });
});
