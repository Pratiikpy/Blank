import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { keccak256, parseUnits, toUtf8Bytes } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  Storefront — three sale modes (Fixed / Auction / PWYW)
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const MODE_FIXED = 0;
const MODE_AUCTION = 1;
const MODE_PWYW = 2;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function deployProxy(contractName: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();

  const initData =
    initArgs.length > 0
      ? Factory.interface.encodeFunctionData("initialize", initArgs)
      : Factory.interface.encodeFunctionData("initialize");

  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function deployFixture() {
  const [owner, alice, bob, charlie, dave] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(),
    "Blank USDC Vault",
    "bvUSDC",
    USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const storefront = await deployProxy("Storefront", [await eventHub.getAddress()]);

  await eventHub.batchWhitelist([await storefront.getAddress()]);

  // Mint everyone TestUSDC + shield it.
  for (const signer of [alice, bob, charlie, dave]) {
    await testUSDC.mint(signer.address, usdc(10_000));
    await testUSDC.connect(signer).approve(await vault.getAddress(), usdc(10_000));
    await vault.connect(signer).shield(usdc(1_000));
  }

  // Each gives Storefront infinite plaintext allowance on the vault.
  const MAX = (1n << 64n) - 1n;
  for (const signer of [alice, bob, charlie, dave]) {
    await vault.connect(signer).approvePlaintext(await storefront.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, dave, client, testUSDC, vault, storefront };
}

async function encUint64(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

describe("Storefront", () => {
  describe("createListing", () => {
    it("creates a fixed-price listing", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(10));

      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED,
        await ctx.vault.getAddress(),
        enc,
        0,
        "Hand-bound notebook",
        keccak256(toUtf8Bytes("ipfs://desc")),
        "DM @creator",
      );

      const l = await ctx.storefront.getListing(0);
      expect(l.seller).to.equal(ctx.alice.address);
      expect(l.mode).to.equal(MODE_FIXED);
      expect(l.title).to.equal("Hand-bound notebook");
      expect(l.active).to.equal(true);
    });

    it("rejects zero vault", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(1));
      await expect(
        ctx.storefront.connect(ctx.alice).createListing(
          MODE_FIXED,
          hre.ethers.ZeroAddress,
          enc,
          0,
          "x",
          ZERO_BYTES32,
          "",
        ),
      ).to.be.revertedWith("Storefront: zero vault");
    });

    it("rejects auction window out of range", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(1));
      await expect(
        ctx.storefront.connect(ctx.alice).createListing(
          MODE_AUCTION,
          await ctx.vault.getAddress(),
          enc,
          60, // 1 minute, below MIN_AUCTION_SECONDS (1 hour)
          "fast auction",
          ZERO_BYTES32,
          "",
        ),
      ).to.be.revertedWith("Storefront: auction window out of range");
    });
  });

  describe("FixedPrice flow", () => {
    it("buyer matches price → seller paid", async () => {
      const ctx = await loadFixture(deployFixture);
      const encPrice = await encUint64(ctx.client, ctx.alice, usdc(10));

      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED,
        await ctx.vault.getAddress(),
        encPrice,
        0,
        "Item A",
        ZERO_BYTES32,
        "",
      );

      const aliceBefore = await ctx.vault.balanceOf(ctx.alice.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceBefore, usdc(1_000));

      const encOffer = await encUint64(ctx.client, ctx.bob, usdc(10));
      await ctx.storefront.connect(ctx.bob).buyFixed(0, encOffer, ZERO_BYTES32);

      const aliceAfter = await ctx.vault.balanceOf(ctx.alice.address);
      const bobAfter = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceAfter, usdc(1_010));
      await mock_expectPlaintext(ctx.bob.provider, bobAfter, usdc(990));
    });

    it("buyer offers wrong amount → 0 transferred (FHE.select)", async () => {
      const ctx = await loadFixture(deployFixture);
      const encPrice = await encUint64(ctx.client, ctx.alice, usdc(10));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED,
        await ctx.vault.getAddress(),
        encPrice,
        0,
        "Item B",
        ZERO_BYTES32,
        "",
      );

      const wrongOffer = await encUint64(ctx.client, ctx.bob, usdc(5));
      await ctx.storefront.connect(ctx.bob).buyFixed(0, wrongOffer, ZERO_BYTES32);

      const aliceAfter = await ctx.vault.balanceOf(ctx.alice.address);
      const bobAfter = await ctx.vault.balanceOf(ctx.bob.address);
      // Mismatch → no transfer.
      await mock_expectPlaintext(ctx.alice.provider, aliceAfter, usdc(1_000));
      await mock_expectPlaintext(ctx.bob.provider, bobAfter, usdc(1_000));
    });

    it("seller cannot buy own listing", async () => {
      const ctx = await loadFixture(deployFixture);
      const encPrice = await encUint64(ctx.client, ctx.alice, usdc(10));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED, await ctx.vault.getAddress(), encPrice, 0, "x", ZERO_BYTES32, "",
      );
      const enc = await encUint64(ctx.client, ctx.alice, usdc(10));
      await expect(
        ctx.storefront.connect(ctx.alice).buyFixed(0, enc, ZERO_BYTES32),
      ).to.be.revertedWith("Storefront: seller cannot buy self-listing");
    });
  });

  describe("Auction flow", () => {
    it("end-to-end: 3 bids, close, reveal, winner pays seller, losers refunded", async () => {
      const ctx = await loadFixture(deployFixture);
      const encMin = await encUint64(ctx.client, ctx.alice, usdc(0));

      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_AUCTION,
        await ctx.vault.getAddress(),
        encMin,
        2 * 3600, // 2-hour auction
        "Limited drop",
        ZERO_BYTES32,
        "",
      );

      // 3 bids: bob 5, charlie 10, dave 8. dave is the LAST one to update the
      // running max heuristically (his bid is checked last). The contract
      // documents this is heuristic — the seller decrypts to confirm winner.
      // For deterministic test result, use ascending bids so the LAST bid IS
      // the highest. 5 → 8 → 10.
      const bobBid = await encUint64(ctx.client, ctx.bob, usdc(5));
      await ctx.storefront.connect(ctx.bob).placeBid(0, bobBid);

      const charlieBid = await encUint64(ctx.client, ctx.charlie, usdc(8));
      await ctx.storefront.connect(ctx.charlie).placeBid(0, charlieBid);

      const daveBid = await encUint64(ctx.client, ctx.dave, usdc(10));
      await ctx.storefront.connect(ctx.dave).placeBid(0, daveBid);

      expect(await ctx.storefront.getBidCount(0)).to.equal(3);

      // Funds locked in contract.
      const sfAddr = await ctx.storefront.getAddress();
      const sfBalance = await ctx.vault.balanceOf(sfAddr);
      await mock_expectPlaintext(ctx.alice.provider, sfBalance, usdc(23)); // 5+8+10

      // Close after deadline. Phase B: closeAuction stores encrypted winnerIdx
      // but does NOT set l.winner; revealWinner is the second step.
      await time.increase(2 * 3600 + 1);
      await ctx.storefront.connect(ctx.alice).closeAuction(0);

      const lAfterClose = await ctx.storefront.getListing(0);
      expect(lAfterClose.closed).to.equal(true);
      expect(lAfterClose.winner).to.equal(hre.ethers.ZeroAddress);

      // Decrypt winner index off-chain, then reveal on-chain.
      const winnerIdxHandle = await ctx.storefront.getWinnerIdxHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
      const proof = await ctx.client.decryptForTx(winnerIdxHandle, FheTypes.Uint8).withoutPermit().execute();
      await ctx.storefront.connect(ctx.alice).revealWinner(0, Number(proof.decryptedValue), proof.signature);

      const lAfterReveal = await ctx.storefront.getListing(0);
      // FHE.max picks the highest bid. Dave bid 10 (last + highest) → winner.
      expect(lAfterReveal.winner).to.equal(ctx.dave.address);

      // Winner claims.
      await ctx.storefront.connect(ctx.dave).claimAuctionWin(0, ZERO_BYTES32);

      const aliceAfter = await ctx.vault.balanceOf(ctx.alice.address);
      // Alice received the WINNING BID amount via FHE.max, which equals 10.
      await mock_expectPlaintext(ctx.alice.provider, aliceAfter, usdc(1_010));

      // Losers refund: bob (idx 0) and charlie (idx 1).
      await ctx.storefront.connect(ctx.bob).refundLoserBid(0, 0);
      await ctx.storefront.connect(ctx.charlie).refundLoserBid(0, 1);

      const bobAfter = await ctx.vault.balanceOf(ctx.bob.address);
      const charlieAfter = await ctx.vault.balanceOf(ctx.charlie.address);
      await mock_expectPlaintext(ctx.bob.provider, bobAfter, usdc(1_000));
      await mock_expectPlaintext(ctx.charlie.provider, charlieAfter, usdc(1_000));

      // Dave (winner) cannot ALSO refund — his bid was marked refunded on claim.
      await expect(
        ctx.storefront.connect(ctx.dave).refundLoserBid(0, 2),
      ).to.be.revertedWith("Storefront: already refunded");
    });

    it("cannot bid after close", async () => {
      const ctx = await loadFixture(deployFixture);
      const encMin = await encUint64(ctx.client, ctx.alice, usdc(0));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_AUCTION, await ctx.vault.getAddress(), encMin, 3600, "auction A", ZERO_BYTES32, "",
      );

      await time.increase(3601);
      const enc = await encUint64(ctx.client, ctx.bob, usdc(5));
      await expect(
        ctx.storefront.connect(ctx.bob).placeBid(0, enc),
      ).to.be.revertedWith("Storefront: auction closed");
    });

    // §1.3 + §1.4 of BEST_VERSION_FULL_PLAN: differentiating winner test.
    // Bids 5, 10, 7 (NOT ascending). The previous last-bidder-wins bug would
    // have returned dave (last bidder = $7). The proper FHE-tournament impl
    // returns charlie (highest = $10). This test PASSES only when the fix
    // is correct; ascending-bid tests cannot differentiate.
    it("5/10/7 bids: highest bidder wins (not last)", async () => {
      const ctx = await loadFixture(deployFixture);
      const encMin = await encUint64(ctx.client, ctx.alice, usdc(0));

      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_AUCTION,
        await ctx.vault.getAddress(),
        encMin,
        2 * 3600,
        "Differentiating drop",
        ZERO_BYTES32,
        "",
      );

      const bobBid = await encUint64(ctx.client, ctx.bob, usdc(5));
      await ctx.storefront.connect(ctx.bob).placeBid(0, bobBid);

      const charlieBid = await encUint64(ctx.client, ctx.charlie, usdc(10));
      await ctx.storefront.connect(ctx.charlie).placeBid(0, charlieBid);

      const daveBid = await encUint64(ctx.client, ctx.dave, usdc(7));
      await ctx.storefront.connect(ctx.dave).placeBid(0, daveBid);

      await time.increase(2 * 3600 + 1);
      await ctx.storefront.connect(ctx.alice).closeAuction(0);

      // Winner not yet revealed.
      const lMid = await ctx.storefront.getListing(0);
      expect(lMid.closed).to.equal(true);
      expect(lMid.winner).to.equal(hre.ethers.ZeroAddress);

      // Decrypt winner index.
      const winnerIdxHandle = await ctx.storefront.getWinnerIdxHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
      const proof = await ctx.client.decryptForTx(winnerIdxHandle, FheTypes.Uint8).withoutPermit().execute();
      // Charlie was placed at index 1 (bob=0, charlie=1, dave=2).
      expect(Number(proof.decryptedValue)).to.equal(1);

      await ctx.storefront.connect(ctx.alice).revealWinner(0, Number(proof.decryptedValue), proof.signature);

      const lAfterReveal = await ctx.storefront.getListing(0);
      expect(lAfterReveal.winner).to.equal(ctx.charlie.address);
    });

    it("revealWinner rejects double-reveal", async () => {
      const ctx = await loadFixture(deployFixture);
      const encMin = await encUint64(ctx.client, ctx.alice, usdc(0));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_AUCTION, await ctx.vault.getAddress(), encMin, 3600, "auction X", ZERO_BYTES32, "",
      );
      const bobBid = await encUint64(ctx.client, ctx.bob, usdc(5));
      await ctx.storefront.connect(ctx.bob).placeBid(0, bobBid);
      await time.increase(3601);
      await ctx.storefront.connect(ctx.alice).closeAuction(0);

      const winnerIdxHandle = await ctx.storefront.getWinnerIdxHandle(0);
      await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.alice);
      const proof = await ctx.client.decryptForTx(winnerIdxHandle, FheTypes.Uint8).withoutPermit().execute();
      await ctx.storefront.connect(ctx.alice).revealWinner(0, Number(proof.decryptedValue), proof.signature);

      await expect(
        ctx.storefront.connect(ctx.alice).revealWinner(0, Number(proof.decryptedValue), proof.signature),
      ).to.be.revertedWith("Storefront: winner already revealed");
    });
  });

  describe("PWYW flow", () => {
    it("pays any amount → seller receives it", async () => {
      const ctx = await loadFixture(deployFixture);
      const ignoredPrice = await encUint64(ctx.client, ctx.alice, usdc(0));

      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_PWYW,
        await ctx.vault.getAddress(),
        ignoredPrice,
        0,
        "Tip jar",
        ZERO_BYTES32,
        "",
      );

      const tip1 = await encUint64(ctx.client, ctx.bob, usdc(7));
      await ctx.storefront.connect(ctx.bob).payPWYW(0, tip1, ZERO_BYTES32);

      const tip2 = await encUint64(ctx.client, ctx.charlie, usdc(3));
      await ctx.storefront.connect(ctx.charlie).payPWYW(0, tip2, ZERO_BYTES32);

      const aliceAfter = await ctx.vault.balanceOf(ctx.alice.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceAfter, usdc(1_010));
    });
  });

  describe("deactivate", () => {
    it("seller deactivates own listing", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(1));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED, await ctx.vault.getAddress(), enc, 0, "x", ZERO_BYTES32, "",
      );
      await ctx.storefront.connect(ctx.alice).deactivateListing(0);
      const l = await ctx.storefront.getListing(0);
      expect(l.active).to.equal(false);
    });

    it("non-seller cannot deactivate", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(1));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_FIXED, await ctx.vault.getAddress(), enc, 0, "x", ZERO_BYTES32, "",
      );
      await expect(
        ctx.storefront.connect(ctx.bob).deactivateListing(0),
      ).to.be.revertedWith("Storefront: not seller");
    });

    it("cannot deactivate auction with bids", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encUint64(ctx.client, ctx.alice, usdc(0));
      await ctx.storefront.connect(ctx.alice).createListing(
        MODE_AUCTION, await ctx.vault.getAddress(), enc, 3600, "auction B", ZERO_BYTES32, "",
      );
      const bid = await encUint64(ctx.client, ctx.bob, usdc(5));
      await ctx.storefront.connect(ctx.bob).placeBid(0, bid);
      await expect(
        ctx.storefront.connect(ctx.alice).deactivateListing(0),
      ).to.be.revertedWith("Storefront: cannot deactivate live auction");
    });
  });

  // §2.7 + §15.3.1 event-assertion gap: PaymentReceiptsSet fires on
  // setPaymentReceipts and carries previous + current.
  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(ctx.storefront.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.storefront, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);

      expect(await ctx.storefront.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = "0x000000000000000000000000000000000000dEaD";
      const second = "0x000000000000000000000000000000000000bEEF";

      await ctx.storefront.connect(ctx.owner).setPaymentReceipts(first);

      await expect(ctx.storefront.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.storefront, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(
        ctx.storefront.connect(ctx.alice).setPaymentReceipts(fake),
      ).to.be.reverted;
    });
  });
});
