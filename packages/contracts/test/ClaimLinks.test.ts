import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import {
  AbiCoder, Wallet, getBytes, keccak256, parseUnits, solidityPackedKeccak256,
  randomBytes, hexlify, toUtf8Bytes, zeroPadValue, toBeHex,
} from "ethers";

// ══════════════════════════════════════════════════════════════════
//  ClaimLinks — magic claim links contract test suite
//
//  Claim key model (v2): the sender registers a one-time claim key
//  address derived from the link secret. The claimer signs
//  (linkId, claimer, chainId, contract) with that key, so the secret
//  never reaches calldata and a copied signature only works for the
//  claimer it names.
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const MODE_BEARER = 0;
const MODE_EMAIL = 1;
const MODE_ADDRESS = 2;

const DOMAIN = keccak256(toUtf8Bytes("BLANK_CLAIM_v1"));
const CLAIM_TYPEHASH = keccak256(toUtf8Bytes("BLANK_CLAIM_v2"));
const CLAIM_KEY_SLOT = 9; // claimKeyOf mapping slot (storage-layouts/ClaimLinks.json)

function newSecret(): string {
  return hexlify(randomBytes(32));
}

function emailDigestOf(email: string): string {
  return keccak256(toUtf8Bytes(email.toLowerCase()));
}

// Reference implementation of the documented client-side derivation.
function claimWallet(mode: number, secret: string, emailHash?: string): Wallet {
  const priv = mode === MODE_EMAIL
    ? solidityPackedKeccak256(["string", "uint8", "bytes32", "bytes32"], ["BLANK_CLAIM_KEY_v2", mode, secret, emailHash!])
    : solidityPackedKeccak256(["string", "uint8", "bytes32"], ["BLANK_CLAIM_KEY_v2", mode, secret]);
  return new Wallet(priv);
}

function localDigest(linkId: bigint | number, claimer: string, chainId: bigint, contract: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "uint256", "address"],
    [CLAIM_TYPEHASH, linkId, claimer, chainId, contract],
  ));
}

async function signClaim(ctx: any, key: Wallet, linkId: number, claimer: string): Promise<string> {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const digest = localDigest(linkId, claimer, chainId, await ctx.claimLinks.getAddress());
  return key.signMessage(getBytes(digest));
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

  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", USDC_DECIMALS);
  await claimLinks.setTokenRegistry(await registry.getAddress());

  await eventHub.batchWhitelist([await claimLinks.getAddress()]);

  await testUSDC.mint(alice.address, usdc(10_000));
  await testUSDC.connect(alice).approve(await vault.getAddress(), usdc(10_000));
  await vault.connect(alice).shield(usdc(1_000));

  const MAX = (1n << 64n) - 1n;
  await vault.connect(alice).approvePlaintext(await claimLinks.getAddress(), MAX);

  return { owner, alice, bob, charlie, client, testUSDC, vault, claimLinks, registry, eventHub };
}

async function encAmount(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

// Decrypts the public funded bit of a link and settles it on-chain, the way
// the app's automatic second step does. Anyone may submit it.
async function confirmLink(ctx: any, linkId: number | bigint, caller: any = ctx.owner) {
  const handle = await ctx.claimLinks.getFundingCheck(linkId);
  await hre.cofhe.connectWithHardhatSigner(ctx.client, caller);
  const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
  return ctx.claimLinks.connect(caller).confirmFunding(linkId, Boolean(proof.decryptedValue), proof.signature);
}

// Creates link 0 (or the next id) and returns the claim key. The link is
// confirmed funded unless `confirm: false`, so the claim-path tests below read
// as they did before the funding gate.
async function createLink(
  ctx: any,
  opts: {
    amount?: bigint; mode?: number; bound?: string; expiry?: number; note?: string; email?: string;
    sender?: any; confirm?: boolean;
  } = {},
) {
  const mode = opts.mode ?? MODE_BEARER;
  const sender = opts.sender ?? ctx.alice;
  const secret = newSecret();
  const key = claimWallet(mode, secret, opts.email ? emailDigestOf(opts.email) : undefined);
  const enc = await encAmount(ctx.client, sender, opts.amount ?? usdc(10), await ctx.claimLinks.getAddress());
  await ctx.claimLinks.connect(sender).createLink(
    await ctx.vault.getAddress(),
    ...enc,
    key.address,
    mode,
    opts.bound ?? hre.ethers.ZeroAddress,
    opts.expiry ?? 0,
    opts.note ?? "",
  );
  const linkId = (await ctx.claimLinks.nextLinkId()) - 1n;
  if (opts.confirm !== false) await confirmLink(ctx, linkId);
  return { secret, key, linkId };
}

// Simulates a link created before the claim-key upgrade (only a secret hash).
async function makeLegacy(ctx: any, linkId: number) {
  const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [linkId, CLAIM_KEY_SLOT]));
  await hre.network.provider.send("hardhat_setStorageAt", [
    await ctx.claimLinks.getAddress(), slot, zeroPadValue(toBeHex(0), 32),
  ]);
  expect(await ctx.claimLinks.claimKeyOf(linkId)).to.equal(hre.ethers.ZeroAddress);
}

describe("ClaimLinks", () => {
  describe("Claim key + signature", () => {
    it("claimDigest matches the documented encoding", async () => {
      const ctx = await loadFixture(deployFixture);
      const chainId = (await hre.ethers.provider.getNetwork()).chainId;
      expect(await ctx.claimLinks.claimDigest(7, ctx.bob.address)).to.equal(
        localDigest(7, ctx.bob.address, chainId, await ctx.claimLinks.getAddress()),
      );
      expect(await ctx.claimLinks.CLAIM_TYPEHASH()).to.equal(CLAIM_TYPEHASH);
    });

    it("stores the claim key and no secret hash", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx);
      expect(await ctx.claimLinks.claimKeyOf(0)).to.equal(key.address);
    });

    it("rejects a zero claim key", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1), await ctx.claimLinks.getAddress());
      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(), ...enc, hre.ethers.ZeroAddress, MODE_BEARER, hre.ethers.ZeroAddress, 0, "",
        ),
      ).to.be.revertedWith("ClaimLinks: empty claim key");
    });
  });

  describe("Bearer mode", () => {
    it("creates and claims a bearer link", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(50), note: "lunch money" });
      await ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address));
      await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(50));
    });

    it("rejects a signature from the wrong key", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(20) });
      const wrong = claimWallet(MODE_BEARER, newSecret());
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, wrong, 0, ctx.bob.address)),
      ).to.be.revertedWith("ClaimLinks: bad claim signature");
    });

    it("cannot be claimed twice", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx);
      await ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address));
      await expect(
        ctx.claimLinks.connect(ctx.charlie).claim(0, await signClaim(ctx, key, 0, ctx.charlie.address)),
      ).to.be.revertedWith("ClaimLinks: already claimed");
    });

    // H5 exploit: before v2 the secret sat in claimBearer calldata and any
    // mempool observer could resubmit it from their own address first.
    it("front-runner replaying the claimer's signature is rejected", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(30) });
      const bobSig = await signClaim(ctx, key, 0, ctx.bob.address);
      await expect(
        ctx.claimLinks.connect(ctx.charlie).claim(0, bobSig),
      ).to.be.revertedWith("ClaimLinks: bad claim signature");
      await ctx.claimLinks.connect(ctx.bob).claim(0, bobSig);
      await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(30));
    });

    it("signature for another link id or contract does not verify", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx);
      await createLink(ctx);
      // Signed for link 0, submitted against link 1 (different key anyway) and
      // a digest for a different contract address.
      const chainId = (await hre.ethers.provider.getNetwork()).chainId;
      const otherContract = await key.signMessage(getBytes(localDigest(0, ctx.bob.address, chainId, ctx.owner.address)));
      await expect(ctx.claimLinks.connect(ctx.bob).claim(0, otherContract)).to.be.revertedWith("ClaimLinks: bad claim signature");
      const otherChain = await key.signMessage(getBytes(localDigest(0, ctx.bob.address, chainId + 1n, await ctx.claimLinks.getAddress())));
      await expect(ctx.claimLinks.connect(ctx.bob).claim(0, otherChain)).to.be.revertedWith("ClaimLinks: bad claim signature");
    });

    it("rejects a high-s (malleable) signature", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx);
      const sig = hre.ethers.Signature.from(await signClaim(ctx, key, 0, ctx.bob.address));
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = toBeHex(N - BigInt(sig.s), 32);
      const v = sig.v === 27 ? 28 : 27;
      const malleable = hre.ethers.concat([sig.r, highS, toBeHex(v, 1)]);
      await expect(ctx.claimLinks.connect(ctx.bob).claim(0, malleable)).to.be.reverted;
    });
  });

  describe("EmailBound mode", () => {
    it("claims with the key derived from secret + email", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(30), mode: MODE_EMAIL, email: "Bob@Example.com" });
      await ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address));
      await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(30));
    });

    it("the key derived with a wrong email does not verify", async () => {
      const ctx = await loadFixture(deployFixture);
      const { secret } = await createLink(ctx, { amount: usdc(15), mode: MODE_EMAIL, email: "bob@example.com" });
      const wrong = claimWallet(MODE_EMAIL, secret, emailDigestOf("attacker@example.com"));
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, wrong, 0, ctx.bob.address)),
      ).to.be.revertedWith("ClaimLinks: bad claim signature");
    });
  });

  describe("AddressBound mode", () => {
    it("only the bound address can claim", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(40), mode: MODE_ADDRESS, bound: ctx.bob.address });
      await expect(
        ctx.claimLinks.connect(ctx.charlie).claim(0, await signClaim(ctx, key, 0, ctx.charlie.address)),
      ).to.be.revertedWith("ClaimLinks: not bound address");
      await ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address));
      await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(40));
    });

    it("claimAddressBound is closed for v2 links", async () => {
      const ctx = await loadFixture(deployFixture);
      const { secret } = await createLink(ctx, { mode: MODE_ADDRESS, bound: ctx.bob.address });
      await expect(
        ctx.claimLinks.connect(ctx.bob).claimAddressBound(0, secret),
      ).to.be.revertedWith("ClaimLinks: use claim");
    });
  });

  describe("Legacy links (created before claim keys)", () => {
    it("legacy Bearer link cannot be claimed, only refunded after expiry", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(9), expiry: 100 });
      await makeLegacy(ctx, 0);
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address)),
      ).to.be.revertedWith("ClaimLinks: legacy link, refund only");
      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    });

    it("legacy AddressBound link stays claimable by the bound address with the secret", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(6), mode: MODE_ADDRESS, bound: ctx.bob.address });
      await makeLegacy(ctx, 0);
      // Legacy links stored keccak256(DOMAIN, 2, secret) in the struct.
      // Write it into the struct's secretHash slot to mirror pre-upgrade state.
      const secret = newSecret();
      const legacyHash = solidityPackedKeccak256(["bytes32", "uint8", "bytes32"], [DOMAIN, MODE_ADDRESS, secret]);
      const LINKS_SLOT = 4; // _links mapping slot
      const base = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, LINKS_SLOT])));
      await hre.network.provider.send("hardhat_setStorageAt", [
        await ctx.claimLinks.getAddress(), toBeHex(base + 3n, 32), legacyHash,
      ]);
      await expect(ctx.claimLinks.connect(ctx.charlie).claimAddressBound(0, secret)).to.be.revertedWith("ClaimLinks: not bound address");
      await ctx.claimLinks.connect(ctx.bob).claimAddressBound(0, secret);
      await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(6));
    });
  });

  describe("Vault allowlist (H1)", () => {
    it("rejects an unregistered vault at creation", async () => {
      const ctx = await loadFixture(deployFixture);
      const rogue = await deployProxy("FHERC20Vault", [
        await ctx.testUSDC.getAddress(), "Rogue", "RGE", USDC_DECIMALS, await ctx.eventHub.getAddress(),
      ]);
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1), await ctx.claimLinks.getAddress());
      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await rogue.getAddress(), ...enc, Wallet.createRandom().address, MODE_BEARER, hre.ethers.ZeroAddress, 0, "",
        ),
      ).to.be.revertedWith("ClaimLinks: vault not allowed");
    });

    it("fails closed when no registry is set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fresh = await deployProxy("ClaimLinks", [await ctx.eventHub.getAddress()]);
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1), await fresh.getAddress());
      await expect(
        fresh.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(), ...enc, Wallet.createRandom().address, MODE_BEARER, hre.ethers.ZeroAddress, 0, "",
        ),
      ).to.be.revertedWith("ClaimLinks: vault not allowed");
    });

    it("refund still works after the vault is deactivated", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(5), expiry: 100 });
      await ctx.registry.deactivateToken(await ctx.vault.getAddress());
      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    });

    it("setTokenRegistry is owner-only and rejects an EOA", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.claimLinks.connect(ctx.alice).setTokenRegistry(await ctx.registry.getAddress()))
        .to.be.revertedWithCustomError(ctx.claimLinks, "OwnableUnauthorizedAccount");
      await expect(ctx.claimLinks.setTokenRegistry(ctx.bob.address)).to.be.revertedWith("ClaimLinks: bad registry");
      await expect(ctx.claimLinks.setTokenRegistry(await ctx.registry.getAddress()))
        .to.emit(ctx.claimLinks, "TokenRegistrySet");
    });
  });

  describe("Refund", () => {
    it("sender refunds after expiry", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(25), expiry: 3600 });
      await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(975));

      await expect(ctx.claimLinks.connect(ctx.alice).refundLink(0)).to.be.revertedWith("ClaimLinks: not yet expired");

      await time.increase(3601);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    });

    it("non-sender cannot refund", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(5), expiry: 100 });
      await time.increase(101);
      await expect(ctx.claimLinks.connect(ctx.bob).refundLink(0)).to.be.revertedWith("ClaimLinks: not sender");
    });

    it("cannot refund a claimed link", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(8), expiry: 100 });
      await ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address));
      await time.increase(101);
      await expect(ctx.claimLinks.connect(ctx.alice).refundLink(0)).to.be.revertedWith("ClaimLinks: already claimed");
    });

    it("cannot refund twice", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(3), expiry: 100 });
      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await expect(ctx.claimLinks.connect(ctx.alice).refundLink(0)).to.be.revertedWith("ClaimLinks: already refunded");
    });

    it("cannot claim a refunded link", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(4), expiry: 100 });
      await time.increase(101);
      await ctx.claimLinks.connect(ctx.alice).refundLink(0);
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address)),
      ).to.be.revertedWith("ClaimLinks: refunded");
    });
  });

  // Regression pin: a sender claiming their own link would inflate their
  // PaymentReceipts "received" counter, which proveIncomeAbove reads.
  describe("Self-claim rejection (income-proof inflation guard)", () => {
    it("Bearer: sender cannot claim their own link", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(7), expiry: 3600 });
      await expect(
        ctx.claimLinks.connect(ctx.alice).claim(0, await signClaim(ctx, key, 0, ctx.alice.address)),
      ).to.be.revertedWith("ClaimLinks: sender cannot self-claim");
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address)),
      ).to.not.be.reverted;
    });

    it("AddressBound: sender cannot claim even when boundAddress=self", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(7), mode: MODE_ADDRESS, bound: ctx.alice.address, expiry: 3600 });
      await expect(
        ctx.claimLinks.connect(ctx.alice).claim(0, await signClaim(ctx, key, 0, ctx.alice.address)),
      ).to.be.revertedWith("ClaimLinks: sender cannot self-claim");
    });
  });

  describe("Expiry", () => {
    it("rejects claim after expiry", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(7), expiry: 60 });
      await time.increase(61);
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address)),
      ).to.be.revertedWith("ClaimLinks: expired");
    });

    it("rejects expirySeconds > 365 days", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encAmount(ctx.client, ctx.alice, usdc(1), await ctx.claimLinks.getAddress());
      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(), ...enc, Wallet.createRandom().address, MODE_BEARER,
          hre.ethers.ZeroAddress, 365 * 24 * 3600 + 1, "",
        ),
      ).to.be.revertedWith("ClaimLinks: expiry too long (max 365 days)");
    });

    it("accepts expirySeconds == MAX_EXPIRY_SECONDS (365 days)", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(1), expiry: 365 * 24 * 3600 });
    });

    it("accepts expirySeconds == 0 (uses default)", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(1), expiry: 0 });
    });
  });

  describe("PaymentReceiptsSet event", () => {
    it("emits PaymentReceiptsSet with previous=zero, current=newAddr on first set", async () => {
      const ctx = await loadFixture(deployFixture);
      const fake = await ctx.registry.getAddress();
      await expect(ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(fake))
        .to.emit(ctx.claimLinks, "PaymentReceiptsSet")
        .withArgs(hre.ethers.ZeroAddress, fake);
      expect(await ctx.claimLinks.paymentReceipts()).to.equal(fake);
    });

    it("emits PaymentReceiptsSet with the prior address on subsequent set", async () => {
      const ctx = await loadFixture(deployFixture);
      const first = await ctx.registry.getAddress();
      const second = await ctx.vault.getAddress();
      await ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(first);
      await expect(ctx.claimLinks.connect(ctx.owner).setPaymentReceipts(second))
        .to.emit(ctx.claimLinks, "PaymentReceiptsSet")
        .withArgs(first, second);
    });

    it("only owner can call setPaymentReceipts", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.claimLinks.connect(ctx.alice).setPaymentReceipts(await ctx.registry.getAddress()),
      ).to.be.reverted;
    });

    it("E5: setters reject a codeless address; zero still switches receipts off", async () => {
      const ctx = await loadFixture(deployFixture);
      const eoa = "0x000000000000000000000000000000000000bEEF";
      await expect(ctx.claimLinks.setEventHub(eoa)).to.be.revertedWith("ClaimLinks: bad event hub");
      await expect(ctx.claimLinks.setPaymentReceipts(eoa)).to.be.revertedWith("ClaimLinks: bad receipts");
      await expect(ctx.claimLinks.setEventHub(await ctx.eventHub.getAddress())).to.not.be.reverted;
      await expect(ctx.claimLinks.setPaymentReceipts(hre.ethers.ZeroAddress)).to.not.be.reverted;
      await expect(ctx.claimLinks.connect(ctx.alice).setEventHub(await ctx.eventHub.getAddress())).to.be.reverted;
    });
  });

  describe("State-change events", () => {
    it("emits LinkCreated on createLink", async () => {
      const ctx = await loadFixture(deployFixture);
      const enc = await encAmount(ctx.client, ctx.alice, usdc(11), await ctx.claimLinks.getAddress());
      await expect(
        ctx.claimLinks.connect(ctx.alice).createLink(
          await ctx.vault.getAddress(), ...enc, Wallet.createRandom().address, MODE_BEARER, hre.ethers.ZeroAddress, 0, "with note",
        ),
      ).to.emit(ctx.claimLinks, "LinkCreated");
    });

    it("emits LinkClaimed on claim", async () => {
      const ctx = await loadFixture(deployFixture);
      const { key } = await createLink(ctx, { amount: usdc(12) });
      await expect(
        ctx.claimLinks.connect(ctx.bob).claim(0, await signClaim(ctx, key, 0, ctx.bob.address)),
      ).to.emit(ctx.claimLinks, "LinkClaimed").withArgs(0, ctx.bob.address, (v: bigint) => v > 0n);
    });

    it("emits LinkRefunded on refund", async () => {
      const ctx = await loadFixture(deployFixture);
      await createLink(ctx, { amount: usdc(13), expiry: 100 });
      await time.increase(101);
      await expect(ctx.claimLinks.connect(ctx.alice).refundLink(0)).to.emit(ctx.claimLinks, "LinkRefunded");
    });
  });
});

// The vault moves zero instead of reverting when the sender is short, so a
// link is only claimable once the single "locked the requested amount" bit
// has been decrypted and published.
describe("ClaimLinks, funding gate", () => {
  const MAX = (1n << 64n) - 1n;
  const FUNDING_STATUS_SLOT = 10; // fundingStatus mapping (storage-layouts/ClaimLinks.json)
  const ACTIVE = 0;
  const PENDING = 1;
  const VOID = 2;

  // Eve holds nothing in the vault but has approved ClaimLinks, so the only
  // reason her links can fail is a short balance.
  async function gateFixture() {
    const ctx = await deployFixture();
    const eve = (await hre.ethers.getSigners())[4];
    await ctx.vault.connect(eve).approvePlaintext(await ctx.claimLinks.getAddress(), MAX);
    const receipts = await deployProxy("PaymentReceipts", []);
    await receipts.setAuthorizedCaller(await ctx.claimLinks.getAddress(), true);
    await ctx.claimLinks.setPaymentReceipts(await receipts.getAddress());
    return { ...ctx, eve, receipts };
  }

  async function fundedBit(ctx: any, linkId: bigint | number, reader: any = ctx.owner) {
    await hre.cofhe.connectWithHardhatSigner(ctx.client, reader);
    const handle = await ctx.claimLinks.getFundingCheck(linkId);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutACP().execute();
    return { value: Boolean(proof.decryptedValue), signature: proof.signature };
  }

  const received = (ctx: any, who: any) => ctx.receipts.connect(who).getMyTotalReceived();

  it("a funded link starts PendingFunding and can neither be claimed nor refunded", async () => {
    const ctx = await loadFixture(gateFixture);
    const { key, linkId } = await createLink(ctx, { amount: usdc(50), expiry: 100, confirm: false });
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(PENDING);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.claimLinks.getAddress()), usdc(50));

    await expect(ctx.claimLinks.connect(ctx.bob).claim(linkId, await signClaim(ctx, key, 0, ctx.bob.address)))
      .to.be.revertedWith("ClaimLinks: funding pending");
    await time.increase(101);
    await expect(ctx.claimLinks.connect(ctx.alice).refundLink(linkId)).to.be.revertedWith("ClaimLinks: funding pending");
    const l = await ctx.claimLinks.getLink(linkId);
    expect(l.claimed).to.equal(false);
    expect(l.refunded).to.equal(false);
  });

  it("funded path end to end: a stranger confirms, the recipient claims, receipts bump once", async () => {
    const ctx = await loadFixture(gateFixture);
    const { key, linkId } = await createLink(ctx, { amount: usdc(50), confirm: false });
    const bit = await fundedBit(ctx, linkId, ctx.eve);
    expect(bit.value).to.equal(true);

    await expect(ctx.claimLinks.connect(ctx.eve).confirmFunding(linkId, bit.value, bit.signature))
      .to.emit(ctx.claimLinks, "LinkFunded").withArgs(linkId, ctx.alice.address)
      .and.not.to.emit(ctx.claimLinks, "LinkVoided");
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(ACTIVE);

    expect(await received(ctx, ctx.bob)).to.equal(0n);
    await ctx.claimLinks.connect(ctx.bob).claim(linkId, await signClaim(ctx, key, Number(linkId), ctx.bob.address));
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(50));
    await mock_expectPlaintext(ctx.bob.provider, await received(ctx, ctx.bob), usdc(50));
  });

  it("zero-balance sender: the link ends Void, is never claimable and pays nothing", async () => {
    const ctx = await loadFixture(gateFixture);
    const { key, linkId } = await createLink(ctx, { sender: ctx.eve, amount: usdc(50), expiry: 100, confirm: false });
    await mock_expectPlaintext(ctx.bob.provider, await ctx.claimLinks.getEncryptedAmount(linkId), 0n);
    const bit = await fundedBit(ctx, linkId);
    expect(bit.value).to.equal(false);

    await expect(ctx.claimLinks.connect(ctx.bob).confirmFunding(linkId, bit.value, bit.signature))
      .to.emit(ctx.claimLinks, "LinkVoided").withArgs(linkId, ctx.eve.address)
      .and.not.to.emit(ctx.claimLinks, "LinkFunded");
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(VOID);

    await expect(ctx.claimLinks.connect(ctx.bob).claim(linkId, await signClaim(ctx, key, Number(linkId), ctx.bob.address)))
      .to.be.revertedWith("ClaimLinks: link unfunded");
    await expect(ctx.claimLinks.connect(ctx.bob).claimAddressBound(linkId, newSecret()))
      .to.be.revertedWith("ClaimLinks: link unfunded");
    await time.increase(101);
    await expect(ctx.claimLinks.connect(ctx.eve).refundLink(linkId)).to.be.revertedWith("ClaimLinks: link unfunded");

    const l = await ctx.claimLinks.getLink(linkId);
    expect(l.claimed).to.equal(false);
    expect(l.refunded).to.equal(false);
    expect(l.claimer).to.equal(hre.ethers.ZeroAddress);
    expect(await ctx.claimLinks.getReceivedLinks(ctx.bob.address)).to.deep.equal([]);
    // Bob never held vault tokens, so his balance handle was never created.
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.equal(0n);
    expect(await received(ctx, ctx.bob)).to.equal(0n);
  });

  it("a zero-amount link and an over-balance link both end Void and take nothing", async () => {
    const ctx = await loadFixture(gateFixture);
    const zero = await createLink(ctx, { amount: 0n, confirm: false });
    const over = await createLink(ctx, { amount: usdc(5_000), confirm: false });
    await confirmLink(ctx, zero.linkId);
    await confirmLink(ctx, over.linkId);
    expect(await ctx.claimLinks.fundingStatus(zero.linkId)).to.equal(VOID);
    expect(await ctx.claimLinks.fundingStatus(over.linkId)).to.equal(VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.claimLinks.getAddress()), 0n);
  });

  it("the published value decides, not the caller's argument", async () => {
    const ctx = await loadFixture(gateFixture);
    const { linkId } = await createLink(ctx, { sender: ctx.eve, amount: usdc(50), confirm: false });
    const bit = await fundedBit(ctx, linkId);
    expect(bit.value).to.equal(false);
    await expect(ctx.claimLinks.confirmFunding(linkId, true, bit.signature)).to.be.reverted;
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(PENDING);

    const tm = await hre.cofhe.mocks.getMockTaskManager();
    await tm.publishDecryptResult(await ctx.claimLinks.getFundingCheck(linkId), 0, bit.signature);
    await ctx.claimLinks.confirmFunding(linkId, true, "0x");
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(VOID);
  });

  it("confirmFunding cannot run twice or on a link that is not pending", async () => {
    const ctx = await loadFixture(gateFixture);
    const { linkId } = await createLink(ctx, { amount: usdc(5) });
    await expect(ctx.claimLinks.confirmFunding(linkId, true, "0x")).to.be.revertedWith("ClaimLinks: not pending funding");
    await expect(ctx.claimLinks.confirmFunding(99, true, "0x")).to.be.revertedWith("ClaimLinks: not pending funding");
  });

  it("cancelPendingLink: only the sender, returns the locked funds, then nothing can settle it", async () => {
    const ctx = await loadFixture(gateFixture);
    const { key, linkId } = await createLink(ctx, { amount: usdc(50), confirm: false });
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(950));

    await expect(ctx.claimLinks.connect(ctx.bob).cancelPendingLink(linkId)).to.be.revertedWith("ClaimLinks: not sender");
    await expect(ctx.claimLinks.connect(ctx.alice).cancelPendingLink(linkId))
      .to.emit(ctx.claimLinks, "LinkVoided").withArgs(linkId, ctx.alice.address);
    expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(VOID);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(1_000));
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(await ctx.claimLinks.getAddress()), 0n);

    const bit = await fundedBit(ctx, linkId);
    await expect(ctx.claimLinks.confirmFunding(linkId, bit.value, bit.signature))
      .to.be.revertedWith("ClaimLinks: not pending funding");
    await expect(ctx.claimLinks.connect(ctx.bob).claim(linkId, await signClaim(ctx, key, Number(linkId), ctx.bob.address)))
      .to.be.revertedWith("ClaimLinks: link unfunded");
    await expect(ctx.claimLinks.connect(ctx.alice).cancelPendingLink(linkId))
      .to.be.revertedWith("ClaimLinks: not pending funding");
  });

  it("cancelPendingLink is closed once the link is Active", async () => {
    const ctx = await loadFixture(gateFixture);
    const { linkId } = await createLink(ctx, { amount: usdc(5) });
    await expect(ctx.claimLinks.connect(ctx.alice).cancelPendingLink(linkId))
      .to.be.revertedWith("ClaimLinks: not pending funding");
  });

  // A link written before this upgrade has fundingStatus 0 (Active) and no
  // funding bit. Zeroing the status slot of a pending link models that record.
  it("legacy record: a link with no funding state claims and refunds exactly as before", async () => {
    const ctx = await loadFixture(gateFixture);
    const claimable = await createLink(ctx, { amount: usdc(20), confirm: false });
    const refundable = await createLink(ctx, { amount: usdc(10), expiry: 100, confirm: false });
    for (const linkId of [claimable.linkId, refundable.linkId]) {
      const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [linkId, FUNDING_STATUS_SLOT]));
      await hre.network.provider.send("hardhat_setStorageAt", [
        await ctx.claimLinks.getAddress(), slot, zeroPadValue(toBeHex(0), 32),
      ]);
      expect(await ctx.claimLinks.fundingStatus(linkId)).to.equal(ACTIVE);
    }
    await ctx.claimLinks.connect(ctx.bob).claim(
      claimable.linkId, await signClaim(ctx, claimable.key, Number(claimable.linkId), ctx.bob.address),
    );
    await mock_expectPlaintext(ctx.bob.provider, await ctx.vault.balanceOf(ctx.bob.address), usdc(20));

    await time.increase(101);
    await ctx.claimLinks.connect(ctx.alice).refundLink(refundable.linkId);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.vault.balanceOf(ctx.alice.address), usdc(980));
  });
});
