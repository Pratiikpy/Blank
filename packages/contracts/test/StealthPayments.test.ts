import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  StealthPayments — encrypted-recipient escrow payments
//
//  Privacy model:
//   • Deposit amount is plaintext (like shielding) but recipient
//     identity is encrypted with FHE.eq().
//   • Wrong claimer gets ZERO tokens via FHE.select(eq, full, 0) —
//     NEVER reverts on identity mismatch, because a revert would
//     leak "you are not the recipient."
//   • claimCode is bound to recipient address (front-running guard):
//       hash = keccak256(abi.encodePacked(claimCode, recipient))
//     An attacker who sniffs the claimCode from the mempool cannot
//     reuse it from their own address because the hash binding fails.
//
//  Pre-existing coverage in Blank.test.ts: only the #199 refund
//  decrement. The core flow (sendStealth → claimStealth →
//  finalizeClaim), all guard rails, and the privacy invariants are
//  untested. This file fills that gap.
//
//  Covers:
//   • sendStealth: zero-amount reject, uint64 cap reject (#356),
//     empty claim-hash reject, zero-vault reject, claim-code reuse
//     reject, escrow custody check
//   • claimStealth: invalid id, already claimed, wrong code rejects,
//     correct code transitions state
//   • finalizeClaim: not-claimer rejects, double-finalize rejects,
//     wrong-claimer gets 0 (privacy invariant), correct-claimer
//     receives full amount
//   • Front-running protection: claim code from wrong address fails
//     the hash binding (cannot be used by an attacker who sniffed
//     the code from the mempool)
//   • refund: only-sender, only-after-30-days, claimed blocks refund
//   • View functions: getMyPendingClaims, getSenderTransfers,
//     totalTransfers, getClaimStatus
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
  const [owner, sender, alice, bob, eve] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(), "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const stealth = await deployProxy("StealthPayments", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await stealth.getAddress()]);
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await testUSDC.getAddress(), "USD Coin", "USDC", USDC_DECIMALS);
  await stealth.setTokenRegistry(await registry.getAddress());

  for (const s of [sender, alice, bob, eve]) {
    await testUSDC.mint(s.address, usdc(10_000));
    await testUSDC.connect(s).approve(await stealth.getAddress(), usdc(10_000));
  }

  return { owner, sender, alice, bob, eve, client, testUSDC, vault, stealth, registry, eventHub };
}

// Compute the claim-code hash the way the contract verifies it:
//   keccak256(abi.encodePacked(claimCode, recipientAddress))
function bindClaim(claimCode: string, recipient: string): string {
  return hre.ethers.solidityPackedKeccak256(["bytes32", "address"], [claimCode, recipient]);
}

async function encAddress(client: any, signer: any, addr: string, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.address(addr)]).setConsumingContract(consuming).execute();
}

async function taskManager() {
  const book = await hre.ethers.getContractAt(
    ["function getTm(uint256) view returns (address)"],
    "0xC0F4e00E531a2B086492Ae3DCC1515038307196b",
  );
  return hre.ethers.getContractAt(
    ["function publishDecryptResult(uint256,uint256,bytes)"],
    await book.getTm(1),
  );
}

async function decryptPendingAmount(stealth: any, client: any, signer: any, transferId: number) {
  const handle = await stealth.getPendingClaimHandle(transferId);
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const proof = await client.decryptForTx(handle, FheTypes.Uint64).withoutACP().execute();
  return { plaintext: proof.decryptedValue as bigint, signature: proof.signature as string };
}

describe("StealthPayments — sendStealth guards", () => {
  it("rejects zero amount", async () => {
    const ctx = await loadFixture(deployFixture);
    const encRecipient = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("secret-1");
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        0, ...encRecipient, bindClaim(claimCode, ctx.alice.address),
        await ctx.vault.getAddress(), "note",
      ),
    ).to.be.revertedWith("StealthPayments: zero amount");
  });

  it("rejects amount > uint64 max (#356 cap)", async () => {
    const ctx = await loadFixture(deployFixture);
    const encRecipient = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("secret-2");
    // 2^64 = 18446744073709551616 — one above the uint64 max.
    const TOO_BIG = (1n << 64n);
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        TOO_BIG, ...encRecipient, bindClaim(claimCode, ctx.alice.address),
        await ctx.vault.getAddress(), "note",
      ),
    ).to.be.revertedWith("StealthPayments: amount exceeds uint64");
  });

  it("rejects empty claim code hash (bytes32(0))", async () => {
    const ctx = await loadFixture(deployFixture);
    const encRecipient = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        usdc(10), ...encRecipient, hre.ethers.ZeroHash,
        await ctx.vault.getAddress(), "note",
      ),
    ).to.be.revertedWith("StealthPayments: empty claim code hash");
  });

  it("rejects zero vault address", async () => {
    const ctx = await loadFixture(deployFixture);
    const encRecipient = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("secret-3");
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        usdc(10), ...encRecipient, bindClaim(claimCode, ctx.alice.address),
        hre.ethers.ZeroAddress, "note",
      ),
    ).to.be.revertedWith("StealthPayments: invalid vault");
  });

  it("rejects reuse of an already-used claim code hash", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR1 = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("secret-reuse");
    const hash = bindClaim(claimCode, ctx.alice.address);
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR1, hash, await ctx.vault.getAddress(), "first",
    );
    const encR2 = await encAddress(ctx.client, ctx.sender, ctx.bob.address, await ctx.stealth.getAddress());
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        usdc(10), ...encR2, hash, await ctx.vault.getAddress(), "second",
      ),
    ).to.be.revertedWith("StealthPayments: claim code already used");
  });

  it("happy path: transfers tokens into escrow custody, emits StealthSent", async () => {
    const ctx = await loadFixture(deployFixture);
    const senderBefore = await ctx.testUSDC.balanceOf(ctx.sender.address);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("secret-happy");

    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        usdc(50), ...encR, bindClaim(claimCode, ctx.alice.address),
        await ctx.vault.getAddress(), "lunch",
      ),
    ).to.emit(ctx.stealth, "StealthSent");

    expect(await ctx.testUSDC.balanceOf(ctx.sender.address)).to.equal(senderBefore - usdc(50));
    expect(await ctx.testUSDC.balanceOf(await ctx.stealth.getAddress())).to.equal(usdc(50));
    expect(await ctx.stealth.totalTransfers()).to.equal(1);
  });
});

describe("StealthPayments — claimStealth + finalizeClaim (correct recipient)", () => {
  it("correct recipient receives full amount in underlying ERC20", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("alice-secret");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(100), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "gift",
    );
    const aliceBefore = await ctx.testUSDC.balanceOf(ctx.alice.address);

    // Phase 1: claim with code bound to alice's address.
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);

    // Phase 2: alice decrypts the pending conditional handle and finalizes.
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.alice, 0);
    await ctx.stealth.connect(ctx.alice).finalizeClaim(0, proof.plaintext, proof.signature);

    expect(await ctx.testUSDC.balanceOf(ctx.alice.address)).to.equal(aliceBefore + usdc(100));
    expect(await ctx.testUSDC.balanceOf(await ctx.stealth.getAddress())).to.equal(0);
    const info = await ctx.stealth.getTransferInfo(0);
    expect(info.claimed).to.equal(true);
    expect(info.finalized).to.equal(true);
  });

  it("rejects double-finalize (idempotency guard)", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("alice-double");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(50), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.alice, 0);
    await ctx.stealth.connect(ctx.alice).finalizeClaim(0, proof.plaintext, proof.signature);

    await expect(
      ctx.stealth.connect(ctx.alice).finalizeClaim(0, proof.plaintext, proof.signature),
    ).to.be.revertedWith("StealthPayments: already finalized");
  });
});

describe("StealthPayments — privacy invariant: wrong claimer gets 0 (NO revert)", () => {
  it("front-running attack: attacker who sniffs claimCode from mempool CANNOT claim from their own address", async () => {
    // The recipient address is baked into the hash. Even if eve sniffs
    // alice's claimCode pre-confirmation, hash(claimCode, eve) !=
    // hash(claimCode, alice), so eve's claimStealth call reverts at the
    // hash check — never reaching the FHE.eq step.
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("alice-only-code");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(100), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "private",
    );

    // Eve sniffs the claim code and tries to use it from her own address.
    await expect(
      ctx.stealth.connect(ctx.eve).claimStealth(0, claimCode),
    ).to.be.revertedWith("StealthPayments: invalid claim code");

    // Alice can still claim normally.
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
  });

  it("non-recipient with a SEPARATE claim-code hash bound to their address gets 0 (privacy preserved, no revert)", async () => {
    // Edge case: the sender accidentally publishes two stealth payments
    // with claim hashes bound to DIFFERENT addresses, and bob (not the
    // intended recipient) tries to claim with HIS bound hash. He passes
    // the hash check (because the hash is bound to HIM), reaches the
    // FHE.eq step, gets conditionalAmount=0, and finalizes to 0.
    // This pins the no-revert privacy guarantee.
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    // Sender creates the stealth payment WITH BOB'S hash (mistake or attack).
    // The encrypted recipient is alice, but the claim hash is bound to bob.
    const claimCode = hre.ethers.id("oops-bobs-hash");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(75), ...encR, bindClaim(claimCode, ctx.bob.address),
      await ctx.vault.getAddress(), "mismatched",
    );
    const bobBefore = await ctx.testUSDC.balanceOf(ctx.bob.address);

    // Bob's hash matches, so claimStealth doesn't revert.
    await ctx.stealth.connect(ctx.bob).claimStealth(0, claimCode);

    // But FHE.eq(encR, eaddress(bob)) returns false → conditionalAmount=0.
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.bob, 0);
    expect(proof.plaintext).to.equal(0n); // privacy: 0, not full amount
    await ctx.stealth.connect(ctx.bob).finalizeClaim(0, proof.plaintext, proof.signature);

    // Bob got 0 tokens and the call did not revert. The claim is voided.
    expect(await ctx.testUSDC.balanceOf(ctx.bob.address)).to.equal(bobBefore);
    expect(await ctx.testUSDC.balanceOf(await ctx.stealth.getAddress())).to.equal(usdc(75));
    expect(await ctx.stealth.claimVoided(0)).to.equal(true);
  });

  // L1 exploit: the old contract marked the transfer claimed + finalized on a
  // zero claim, so refund reverted forever and the 75 USDC was locked.
  it("sender refunds immediately after a mismatched claim finalizes to 0", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("mismatch-refund");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(75), ...encR, bindClaim(claimCode, ctx.bob.address), await ctx.vault.getAddress(), "m",
    );
    const senderBefore = await ctx.testUSDC.balanceOf(ctx.sender.address);
    await ctx.stealth.connect(ctx.bob).claimStealth(0, claimCode);
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.bob, 0);
    await expect(ctx.stealth.connect(ctx.bob).finalizeClaim(0, proof.plaintext, proof.signature))
      .to.emit(ctx.stealth, "StealthClaimVoided");

    await ctx.stealth.connect(ctx.sender).refund(0);
    expect(await ctx.testUSDC.balanceOf(ctx.sender.address)).to.equal(senderBefore + usdc(75));
    expect((await ctx.stealth.getTransferInfo(0)).finalized).to.equal(true);
    await expect(ctx.stealth.connect(ctx.sender).refund(0)).to.be.revertedWith("StealthPayments: already finalized");
    await expect(ctx.stealth.connect(ctx.bob).finalizeClaim(0, 0, "0x")).to.be.revertedWith("StealthPayments: already finalized");
  });

  it("sender can refund a stalled mismatched claim once its 0 result is published", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("mismatch-stalled");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(20), ...encR, bindClaim(claimCode, ctx.bob.address), await ctx.vault.getAddress(), "m",
    );
    await ctx.stealth.connect(ctx.bob).claimStealth(0, claimCode);
    // Claim started but unpublished: refund stays blocked.
    await expect(ctx.stealth.connect(ctx.sender).refund(0)).to.be.revertedWith("StealthPayments: already claimed");
    // Anyone may publish the public 0 result; then the sender is unblocked.
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.sender, 0);
    expect(proof.plaintext).to.equal(0n);
    const tm = await taskManager();
    await tm.connect(ctx.sender).publishDecryptResult(await ctx.stealth.getPendingClaimHandle(0), proof.plaintext, proof.signature);
    const before = await ctx.testUSDC.balanceOf(ctx.sender.address);
    await ctx.stealth.connect(ctx.sender).refund(0);
    expect(await ctx.testUSDC.balanceOf(ctx.sender.address)).to.equal(before + usdc(20));
  });

  it("a correct claim that is mid-flight still blocks the sender's refund", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("good-midflight");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(20), ...encR, bindClaim(claimCode, ctx.alice.address), await ctx.vault.getAddress(), "m",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    await time.increase(30 * 86400 + 1);
    await expect(ctx.stealth.connect(ctx.sender).refund(0)).to.be.revertedWith("StealthPayments: already claimed");
  });
});

describe("StealthPayments — finalizeClaim publish (L2)", () => {
  it("finalize succeeds when the decrypt result is already published, ignoring the passed signature", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("pre-published");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(40), ...encR, bindClaim(claimCode, ctx.alice.address), await ctx.vault.getAddress(), "p",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.alice, 0);
    // A third party publishes the result directly on the TaskManager first.
    const handle = await ctx.stealth.getPendingClaimHandle(0);
    const tm = await taskManager();
    await tm.connect(ctx.eve).publishDecryptResult(handle, proof.plaintext, proof.signature);
    const before = await ctx.testUSDC.balanceOf(ctx.alice.address);
    await ctx.stealth.connect(ctx.alice).finalizeClaim(0, 0, "0x");
    expect(await ctx.testUSDC.balanceOf(ctx.alice.address)).to.equal(before + usdc(40));
  });
});

describe("StealthPayments — vault allowlist (L3)", () => {
  it("rejects an unregistered vault", async () => {
    const ctx = await loadFixture(deployFixture);
    const rogue = await deployProxy("FHERC20Vault", [
      await ctx.testUSDC.getAddress(), "Rogue", "RGE", USDC_DECIMALS, await ctx.eventHub.getAddress(),
    ]);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await expect(
      ctx.stealth.connect(ctx.sender).sendStealth(
        usdc(1), ...encR, bindClaim(hre.ethers.id("rogue"), ctx.alice.address), await rogue.getAddress(), "x",
      ),
    ).to.be.revertedWith("StealthPayments: vault not allowed");
  });

  it("fails closed with no registry, and refunds still work after deactivation", async () => {
    const ctx = await loadFixture(deployFixture);
    const fresh = await deployProxy("StealthPayments", [await ctx.eventHub.getAddress()]);
    const encR0 = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await fresh.getAddress());
    await expect(
      fresh.connect(ctx.sender).sendStealth(
        usdc(1), ...encR0, bindClaim(hre.ethers.id("nr"), ctx.alice.address), await ctx.vault.getAddress(), "x",
      ),
    ).to.be.revertedWith("StealthPayments: vault not allowed");

    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(5), ...encR, bindClaim(hre.ethers.id("deact"), ctx.alice.address), await ctx.vault.getAddress(), "x",
    );
    await ctx.registry.deactivateToken(await ctx.vault.getAddress());
    await time.increase(30 * 86400 + 1);
    await ctx.stealth.connect(ctx.sender).refund(0);
  });
});

describe("StealthPayments — claimStealth guards", () => {
  it("rejects invalid transferId (out of range)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.stealth.connect(ctx.alice).claimStealth(999, hre.ethers.id("any")),
    ).to.be.revertedWith("StealthPayments: invalid transfer ID");
  });

  it("rejects re-claim of an already-claimed transfer", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("alice-recl");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    await expect(
      ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode),
    ).to.be.revertedWith("StealthPayments: already claimed");
  });
});

describe("StealthPayments — finalizeClaim guards", () => {
  it("rejects finalize from a different address than the claimer", async () => {
    const ctx = await loadFixture(deployFixture);
    // Send a stealth payment with the claim hash bound to ALICE so the
    // hash check passes. Then alice claims. Then bob tries to finalize
    // from his address — must reject.
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("alice-claimer");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    const proof = await decryptPendingAmount(ctx.stealth, ctx.client, ctx.alice, 0);
    await expect(
      ctx.stealth.connect(ctx.bob).finalizeClaim(0, proof.plaintext, proof.signature),
    ).to.be.revertedWith("StealthPayments: not the claimer");
  });

  it("rejects finalize on a transfer that was never claimed", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(hre.ethers.id("x"), ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await expect(
      ctx.stealth.connect(ctx.alice).finalizeClaim(0, 0, "0x"),
    ).to.be.revertedWith("StealthPayments: not yet claimed");
  });
});

describe("StealthPayments — refund", () => {
  it("rejects refund from non-sender", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(hre.ethers.id("r1"), ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await expect(
      ctx.stealth.connect(ctx.eve).refund(0),
    ).to.be.revertedWith("StealthPayments: not the sender");
  });

  it("rejects refund within 30 days", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(hre.ethers.id("r2"), ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await time.increase(30 * 86400 - 10); // just under 30 days
    await expect(
      ctx.stealth.connect(ctx.sender).refund(0),
    ).to.be.revertedWith("StealthPayments: too early to refund");
  });

  it("refund after 30 days returns tokens to sender", async () => {
    const ctx = await loadFixture(deployFixture);
    const senderBefore = await ctx.testUSDC.balanceOf(ctx.sender.address);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(50), ...encR, bindClaim(hre.ethers.id("r3"), ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await time.increase(30 * 86400 + 1);
    await ctx.stealth.connect(ctx.sender).refund(0);
    expect(await ctx.testUSDC.balanceOf(ctx.sender.address)).to.equal(senderBefore);
    // The transfer is marked finalized to prevent double-refund.
    const info = await ctx.stealth.getTransferInfo(0);
    expect(info.finalized).to.equal(true);
  });

  it("rejects refund of an already-claimed transfer (recipient is mid-claim)", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("r4");
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, bindClaim(claimCode, ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    await time.increase(30 * 86400 + 1);
    await expect(
      ctx.stealth.connect(ctx.sender).refund(0),
    ).to.be.revertedWith("StealthPayments: already claimed");
  });
});

describe("StealthPayments — views", () => {
  it("getSenderTransfers + totalTransfers reflect per-sender history", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR1 = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(5), ...encR1, bindClaim(hre.ethers.id("v1"), ctx.alice.address),
      await ctx.vault.getAddress(), "x",
    );
    const encR2 = await encAddress(ctx.client, ctx.sender, ctx.bob.address, await ctx.stealth.getAddress());
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(7), ...encR2, bindClaim(hre.ethers.id("v2"), ctx.bob.address),
      await ctx.vault.getAddress(), "x",
    );
    const ids = await ctx.stealth.getSenderTransfers(ctx.sender.address);
    expect(ids.length).to.equal(2);
    expect(await ctx.stealth.totalTransfers()).to.equal(2);
  });

  it("getMyPendingClaims returns matches for claim hashes the caller controls", async () => {
    const ctx = await loadFixture(deployFixture);
    const encR = await encAddress(ctx.client, ctx.sender, ctx.alice.address, await ctx.stealth.getAddress());
    const claimCode = hre.ethers.id("v3");
    const hash = bindClaim(claimCode, ctx.alice.address);
    await ctx.stealth.connect(ctx.sender).sendStealth(
      usdc(10), ...encR, hash, await ctx.vault.getAddress(), "x",
    );
    const [ids, found] = await ctx.stealth.getMyPendingClaims([hash]);
    expect(found[0]).to.equal(true);
    expect(ids[0]).to.equal(0);

    // After claim, getMyPendingClaims must NOT surface it anymore.
    await ctx.stealth.connect(ctx.alice).claimStealth(0, claimCode);
    const [, found2] = await ctx.stealth.getMyPendingClaims([hash]);
    expect(found2[0]).to.equal(false);
  });
});
