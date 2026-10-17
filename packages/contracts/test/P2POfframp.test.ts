import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable } from "@cofhe/sdk";
import { parseUnits, AbiCoder, keccak256, getBytes } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  P2POfframp — Wave 5 headline build
//
//  Covers:
//    1. Lifecycle happy path: createOffer → takeOffer → submitProof
//       → time-skip past challenge window → releaseFill. Bob's
//       encrypted USDC balance goes up.
//    2. Dispute path: maker disputes within window → arbiter
//       resolves to maker → escrow refunded.
//    3. Anti-replay: submitting the same Reclaim proof twice
//       reverts via the adapter's usedProofs map.
//    4. Expire path: taker never submits proof → after 24h maker
//       reclaims via expireFill.
//    5. Guard: maker cannot self-take.
//    6. Guard: cancelOffer flips state; subsequent take reverts.
//    7. Guard: window-open release reverts; window-closed dispute
//       reverts.
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const RAIL_UPI_PHONEPE = 1;
const CHALLENGE_WINDOW = 300; // 5 minutes (testnet shape)

async function deployProxy(name: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData =
    initArgs.length > 0
      ? Factory.interface.encodeFunctionData("initialize", initArgs)
      : Factory.interface.encodeFunctionData("initialize");
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

/// Matches MockReclaimVerifier.attestationDigest: keccak256(abi.encode(
/// chainId, verifier, offramp, fillId, taker, providerId, receiver, amount)),
/// signed as an EIP-191 personal message.
async function signReclaimMessage(
  operator: any,
  ctx: { verifier: any; offramp: any },
  fillId: number | bigint,
  taker: string,
  providerId: number,
  receiverHandle: string,
  amountMicroUSD: bigint,
  chainIdOverride?: bigint,
): Promise<string> {
  const chainId = chainIdOverride ?? (await hre.ethers.provider.getNetwork()).chainId;
  const digest = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint64", "address", "uint32", "bytes32", "uint64"],
      [
        chainId,
        await ctx.verifier.getAddress(),
        await ctx.offramp.getAddress(),
        fillId,
        taker,
        providerId,
        receiverHandle,
        amountMicroUSD,
      ],
    ),
  );
  return operator.signMessage(getBytes(digest));
}

async function encUint64(ctx: any, signer: any, value: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return await ctx.client.encryptInputs([Encryptable.uint64(value)]).setConsumingContract(consuming).execute();
}

/// createOffer verifies encAmount and encMinFill under one batch signature, so
/// they have to be encrypted together and passed in that order.
async function encPair(ctx: any, signer: any, a: bigint, b: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  return await ctx.client
    .encryptInputs([Encryptable.uint64(a), Encryptable.uint64(b)])
    .setConsumingContract(consuming)
    .execute();
}

async function deployFixture() {
  const [owner, alice, bob, carol, operator, arbiter, dave] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  // Underlying USDC + FHERC20Vault.
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const usdcToken = await TestUSDC.deploy();
  await usdcToken.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await usdcToken.getAddress(),
    "Blank USDC Vault",
    "bvUSDC",
    USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);

  // Reclaim adapter + verifier (mock mode).
  const verifier = await deployProxy("MockReclaimVerifier", [operator.address]);
  const adapter = await deployProxy("ReclaimAdapter", [await verifier.getAddress()]);

  // Offramp contract.
  const offramp = await deployProxy("P2POfframp", [
    arbiter.address,
    await adapter.getAddress(),
    await eventHub.getAddress(),
    CHALLENGE_WINDOW,
  ]);

  // Vault allowlist.
  const registry = await deployProxy("TokenRegistry");
  await registry.registerToken(await vault.getAddress(), await usdcToken.getAddress(), "Test USDC", "USDC", USDC_DECIMALS);
  await offramp.setTokenRegistry(await registry.getAddress());

  await adapter.setCaller(await offramp.getAddress(), true);
  await eventHub.batchWhitelist([
    await offramp.getAddress(),
    await vault.getAddress(),
  ]);

  // Alice (maker) shields 100 USDC and approves the offramp.
  await usdcToken.mint(alice.address, usdc(1_000));
  await usdcToken.connect(alice).approve(await vault.getAddress(), usdc(1_000));
  await vault.connect(alice).shield(usdc(100));
  await vault
    .connect(alice)
    .approvePlaintext(await offramp.getAddress(), (1n << 64n) - 1n);

  return {
    owner, alice, bob, carol, operator, arbiter, dave,
    client,
    usdcToken, eventHub, vault, verifier, adapter, offramp, registry,
  };
}

const HANDLE = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
const FIAT = 50_000_000n;

async function plain(handle: any): Promise<bigint> {
  return hre.cofhe.mocks.getPlaintext(handle);
}

async function makeOffer(ctx: any, maker: any, amount: bigint, expiry = 3600, rail = RAIL_UPI_PHONEPE) {
  const enc = await encPair(ctx, maker, amount, amount, await ctx.offramp.getAddress());
  await ctx.offramp.connect(maker).createOffer(
    await ctx.vault.getAddress(), ...enc, rail, HANDLE, FIAT, 83_000_000n, expiry,
  );
}

async function proofFor(ctx: any, fillId: number, taker: any) {
  return signReclaimMessage(ctx.operator, ctx, fillId, taker.address, RAIL_UPI_PHONEPE, HANDLE, FIAT);
}

describe("P2POfframp", () => {
  it("happy path: createOffer → takeOffer → submitProof → release after window", async () => {
    const ctx = await loadFixture(deployFixture);

    await expect(
      ctx.offramp.connect(ctx.alice).createOffer(
        await ctx.vault.getAddress(),
        ...(await encPair(ctx, ctx.alice, usdc(50), usdc(50), await ctx.offramp.getAddress())),
        RAIL_UPI_PHONEPE, HANDLE, FIAT, 83_000_000n, 3600,
      ),
    ).to.emit(ctx.offramp, "OfferCreated");

    await expect(ctx.offramp.connect(ctx.bob).takeOffer(0))
      .to.emit(ctx.offramp, "FillLocked")
      .and.to.emit(ctx.offramp, "FillEscrowed");

    // Taker can read what was really escrowed before paying fiat.
    expect(await plain(await ctx.offramp.getEscrowedAmount(0))).to.equal(usdc(50));

    const proof = await proofFor(ctx, 0, ctx.bob);
    await expect(ctx.offramp.connect(ctx.bob).submitProof(0, proof, RAIL_UPI_PHONEPE))
      .to.emit(ctx.offramp, "ProofSubmitted");

    await expect(ctx.offramp.connect(ctx.bob).releaseFill(0)).to.be.revertedWith("P2POfframp: window open");

    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(ctx.offramp.connect(ctx.bob).releaseFill(0)).to.emit(ctx.offramp, "FillReleased");

    expect(await plain(await ctx.vault.balanceOf(ctx.bob.address))).to.equal(usdc(50));
    const [fillCount, disputeCount] = await ctx.offramp.getMakerReputation(ctx.alice.address);
    expect(fillCount).to.equal(1);
    expect(disputeCount).to.equal(0);
  });

  it("C8: short maker cannot drain the shared escrow pool via expireFill", async () => {
    const ctx = await loadFixture(deployFixture);
    // Alice escrows a real 50 (taken by Bob).
    await makeOffer(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    // Carol has 10 shielded but offers 50. The vault moves 0 at take.
    await ctx.usdcToken.mint(ctx.carol.address, usdc(10));
    await ctx.usdcToken.connect(ctx.carol).approve(await ctx.vault.getAddress(), usdc(10));
    await ctx.vault.connect(ctx.carol).shield(usdc(10));
    await ctx.vault.connect(ctx.carol).approvePlaintext(await ctx.offramp.getAddress(), (1n << 64n) - 1n);
    await makeOffer(ctx, ctx.carol, usdc(50), 2 * 24 * 3600);
    await ctx.offramp.connect(ctx.dave).takeOffer(1);
    expect(await plain(await ctx.offramp.getEscrowedAmount(1))).to.equal(0n);

    await time.increase(24 * 3600 + 1);
    await ctx.offramp.connect(ctx.carol).expireFill(1);
    // Old code paid Carol the requested 50 out of Alice's escrow.
    expect(await plain(await ctx.vault.balanceOf(ctx.carol.address))).to.equal(usdc(10));

    // Alice's escrow is intact: Bob's fill still pays out in full.
    await ctx.offramp.connect(ctx.bob).submitProof(0, await proofFor(ctx, 0, ctx.bob), RAIL_UPI_PHONEPE);
    await time.increase(CHALLENGE_WINDOW + 1);
    await ctx.offramp.releaseFill(0);
    expect(await plain(await ctx.vault.balanceOf(ctx.bob.address))).to.equal(usdc(50));
  });

  it("dispute path: maker disputes → arbiter resolves to maker → fill Refunded", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    await ctx.offramp.connect(ctx.bob).submitProof(0, await proofFor(ctx, 0, ctx.bob), RAIL_UPI_PHONEPE);

    await expect(ctx.offramp.connect(ctx.alice).disputeFill(0, "did not receive payment"))
      .to.emit(ctx.offramp, "FillDisputed");
    await expect(ctx.offramp.connect(ctx.arbiter).arbiterResolve(0, false))
      .to.emit(ctx.offramp, "FillResolved");

    const [, , , , , , state] = await ctx.offramp.getFill(0);
    expect(state).to.equal(5); // FillState.Refunded
    expect(await plain(await ctx.vault.balanceOf(ctx.alice.address))).to.equal(usdc(100));
    const [fillCount, disputeCount] = await ctx.offramp.getMakerReputation(ctx.alice.address);
    expect(fillCount).to.equal(0);
    expect(disputeCount).to.equal(1);
  });

  it("stale dispute: after 7 days without the arbiter, anyone releases to the taker", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    await ctx.offramp.connect(ctx.bob).submitProof(0, await proofFor(ctx, 0, ctx.bob), RAIL_UPI_PHONEPE);
    await ctx.offramp.connect(ctx.alice).disputeFill(0, "grief");

    await expect(ctx.offramp.connect(ctx.carol).resolveStaleDispute(0))
      .to.be.revertedWith("P2POfframp: arbiter window open");
    await time.increase(7 * 24 * 3600);
    await expect(ctx.offramp.connect(ctx.carol).resolveStaleDispute(0))
      .to.emit(ctx.offramp, "StaleDisputeReleased");

    const [, , , , , , state] = await ctx.offramp.getFill(0);
    expect(state).to.equal(4); // FillState.Resolved
    expect(await plain(await ctx.vault.balanceOf(ctx.bob.address))).to.equal(usdc(50));
    await expect(ctx.offramp.connect(ctx.arbiter).arbiterResolve(0, false))
      .to.be.revertedWith("P2POfframp: not disputed");
  });

  it("H12: a proof is bound to its fill, taker and chain", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(20));
    await makeOffer(ctx, ctx.alice, usdc(20));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    // Signed for another chain id.
    const wrongChain = await signReclaimMessage(ctx.operator, ctx, 0, ctx.bob.address, RAIL_UPI_PHONEPE, HANDLE, FIAT, 1n);
    await expect(ctx.offramp.connect(ctx.bob).submitProof(0, wrongChain, RAIL_UPI_PHONEPE))
      .to.be.revertedWith("MockReclaimVerifier: wrong signer");
    // Signed for another taker.
    const wrongTaker = await proofFor(ctx, 0, ctx.carol);
    await expect(ctx.offramp.connect(ctx.bob).submitProof(0, wrongTaker, RAIL_UPI_PHONEPE))
      .to.be.revertedWith("MockReclaimVerifier: wrong signer");

    const proof0 = await proofFor(ctx, 0, ctx.bob);
    await ctx.offramp.connect(ctx.bob).submitProof(0, proof0, RAIL_UPI_PHONEPE);

    // Old code accepted fill 0's proof for any fill with the same amount.
    await ctx.offramp.connect(ctx.bob).takeOffer(1);
    await expect(ctx.offramp.connect(ctx.bob).submitProof(1, proof0, RAIL_UPI_PHONEPE))
      .to.be.revertedWith("MockReclaimVerifier: wrong signer");
  });

  it("providerId must match the offer's rail", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    const proof = await signReclaimMessage(ctx.operator, ctx, 0, ctx.bob.address, 4, HANDLE, FIAT);
    await expect(ctx.offramp.connect(ctx.bob).submitProof(0, proof, 4))
      .to.be.revertedWith("P2POfframp: provider/rail mismatch");
  });

  it("taker can hold only one open lock", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(20));
    await makeOffer(ctx, ctx.alice, usdc(20));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    await expect(ctx.offramp.connect(ctx.bob).takeOffer(1))
      .to.be.revertedWith("P2POfframp: too many open locks");
    await ctx.offramp.connect(ctx.bob).submitProof(0, await proofFor(ctx, 0, ctx.bob), RAIL_UPI_PHONEPE);
    expect(await ctx.offramp.activeLocks(ctx.bob.address)).to.equal(0);
    await ctx.offramp.connect(ctx.bob).takeOffer(1);
  });

  it("vault allowlist: unregistered vault and unset registry both revert", async () => {
    const ctx = await loadFixture(deployFixture);
    const Fake = await hre.ethers.getContractFactory("MockVaultStub");
    const fake = await Fake.deploy(await ctx.usdcToken.getAddress());
    const enc = await encPair(ctx, ctx.alice, usdc(1), usdc(1), await ctx.offramp.getAddress());
    await expect(
      ctx.offramp.connect(ctx.alice).createOffer(await fake.getAddress(), ...enc, RAIL_UPI_PHONEPE, HANDLE, FIAT, 1n, 3600),
    ).to.be.revertedWith("P2POfframp: vault not allowed");

    const fresh = await deployProxy("P2POfframp", [
      ctx.arbiter.address, await ctx.adapter.getAddress(), await ctx.eventHub.getAddress(), CHALLENGE_WINDOW,
    ]);
    const enc2 = await encPair(ctx, ctx.alice, usdc(1), usdc(1), await fresh.getAddress());
    await expect(
      fresh.connect(ctx.alice).createOffer(await ctx.vault.getAddress(), ...enc2, RAIL_UPI_PHONEPE, HANDLE, FIAT, 1n, 3600),
    ).to.be.revertedWith("P2POfframp: vault not allowed");
  });

  it("admin setters: zero arbiter, EOA adapter and EOA registry revert; events emitted", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.offramp.setArbiter(hre.ethers.ZeroAddress)).to.be.revertedWith("P2POfframp: zero arbiter");
    await expect(ctx.offramp.setReclaimAdapter(ctx.carol.address)).to.be.revertedWith("P2POfframp: bad adapter");
    await expect(ctx.offramp.setTokenRegistry(ctx.carol.address)).to.be.revertedWith("P2POfframp: bad registry");
    await expect(ctx.offramp.setReclaimAdapter(await ctx.adapter.getAddress())).to.emit(ctx.offramp, "ReclaimAdapterChanged");
    await expect(ctx.offramp.setChallengeWindow(600)).to.emit(ctx.offramp, "ChallengeWindowChanged");
    await expect(ctx.offramp.connect(ctx.alice).setArbiter(ctx.alice.address))
      .to.be.revertedWithCustomError(ctx.offramp, "OwnableUnauthorizedAccount");
    await expect(
      deployProxy("P2POfframp", [hre.ethers.ZeroAddress, await ctx.adapter.getAddress(), await ctx.eventHub.getAddress(), CHALLENGE_WINDOW]),
    ).to.be.revertedWith("P2POfframp: zero arbiter");
  });

  it("guard: maker cannot self-take", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await expect(ctx.offramp.connect(ctx.alice).takeOffer(0))
      .to.be.revertedWith("P2POfframp: maker cannot self-take");
  });

  it("guard: cancelOffer flips state and blocks subsequent take", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await expect(ctx.offramp.connect(ctx.alice).cancelOffer(0)).to.emit(ctx.offramp, "OfferCancelled");
    await expect(ctx.offramp.connect(ctx.bob).takeOffer(0)).to.be.revertedWith("P2POfframp: offer not open");
  });

  it("expire path: maker reclaims after 24h proof window and the lock is freed", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50), 24 * 3600 * 2);
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    await expect(ctx.offramp.connect(ctx.alice).expireFill(0)).to.be.revertedWith("P2POfframp: proof window open");
    await time.increase(24 * 3600 + 1);
    await expect(ctx.offramp.connect(ctx.alice).expireFill(0)).to.emit(ctx.offramp, "FillRefunded");
    expect(await plain(await ctx.vault.balanceOf(ctx.alice.address))).to.equal(usdc(100));
    expect(await ctx.offramp.activeLocks(ctx.bob.address)).to.equal(0);
  });

  it("guard: dispute after window closed reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    await makeOffer(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    await ctx.offramp.connect(ctx.bob).submitProof(0, await proofFor(ctx, 0, ctx.bob), RAIL_UPI_PHONEPE);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(ctx.offramp.connect(ctx.alice).disputeFill(0, "too late"))
      .to.be.revertedWith("P2POfframp: window closed");
  });
});

async function verifierFixture() {
  const [owner, operator, attacker, offramp, taker] = await hre.ethers.getSigners();
  const verifier = await deployProxy("MockReclaimVerifier", [operator.address]);
  const adapter = await deployProxy("ReclaimAdapter", [await verifier.getAddress()]);
  // An EOA stands in for the offramp so the adapter can be called directly.
  await adapter.setCaller(offramp.address, true);
  return { owner, operator, attacker, offramp, taker, verifier, adapter };
}

async function signFor(signer: any, v: any, offramp: string, fillId: number, taker: string) {
  return signReclaimMessage(signer, { verifier: v.verifier, offramp: { getAddress: async () => offramp } }, fillId, taker, RAIL_UPI_PHONEPE, HANDLE, FIAT);
}

describe("MockReclaimVerifier", () => {
  it("rejects bad operator signature", async () => {
    const v = await loadFixture(verifierFixture);
    const proof = await signFor(v.attacker, v, v.offramp.address, 0, v.taker.address);
    await expect(
      v.verifier.verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address, v.offramp.address),
    ).to.be.revertedWith("MockReclaimVerifier: wrong signer");
  });

  it("returns the message digest as the replay key", async () => {
    const v = await loadFixture(verifierFixture);
    const proof = await signFor(v.operator, v, v.offramp.address, 3, v.taker.address);
    const [ok, key] = await v.verifier.verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 3, v.taker.address, v.offramp.address);
    expect(ok).to.equal(true);
    expect(key).to.equal(await v.verifier.attestationDigest(v.offramp.address, 3, v.taker.address, RAIL_UPI_PHONEPE, HANDLE, FIAT));
  });

  it("H12: high-s malleated signature is rejected", async () => {
    const v = await loadFixture(verifierFixture);
    const proof = await signFor(v.operator, v, v.offramp.address, 0, v.taker.address);
    const sig = hre.ethers.Signature.from(proof);
    const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const highS = N - BigInt(sig.s);
    const flippedV = sig.v === 27 ? 28 : 27;
    const malleated = hre.ethers.concat([sig.r, hre.ethers.toBeHex(highS, 32), hre.ethers.toBeHex(flippedV, 1)]);
    await expect(
      v.verifier.verifyAndConsume(malleated, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address, v.offramp.address),
    ).to.be.revertedWith("MockReclaimVerifier: bad signature");
  });

  it("rejects malformed proof length", async () => {
    const v = await loadFixture(verifierFixture);
    await expect(
      v.verifier.verifyAndConsume("0xdeadbeef", RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address, v.offramp.address),
    ).to.be.revertedWith("MockReclaimVerifier: bad sig length");
  });

  it("disabled when operator set to address(0)", async () => {
    const verifier = await deployProxy("MockReclaimVerifier", [hre.ethers.ZeroAddress]);
    const fakeProof = "0x" + "00".repeat(65);
    await expect(
      verifier.verifyAndConsume(fakeProof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, hre.ethers.ZeroAddress, hre.ethers.ZeroAddress),
    ).to.be.revertedWith("MockReclaimVerifier: disabled");
  });
});

describe("ReclaimAdapter", () => {
  it("rejects calls from non-allowed callers", async () => {
    const v = await loadFixture(verifierFixture);
    const proof = await signFor(v.operator, v, v.attacker.address, 0, v.taker.address);
    await expect(
      v.adapter.connect(v.attacker).verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address),
    ).to.be.revertedWith("ReclaimAdapter: caller not allowed");
  });

  it("binds the calling offramp and rejects a replayed attestation", async () => {
    const v = await loadFixture(verifierFixture);
    const proof = await signFor(v.operator, v, v.offramp.address, 0, v.taker.address);
    await v.adapter.connect(v.offramp).verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address);
    await expect(
      v.adapter.connect(v.offramp).verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address),
    ).to.be.revertedWith("ReclaimAdapter: proof replayed");

    // Same proof from a second allowed offramp: the binding to msg.sender fails.
    await v.adapter.setCaller(v.attacker.address, true);
    await expect(
      v.adapter.connect(v.attacker).verifyAndConsume(proof, RAIL_UPI_PHONEPE, HANDLE, FIAT, 0, v.taker.address),
    ).to.be.revertedWith("MockReclaimVerifier: wrong signer");
  });

  it("setters reject zero caller and EOA verifier", async () => {
    const v = await loadFixture(verifierFixture);
    await expect(v.adapter.setCaller(hre.ethers.ZeroAddress, true)).to.be.revertedWith("ReclaimAdapter: zero caller");
    await expect(v.adapter.setVerifier(v.attacker.address)).to.be.revertedWith("ReclaimAdapter: bad verifier");
    await expect(v.adapter.setVerifier(await v.verifier.getAddress())).to.emit(v.adapter, "VerifierChanged");
  });
});
