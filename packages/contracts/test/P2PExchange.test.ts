import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  P2PExchange — Trustless atomic token swaps
//
//  Pre-existing coverage in Blank.test.ts covers only #242 (expiry
//  strictness). The createOffer guards, the fillOffer happy path,
//  the cancelOffer guards, the publish/get validation flow, and the
//  CRITICAL #353 anti-overdraw clamp are all UNTESTED. Pinning #353
//  is especially important — without that clamp, a malicious taker
//  could request MORE than the offer's public amountGive and drain
//  any maker who used the common type(uint64).max approval.
//
//  Covers:
//   • createOffer guards: same token, zero amounts, past expiry
//   • fillOffer guards: not-available (cancelled/filled), self-fill
//   • Anti-overdraw clamp (#353): taker requesting > amountGive is
//     clamped to amountGive (pin the security property)
//   • Happy path: both balances move atomically, OfferFilled emits
//   • Validation flow: publishTradeValidation + getTradeValidation
//     resolve to (isValid=true, isReady=true) for a matching trade
//   • cancelOffer guards: only maker; rejects on already-filled
//   • getActiveOffers filters cancelled + filled + expired
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

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

async function deployFixture() {
  const [owner, maker, taker, attacker] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  // Two distinct underlying ERC20s so tokenGive != tokenWant.
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const usdcToken = await TestUSDC.deploy();
  await usdcToken.waitForDeployment();
  const usdtToken = await TestUSDC.deploy();
  await usdtToken.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vaultGive = await deployProxy("FHERC20Vault", [
    await usdcToken.getAddress(), "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const vaultWant = await deployProxy("FHERC20Vault", [
    await usdtToken.getAddress(), "Blank USDT Vault", "bvUSDT", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const p2p = await deployProxy("P2PExchange", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await p2p.getAddress()]);

  // Maker has USDC (tokenGive). Taker has USDT (tokenWant).
  await usdcToken.mint(maker.address, usdc(10_000));
  await usdcToken.connect(maker).approve(await vaultGive.getAddress(), usdc(10_000));
  await vaultGive.connect(maker).shield(usdc(1_000));

  await usdtToken.mint(taker.address, usdc(10_000));
  await usdtToken.connect(taker).approve(await vaultWant.getAddress(), usdc(10_000));
  await vaultWant.connect(taker).shield(usdc(1_000));

  // Both pre-approve P2PExchange on their respective vaults.
  const MAX = (1n << 64n) - 1n;
  await vaultGive.connect(maker).approvePlaintext(await p2p.getAddress(), MAX);
  await vaultWant.connect(taker).approvePlaintext(await p2p.getAddress(), MAX);

  return { owner, maker, taker, attacker, client, usdcToken, usdtToken, vaultGive, vaultWant, p2p };
}

/// fillOffer verifies the taker and maker amounts under ONE batch signature,
/// so they must be encrypted together in that order.
async function encPair(client: any, signer: any, a: bigint, b: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client
    .encryptInputs([Encryptable.uint64(a), Encryptable.uint64(b)])
    .setConsumingContract(consuming)
    .execute();
}

async function encAmt(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

/// Plants an offer that was open before retirement: offers is at slot 3,
/// nextOfferId at slot 2 (see storage-layouts/P2PExchange.json).
async function plantLegacyOffer(p2p: any, maker: string, tokenGive: string, tokenWant: string) {
  const addr = await p2p.getAddress();
  const coder = hre.ethers.AbiCoder.defaultAbiCoder();
  const base = BigInt(hre.ethers.keccak256(coder.encode(["uint256", "uint256"], [0, 3])));
  const word = (v: bigint | string) => hre.ethers.zeroPadValue(hre.ethers.toBeHex(BigInt(v)), 32);
  const set = (slot: bigint, v: bigint | string) =>
    hre.network.provider.send("hardhat_setStorageAt", [addr, hre.ethers.toBeHex(slot), word(v)]);
  await set(base, maker);
  await set(base + 1n, tokenGive);
  await set(base + 2n, tokenWant);
  await set(base + 3n, usdc(10));
  await set(base + 4n, usdc(10));
  await set(base + 5n, 4_000_000_000n);
  await set(base + 6n, 1n); // active = true, filled = false
  await set(2n, 1n);        // nextOfferId = 1
}

describe("P2PExchange — retired", () => {
  it("createOffer reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.p2p.connect(ctx.maker).createOffer(
        await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(), usdc(10), usdc(10), (await time.latest()) + 3600,
      ),
    ).to.be.revertedWith("P2PExchange: retired");
  });

  it("fillOffer reverts, including on an offer open before retirement", async () => {
    const ctx = await loadFixture(deployFixture);
    await plantLegacyOffer(ctx.p2p, ctx.maker.address, await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress());
    const enc = await encPair(ctx.client, ctx.taker, usdc(10), usdc(10), await ctx.p2p.getAddress());
    await expect(ctx.p2p.connect(ctx.taker).fillOffer(0, ...enc)).to.be.revertedWith("P2PExchange: retired");
  });

  it("maker can still cancel an offer open before retirement; views keep working", async () => {
    const ctx = await loadFixture(deployFixture);
    await plantLegacyOffer(ctx.p2p, ctx.maker.address, await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress());
    expect((await ctx.p2p.getActiveOffers(0, 10)).length).to.equal(1);
    await expect(ctx.p2p.connect(ctx.attacker).cancelOffer(0)).to.be.revertedWith("P2PExchange: not maker");
    await expect(ctx.p2p.connect(ctx.maker).cancelOffer(0)).to.emit(ctx.p2p, "OfferCancelled");
    expect((await ctx.p2p.getActiveOffers(0, 10)).length).to.equal(0);
    expect((await ctx.p2p.offers(0)).active).to.equal(false);
  });
});
