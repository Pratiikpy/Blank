import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable } from "@cofhe/sdk";
import { Interface, hexlify, parseUnits, randomBytes, solidityPackedKeccak256, Wallet } from "ethers";
import type { GateKind } from "../tasks/lib/funding-gate";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import {
  ethersGateIO,
  gateSpec,
  settleFunding,
  settleFundingExpectFunded,
  viemGateIO,
  type ViemGateContext,
} from "../tasks/lib/funding-gate";

// The hardhat tasks and scripts confirm funding-gate items through
// tasks/lib/funding-gate.ts. These tests run it against the mock coprocessor so
// both adapters, the unsupported-contract fallback and the already-settled
// path are exercised without a live network.

const usdc = (n: number) => parseUnits(String(n), 6);
const ACTIVE = 0n;
const VOID = 2n;
const FAST = { pollMs: 5, timeoutMs: 5_000, log: () => {} };

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const data = initArgs.length
    ? Factory.interface.encodeFunctionData("initialize", initArgs)
    : Factory.interface.encodeFunctionData("initialize");
  const Proxy = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await Proxy.deploy(await impl.getAddress(), data);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function fixture() {
  const [owner, alice, eve] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const usdcToken = await (await hre.ethers.getContractFactory("TestUSDC")).deploy();
  await usdcToken.waitForDeployment();
  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await usdcToken.getAddress(), "Blank USDC Vault", "bvUSDC", 6, await eventHub.getAddress(),
  ]);
  const claimLinks = await deployProxy("ClaimLinks", [await eventHub.getAddress()]);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await usdcToken.getAddress(), "USD Coin", "USDC", 6);
  await claimLinks.setTokenRegistry(await registry.getAddress());
  await eventHub.batchWhitelist([await claimLinks.getAddress()]);

  await usdcToken.mint(alice.address, usdc(1_000));
  await usdcToken.connect(alice).approve(await vault.getAddress(), usdc(1_000));
  await vault.connect(alice).shield(usdc(500));
  await vault.connect(alice).approvePlaintext(await claimLinks.getAddress(), (1n << 64n) - 1n);
  await vault.connect(eve).approvePlaintext(await claimLinks.getAddress(), (1n << 64n) - 1n);

  return { owner, alice, eve, client, usdcToken, vault, claimLinks };
}

// Creates a link and leaves it PendingFunding.
async function createPendingLink(ctx: Awaited<ReturnType<typeof fixture>>, sender: any, amount: bigint) {
  const key = new Wallet(solidityPackedKeccak256(["string", "bytes32"], ["gate-helper", hexlify(randomBytes(32))]));
  await hre.cofhe.connectWithHardhatSigner(ctx.client, sender);
  const enc = await ctx.client
    .encryptInputs([Encryptable.uint64(amount)])
    .setConsumingContract(await ctx.claimLinks.getAddress())
    .execute();
  await ctx.claimLinks.connect(sender).createLink(
    await ctx.vault.getAddress(), ...enc, key.address, 0, hre.ethers.ZeroAddress, 0, "",
  );
  return (await ctx.claimLinks.nextLinkId()) - 1n;
}

// A viem-shaped client over the hardhat provider, so the viem adapter's ABI
// parsing and argument order run for real. Only the calls the adapter makes.
function viemShim(ctx: Awaited<ReturnType<typeof fixture>>, signer: any): ViemGateContext {
  const provider = hre.ethers.provider;
  return {
    address: ctx.claimLinks.target as `0x${string}`,
    publicClient: {
      async readContract({ address, abi, functionName, args }: any) {
        const data = encodeFunctionData({ abi, functionName, args });
        const raw = await provider.call({ to: address, data });
        return decodeFunctionResult({ abi, functionName, data: raw as `0x${string}` });
      },
      async simulateContract({ address, abi, functionName, args }: any) {
        const data = encodeFunctionData({ abi, functionName, args });
        await provider.call({ to: address, from: signer.address, data });
      },
      async waitForTransactionReceipt({ hash }: any) {
        const r = await provider.getTransactionReceipt(hash);
        return { status: r!.status === 1 ? "success" : "reverted" };
      },
    },
    walletClient: {
      account: signer.address,
      async writeContract({ address, abi, functionName, args }: any) {
        const data = encodeFunctionData({ abi, functionName, args });
        const tx = await signer.sendTransaction({ to: address, data });
        return tx.hash;
      },
    },
  };
}

describe("tasks/lib/funding-gate", () => {
  it("ethers adapter: confirms a funded link and leaves it Active", async () => {
    const ctx = await loadFixture(fixture);
    const linkId = await createPendingLink(ctx, ctx.alice, usdc(50));
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(1n);

    const out = await settleFundingExpectFunded(
      ethersGateIO("claimLink", [linkId], await ctx.claimLinks.getAddress(), ctx.alice),
      ctx.client as never,
      FAST,
    );
    expect(out).to.include({ gated: true, funded: true, alreadySettled: false });
    expect((out as { confirmTx?: string }).confirmTx).to.match(/^0x[0-9a-f]{64}$/);
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(ACTIVE);
  });

  it("an unfunded link settles Void: settleFunding reports it, ExpectFunded throws", async () => {
    const ctx = await loadFixture(fixture);
    const first = await createPendingLink(ctx, ctx.eve, usdc(50));
    const second = await createPendingLink(ctx, ctx.eve, usdc(50));
    const addr = await ctx.claimLinks.getAddress();

    const out = await settleFunding(ethersGateIO("claimLink", [first], addr, ctx.eve), ctx.client as never, FAST);
    expect(out).to.include({ gated: true, funded: false, alreadySettled: false });
    expect(await ctx.claimLinks.fundingStatus(first)).to.equal(VOID);

    await expect(
      settleFundingExpectFunded(ethersGateIO("claimLink", [second], addr, ctx.eve), ctx.client as never, {
        ...FAST,
        label: "eve link",
      }),
    ).to.be.rejectedWith("eve link was voided by the funding gate");
    expect(await ctx.claimLinks.fundingStatus(second)).to.equal(VOID);
  });

  it("reports an item someone else already settled, without sending a transaction", async () => {
    const ctx = await loadFixture(fixture);
    const linkId = await createPendingLink(ctx, ctx.alice, usdc(10));
    const addr = await ctx.claimLinks.getAddress();
    await settleFunding(ethersGateIO("claimLink", [linkId], addr, ctx.eve), ctx.client as never, FAST);

    const again = await settleFunding(ethersGateIO("claimLink", [linkId], addr, ctx.alice), ctx.client as never, FAST);
    expect(again).to.include({ gated: true, funded: true, alreadySettled: true });
    expect((again as { confirmTx?: string }).confirmTx).to.equal(undefined);
  });

  it("falls back cleanly on a contract that has no funding gate", async () => {
    const ctx = await loadFixture(fixture);
    // TestUSDC has none of the gate views, standing in for a pre-upgrade proxy.
    const out = await settleFunding(
      ethersGateIO("claimLink", [0n], await ctx.usdcToken.getAddress(), ctx.alice),
      ctx.client as never,
      FAST,
    );
    expect(out).to.deep.equal({ gated: false, reason: "contract predates the funding gate" });
  });

  it("viem adapter: same flow through parseAbi and writeContract", async () => {
    const ctx = await loadFixture(fixture);
    const linkId = await createPendingLink(ctx, ctx.alice, usdc(25));

    const out = await settleFundingExpectFunded(
      viemGateIO("claimLink", [linkId], viemShim(ctx, ctx.eve)),
      ctx.client as never,
      FAST,
    );
    expect(out).to.include({ gated: true, funded: true, alreadySettled: false });
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(ACTIVE);
  });

  it("viem adapter: reports a pre-gate contract as not gated", async () => {
    const ctx = await loadFixture(fixture);
    const shim = viemShim(ctx, ctx.alice);
    shim.address = (await ctx.usdcToken.getAddress()) as `0x${string}`;
    const out = await settleFunding(viemGateIO("claimLink", [0n], shim), ctx.client as never, FAST);
    expect(out.gated).to.equal(false);
  });

  // Each kind must match the contract that serves it, selector for selector,
  // or a task would confirm against the wrong function on a live network.
  const KIND_CONTRACT: Record<GateKind, string> = {
    escrow: "EncryptedEscrow",
    claimLink: "ClaimLinks",
    gift: "GiftMoney",
    contribution: "EncryptedCrowdfund",
    refund: "EncryptedCrowdfund",
    tip: "CreatorHub",
    fill: "P2POfframp",
    purchase: "Storefront",
  };
  for (const [kind, contract] of Object.entries(KIND_CONTRACT) as [GateKind, string][]) {
    it(`${kind} spec matches the compiled ${contract} ABI`, async () => {
      const spec = gateSpec(kind);
      const compiled = new Interface((await hre.artifacts.readArtifact(contract)).abi);
      const mine = new Interface([...spec.abi]);
      expect(mine.fragments.length).to.equal(3);
      for (const fn of [spec.handleFn, spec.confirmFn, spec.statusFn]) {
        const want = mine.getFunction(fn)!;
        const got = compiled.getFunction(want.format("sighash"))!;
        expect(got, `${contract}.${fn}`).to.not.equal(null);
        expect(got.selector).to.equal(want.selector);
        expect(got.stateMutability).to.equal(want.stateMutability);
        expect(got.outputs.map((o) => o.type)).to.deep.equal(want.outputs.map((o) => o.type));
      }
    });
  }
});
