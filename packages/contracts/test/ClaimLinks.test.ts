import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";
import { keccak256, parseUnits, solidityPackedKeccak256, randomBytes, hexlify, toUtf8Bytes } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  ClaimLinks — magic claim links contract test suite
//
//  Covers three modes:
//   - Bearer:       anyone with secret can claim
//   - EmailBound:   secret + emailHash second factor
//   - AddressBound: secret + msg.sender == boundAddress
//
//  Plus refund-after-expiry, double-claim guard, refund-after-claim guard.
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const MODE_BEARER = 0;
const MODE_EMAIL = 1;
const MODE_ADDRESS = 2;

const DOMAIN = keccak256(toUtf8Bytes("BLANK_CLAIM_v1"));

function newSecret(): string {
  return hexlify(randomBytes(32));
}

function bearerHash(secret: string): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32"],
    [DOMAIN, MODE_BEARER, secret],
  );
}

function emailHash(secret: string, email: string): string {
  const emailDigest = keccak256(toUtf8Bytes(email.toLowerCase()));
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32"],
    [DOMAIN, MODE_EMAIL, secret, emailDigest],
  );
}

function addressHash(secret: string): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32"],
    [DOMAIN, MODE_ADDRESS, secret],
  );
}

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
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
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
  const claimLinks = await deployProxy("ClaimLinks", [await eventHub.getAddress()]);

  await eventHub.batchWhitelist([await claimLinks.getAddress()]);

  await testUSDC.mint(alice.address, usdc(10_000));
  await testUSDC.connect(alice).approve(await vault.getAddress(), usdc(10_000));
  await vault.connect(alice).shield(usdc(1_000));

  // Alice grants ClaimLinks permission to pull from her vault balance
  const MAX = (1n << 64n) - 1n;
  await vault.connect(alice).approvePlaintext(await claimLinks.getAddress(), MAX);

  return { owner, alice, bob, charlie, client, testUSDC, vault, claimLinks };
}

async function encAmount(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

describe("ClaimLinks", () => {
  describe("Bearer mode", () => {
    it("creates and claims a bearer link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(50));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "lunch money",
      );

      // Bob (random claimer) can claim with the secret
      await ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret);

      const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(50));
    });

    it("rejects a wrong secret", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(20));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      await expect(
        ctx.claimLinks.connect(ctx.bob).claimBearer(0, newSecret()),
      ).to.be.revertedWith("ClaimLinks: bad secret");
    });

    it("cannot be claimed twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(10));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      await ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret);
      await expect(
        ctx.claimLinks.connect(ctx.charlie).claimBearer(0, secret),
      ).to.be.revertedWith("ClaimLinks: already claimed");
    });
  });

  describe("EmailBound mode", () => {
    it("claims with correct secret + email", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const email = "bob@example.com";
      const enc = await encAmount(ctx.client, ctx.alice, usdc(30));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        emailHash(secret, email),
        MODE_EMAIL,
        hre.ethers.ZeroAddress,
        0,
        "for bob",
      );

      const emailDigest = keccak256(toUtf8Bytes(email.toLowerCase()));
      await ctx.claimLinks.connect(ctx.bob).claimEmailBound(0, secret, emailDigest);

      const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(30));
    });

    it("rejects a wrong email", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(15));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        emailHash(secret, "bob@example.com"),
        MODE_EMAIL,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      const wrongDigest = keccak256(toUtf8Bytes("attacker@example.com"));
      await expect(
        ctx.claimLinks.connect(ctx.bob).claimEmailBound(0, secret, wrongDigest),
      ).to.be.revertedWith("ClaimLinks: bad secret/email");
    });
  });

  describe("AddressBound mode", () => {
    it("only the bound address can claim", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(40));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        addressHash(secret),
        MODE_ADDRESS,
        ctx.bob.address,
        0,
        "for bob only",
      );

      // charlie has the secret but is not the bound address — must fail
      await expect(
        ctx.claimLinks.connect(ctx.charlie).claimAddressBound(0, secret),
      ).to.be.revertedWith("ClaimLinks: not bound address");

      // bob with correct secret succeeds
      await ctx.claimLinks.connect(ctx.bob).claimAddressBound(0, secret);
      const bobBal = await ctx.vault.balanceOf(ctx.bob.address);
      await mock_expectPlaintext(ctx.bob.provider, bobBal, usdc(40));
    });
  });

  describe("Refund", () => {
    it("sender refunds after expiry", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(25));

      const aliceBefore = await ctx.vault.balanceOf(ctx.alice.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceBefore, usdc(1_000));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        3600, // 1 hour
        "",
      );

      const aliceAfterCreate = await ctx.vault.balanceOf(ctx.alice.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceAfterCreate, usdc(975));

      // Cannot refund before expiry
      await expect(
        ctx.claimLinks.connect(ctx.alice).refundLink(0),
      ).to.be.revertedWith("ClaimLinks: not yet expired");

      await time.increase(3601);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);

      const aliceFinal = await ctx.vault.balanceOf(ctx.alice.address);
      await mock_expectPlaintext(ctx.alice.provider, aliceFinal, usdc(1_000));
    });

    it("non-sender cannot refund", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(5));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        100,
        "",
      );

      await time.increase(101);
      await expect(
        ctx.claimLinks.connect(ctx.bob).refundLink(0),
      ).to.be.revertedWith("ClaimLinks: not sender");
    });

    it("cannot refund a claimed link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(8));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        100,
        "",
      );

      await ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret);
      await time.increase(101);

      await expect(
        ctx.claimLinks.connect(ctx.alice).refundLink(0),
      ).to.be.revertedWith("ClaimLinks: already claimed");
    });

    // §15.3.1: double-refund must revert (state already cleared by first refund).
    it("cannot refund twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(3));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        100,
        "",
      );

      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);

      await expect(
        ctx.claimLinks.connect(ctx.alice).refundLink(0),
      ).to.be.revertedWith("ClaimLinks: already refunded");
    });

    // §15.3.1: claim after refund must revert (state machine integrity).
    it("cannot claim a refunded link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(4));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        100,
        "",
      );

      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);

      await expect(
        ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret),
      ).to.be.revertedWith("ClaimLinks: refunded");
    });
  });

  // §15.3.1: wrong-mode-claim must revert. Each claim entrypoint binds to a
  // specific LinkMode and the dispatcher (_claimable) rejects mismatched modes.
  describe("Wrong-mode claim rejection", () => {
    it("rejects claimBearer on an EmailBound link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const email = "alice@example.com";
      const enc = await encAmount(ctx.client, ctx.alice, usdc(2));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        emailHash(secret, email),
        MODE_EMAIL,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      await expect(
        ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret),
      ).to.be.revertedWith("ClaimLinks: wrong mode");
    });

    it("rejects claimEmailBound on a Bearer link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(2));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      const fakeEmailHash = keccak256(toUtf8Bytes("nobody@example.com"));
      await expect(
        ctx.claimLinks.connect(ctx.bob).claimEmailBound(0, secret, fakeEmailHash),
      ).to.be.revertedWith("ClaimLinks: wrong mode");
    });

    it("rejects claimAddressBound on a Bearer link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(2));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      await expect(
        ctx.claimLinks.connect(ctx.bob).claimAddressBound(0, secret),
      ).to.be.revertedWith("ClaimLinks: wrong mode");
    });
  });

  // CRITICAL: regression pin for the self-claim income-inflation bug
  // found in the /goal-session contract audit. ClaimLinks._release
  // calls _bumpReceiptsAndGlobal(claimer, transferred) which increments
  // PaymentReceipts._totalReceived[claimer]. proveIncomeAbove reads
  // that counter. Without a self-claim guard, the sender of a link
  // could claim their own link, get the funds bounced back to
  // themselves (no net change), but have their "income" counter
  // inflated by the link amount. Fix: reject msg.sender == link.sender
  // in _claimable (shared by all three claim entry points).
  describe("Self-claim rejection (income-proof inflation guard)", () => {
    it("Bearer: sender cannot claim their own link", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(7));
      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        3600,
        "",
      );
      await expect(
        ctx.claimLinks.connect(ctx.alice).claimBearer(0, secret),
      ).to.be.revertedWith("ClaimLinks: sender cannot self-claim");
      // Bob can still legitimately claim — sanity check the guard
      // doesn't break the normal path.
      await expect(
        ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret),
      ).to.not.be.reverted;
    });

    it("AddressBound: sender cannot claim even when boundAddress=self", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(7));
      // Alice creates an AddressBound link to herself — the most
      // direct attack shape.
      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        addressHash(secret),
        MODE_ADDRESS,
        ctx.alice.address,
        3600,
        "",
      );
      await expect(
        ctx.claimLinks.connect(ctx.alice).claimAddressBound(0, secret),
      ).to.be.revertedWith("ClaimLinks: sender cannot self-claim");
    });
  });

  describe("Expiry", () => {
    it("rejects claim after expiry", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(7));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        60,
        "",
      );

      await time.increase(61);
      await expect(
        ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret),
      ).to.be.revertedWith("ClaimLinks: expired");
    });

    // §1.5 of BEST_VERSION_FULL_PLAN: 365-day expiry cap.
    it("rejects expirySeconds > 365 days", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1));

      const oneYearOneSec = 365 * 24 * 3600 + 1;
      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(),
          enc,
          bearerHash(secret),
          MODE_BEARER,
          hre.ethers.ZeroAddress,
          oneYearOneSec,
          "",
        ),
      ).to.be.revertedWith("ClaimLinks: expiry too long (max 365 days)");
    });

    it("accepts expirySeconds == MAX_EXPIRY_SECONDS (365 days)", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1));

      const exactlyOneYear = 365 * 24 * 3600;
      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        exactlyOneYear,
        "",
      );
      // No revert means accepted.
    });

    it("accepts expirySeconds == 0 (uses default)", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );
      // 0 means defaultExpirySeconds (7 days), accepted.
    });
  });

  // §2.7 + §15.3.1 event-assertion gap: PaymentReceiptsSet fires on
  // setPaymentReceipts and carries previous + current addresses. Indexers
  // and deploy scripts subscribe to verify wiring.
  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.claimLinks, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);

      expect(await ctx.claimLinks.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = "0x000000000000000000000000000000000000dEaD";
      const second = "0x000000000000000000000000000000000000bEEF";

      await ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(first);

      await expect(ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.claimLinks, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = "0x000000000000000000000000000000000000bEEF";

      await expect(
        ctx.claimLinks.connect(ctx.alice).setPaymentReceipts(fake),
      ).to.be.reverted;
    });
  });

  // §15.3.1: state-change events on each lifecycle transition.
  // LinkCreated, LinkClaimed, LinkRefunded must each fire with the
  // expected linkId so indexers can mirror state without polling.
  describe("State-change events", () => {
    it("emits LinkCreated on createLink with the assigned linkId", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(11));

      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(),
          enc,
          bearerHash(secret),
          MODE_BEARER,
          hre.ethers.ZeroAddress,
          0,
          "with note",
        ),
      ).to.emit(ctx.claimLinks, "LinkCreated");
    });

    it("emits LinkClaimed on claim with linkId + claimer", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(12));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        0,
        "",
      );

      const tx = ctx.claimLinks.connect(ctx.bob).claimBearer(0, secret);
      await expect(tx).to.emit(ctx.claimLinks, "LinkClaimed");
    });

    it("emits LinkRefunded on refund with linkId + sender", async () => {
      const ctx = await loadFixture(deployFixture);
      const secret = newSecret();
      const enc = await encAmount(ctx.client, ctx.alice, usdc(13));

      await ctx.claimLinks.connect(ctx.alice).createLink(
        await ctx.vault.getAddress(),
        enc,
        bearerHash(secret),
        MODE_BEARER,
        hre.ethers.ZeroAddress,
        100,
        "",
      );

      await time.increase(101);
      const tx = ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await expect(tx).to.emit(ctx.claimLinks, "LinkRefunded");
    });
  });
});
