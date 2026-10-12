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

describe("P2PExchange — createOffer guards", () => {
  it("rejects same tokenGive == tokenWant", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.p2p.connect(ctx.maker).createOffer(
        await ctx.vaultGive.getAddress(),
        await ctx.vaultGive.getAddress(),
        usdc(100), usdc(100), (await time.latest()) + 86400,
      ),
    ).to.be.revertedWith("P2PExchange: same token");
  });

  it("rejects zero amountGive or amountWant", async () => {
    const ctx = await loadFixture(deployFixture);
    const expiry = (await time.latest()) + 86400;
    await expect(
      ctx.p2p.connect(ctx.maker).createOffer(
        await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
        0, usdc(100), expiry,
      ),
    ).to.be.revertedWith("P2PExchange: zero amount");
    await expect(
      ctx.p2p.connect(ctx.maker).createOffer(
        await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
        usdc(100), 0, expiry,
      ),
    ).to.be.revertedWith("P2PExchange: zero amount");
  });

  it("rejects expiry in the past or equal to now", async () => {
    const ctx = await loadFixture(deployFixture);
    const now = await time.latest();
    await expect(
      ctx.p2p.connect(ctx.maker).createOffer(
        await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
        usdc(100), usdc(100), now,
      ),
    ).to.be.revertedWith("P2PExchange: expired");
  });
});

describe("P2PExchange — fillOffer guards", () => {
  it("rejects self-fill (maker filling own offer)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(100), (await time.latest()) + 86400,
    );
    const pair = await encPair(ctx.client, ctx.maker, usdc(100), usdc(100), await ctx.p2p.getAddress());
    await expect(
      ctx.p2p.connect(ctx.maker).fillOffer(0, pair[0], pair[1], pair[2]),
    ).to.be.revertedWith("P2PExchange: self-fill");
  });

  it("rejects fillOffer on a cancelled offer", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(100), (await time.latest()) + 86400,
    );
    await ctx.p2p.connect(ctx.maker).cancelOffer(0);
    const pair = await encPair(ctx.client, ctx.taker, usdc(100), usdc(100), await ctx.p2p.getAddress());
    await expect(
      ctx.p2p.connect(ctx.taker).fillOffer(0, pair[0], pair[1], pair[2]),
    ).to.be.revertedWith("P2PExchange: not available");
  });
});

describe("P2PExchange — #353 anti-overdraw clamp (critical security pin)", () => {
  it("taker requesting MORE than amountGive is clamped to amountGive (maker loses no more than advertised)", async () => {
    // Setup: maker advertises an offer to give 100 USDC for 50 USDT.
    // Malicious taker tries to drain maker's full 1_000 USDC balance by
    // encrypting amountGive=1_000 in encMakerPayment. The clamp at
    // P2PExchange.sol:129-131 forces the cap to o.amountGive=100, so
    // the maker only loses what they advertised.
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(50), (await time.latest()) + 86400,
    );

    // Taker pays the legitimate amountWant (50 USDT) but requests
    // amountGive=1_000 USDC (way over the offer cap).
    const pair = await encPair(ctx.client, ctx.taker, usdc(50), usdc(1_000), await ctx.p2p.getAddress());
    await ctx.p2p.connect(ctx.taker).fillOffer(0, pair[0], pair[1], pair[2]);

    // Maker loses exactly 100 USDC (clamp held), not 1_000.
    await mock_expectPlaintext(
      ctx.maker.provider,
      await ctx.vaultGive.balanceOf(ctx.maker.address),
      usdc(900), // started 1_000, minus the clamped 100
    );
    await mock_expectPlaintext(
      ctx.taker.provider,
      await ctx.vaultGive.balanceOf(ctx.taker.address),
      usdc(100), // taker received exactly amountGive
    );

    // Taker also paid the 50 USDT they encrypted.
    await mock_expectPlaintext(
      ctx.taker.provider,
      await ctx.vaultWant.balanceOf(ctx.taker.address),
      usdc(950),
    );
    await mock_expectPlaintext(
      ctx.maker.provider,
      await ctx.vaultWant.balanceOf(ctx.maker.address),
      usdc(50),
    );
  });

  it("happy path: taker requests EXACTLY amountGive — full atomic swap", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(50), (await time.latest()) + 86400,
    );
    const pair = await encPair(ctx.client, ctx.taker, usdc(50), usdc(100), await ctx.p2p.getAddress());
    await expect(
      ctx.p2p.connect(ctx.taker).fillOffer(0, pair[0], pair[1], pair[2]),
    ).to.emit(ctx.p2p, "OfferFilled");

    // Offer state: filled, inactive.
    const o = await ctx.p2p.offers(0);
    expect(o.filled).to.equal(true);
    expect(o.active).to.equal(false);
  });
});

describe("P2PExchange — validation flow (publish + read)", () => {
  it("matching-amounts trade resolves to (isValid=true, isReady=true)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(50), (await time.latest()) + 86400,
    );
    const pair = await encPair(ctx.client, ctx.taker, usdc(50), usdc(100), await ctx.p2p.getAddress());
    await ctx.p2p.connect(ctx.taker).fillOffer(0, pair[0], pair[1], pair[2]);

    // Off-chain decrypt the validation handle, publish it on-chain.
    const handle = await ctx.p2p.getValidationHandle(0);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.taker);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    await ctx.p2p.connect(ctx.taker).publishTradeValidation(0, proof.decryptedValue, proof.signature);

    const [isValid, isReady] = await ctx.p2p.getTradeValidation(0);
    expect(isReady).to.equal(true);
    expect(isValid).to.equal(true);
  });
});

describe("P2PExchange — cancelOffer", () => {
  it("rejects cancel from non-maker", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(100), (await time.latest()) + 86400,
    );
    await expect(
      ctx.p2p.connect(ctx.taker).cancelOffer(0),
    ).to.be.revertedWith("P2PExchange: not maker");
  });

  it("rejects cancel of an already-filled offer", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(100), usdc(50), (await time.latest()) + 86400,
    );
    const pair = await encPair(ctx.client, ctx.taker, usdc(50), usdc(100), await ctx.p2p.getAddress());
    await ctx.p2p.connect(ctx.taker).fillOffer(0, pair[0], pair[1], pair[2]);
    await expect(
      ctx.p2p.connect(ctx.maker).cancelOffer(0),
    ).to.be.revertedWith("P2PExchange: not available");
  });
});

describe("P2PExchange — getActiveOffers filtering", () => {
  it("excludes cancelled, filled, and expired offers", async () => {
    const ctx = await loadFixture(deployFixture);
    const future = (await time.latest()) + 86400;

    // Offer 0 — will be cancelled
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(10), usdc(10), future,
    );
    // Offer 1 — will be filled
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(20), usdc(10), future,
    );
    // Offer 2 — short expiry, will be expired
    const shortExpiry = (await time.latest()) + 60;
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(30), usdc(10), shortExpiry,
    );
    // Offer 3 — stays active
    await ctx.p2p.connect(ctx.maker).createOffer(
      await ctx.vaultGive.getAddress(), await ctx.vaultWant.getAddress(),
      usdc(40), usdc(10), future,
    );

    await ctx.p2p.connect(ctx.maker).cancelOffer(0);
    const p1 = await encPair(ctx.client, ctx.taker, usdc(10), usdc(20), await ctx.p2p.getAddress());
    await ctx.p2p.connect(ctx.taker).fillOffer(1, p1[0], p1[1], p1[2]);
    await time.increaseTo(shortExpiry + 10);

    const active = await ctx.p2p.getActiveOffers(0, 10);
    expect(active.length).to.equal(1);
    expect(active[0].amountGive).to.equal(usdc(40)); // only offer 3 survived
  });
});
