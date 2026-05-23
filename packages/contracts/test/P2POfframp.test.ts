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

async function signReclaimMessage(
  operator: any,
  providerId: number,
  receiverHandle: string,
  amountMicroUSD: bigint,
): Promise<string> {
  // Matches MockReclaimVerifier.verifyAndConsume: keccak256(abi.encode(
  // uint32 providerId, bytes32 receiver, uint64 amount))
  const messageHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint32", "bytes32", "uint64"],
      [providerId, receiverHandle, amountMicroUSD],
    ),
  );
  // signMessage prepends "\x19Ethereum Signed Message:\n32" automatically.
  return operator.signMessage(getBytes(messageHash));
}

async function encUint64(ctx: any, signer: any, value: bigint) {
  await hre.cofhe.connectWithHardhatSigner(ctx.client, signer);
  const [enc] = await ctx.client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
}

async function deployFixture() {
  const [owner, alice, bob, carol, operator, arbiter] = await hre.ethers.getSigners();
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

  // Wire: allow offramp to call the adapter, and let offramp + vault
  // emit events.
  await adapter.setCaller(await offramp.getAddress(), true);
  await eventHub.batchWhitelist([
    await offramp.getAddress(),
    await vault.getAddress(),
  ]);

  // Alice (maker) shields 100 USDC into the vault + approves offramp
  // to pull her encrypted USDC.
  await usdcToken.mint(alice.address, usdc(1_000));
  await usdcToken.connect(alice).approve(await vault.getAddress(), usdc(1_000));
  await vault.connect(alice).shield(usdc(100));
  // Approve offramp with the max uint64 so all subsequent encrypted
  // pulls succeed regardless of amount.
  await vault
    .connect(alice)
    .approvePlaintext(await offramp.getAddress(), (1n << 64n) - 1n);

  // Bob (taker) doesn't need USDC to take (the maker's USDC is what's
  // escrowed) but he needs vault permissions for the eventual mint.

  return {
    owner, alice, bob, carol, operator, arbiter,
    client,
    usdcToken, eventHub, vault, verifier, adapter, offramp,
  };
}

describe("P2POfframp", () => {
  it("happy path: createOffer → takeOffer → submitProof → release after window", async () => {
    const ctx = await loadFixture(deployFixture);

    // Alice's handle digest (publishes which UPI VPA the taker pays to).
    const aliceHandleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));

    // Encrypt the USDC amount + the min-fill (kept for storage but
    // not enforced in v1 since full-fill only).
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));

    const fiatAmountMicroUSD = 50_000_000n;       // $50 expressed in microUSD
    const fiatRateMicroUSD   = 83_000_000n;       // 1 USDC = 83 INR demo

    // 1) Alice creates offer.
    await expect(
      ctx.offramp.connect(ctx.alice).createOffer(
        await ctx.vault.getAddress(),
        encAmount,
        encMin,
        RAIL_UPI_PHONEPE,
        aliceHandleHash,
        fiatAmountMicroUSD,
        fiatRateMicroUSD,
        3600,   // 1h expiry
      ),
    ).to.emit(ctx.offramp, "OfferCreated");

    // 2) Bob takes the offer.
    await expect(ctx.offramp.connect(ctx.bob).takeOffer(0))
      .to.emit(ctx.offramp, "FillLocked");

    // 3) Operator signs a Reclaim proof attesting Bob paid Alice.
    const proof = await signReclaimMessage(
      ctx.operator, RAIL_UPI_PHONEPE, aliceHandleHash, fiatAmountMicroUSD,
    );

    await expect(ctx.offramp.connect(ctx.bob).submitProof(0, proof, RAIL_UPI_PHONEPE))
      .to.emit(ctx.offramp, "ProofSubmitted");

    // 4) Open challenge window. Releasing before time-skip must revert.
    await expect(
      ctx.offramp.connect(ctx.bob).releaseFill(0),
    ).to.be.revertedWith("P2POfframp: window open");

    // 5) Skip past challenge window. Anyone can call releaseFill.
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(ctx.offramp.connect(ctx.bob).releaseFill(0))
      .to.emit(ctx.offramp, "FillReleased");

    // 6) Maker reputation +1; no dispute.
    const [fillCount, disputeCount] = await ctx.offramp.getMakerReputation(ctx.alice.address);
    expect(fillCount).to.equal(1);
    expect(disputeCount).to.equal(0);
  });

  it("dispute path: maker disputes → arbiter resolves to maker → fill Refunded", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    // Bob submits a proof; Alice disputes.
    const proof = await signReclaimMessage(ctx.operator, RAIL_UPI_PHONEPE, handleHash, 50_000_000n);
    await ctx.offramp.connect(ctx.bob).submitProof(0, proof, RAIL_UPI_PHONEPE);

    await expect(
      ctx.offramp.connect(ctx.alice).disputeFill(0, "did not receive payment"),
    ).to.emit(ctx.offramp, "FillDisputed");

    // Arbiter resolves to maker.
    await expect(
      ctx.offramp.connect(ctx.arbiter).arbiterResolve(0, /*releaseToTaker=*/false),
    ).to.emit(ctx.offramp, "FillResolved");

    const [, , , , , , state] = await ctx.offramp.getFill(0);
    expect(state).to.equal(5); // FillState.Refunded

    const [fillCount, disputeCount] = await ctx.offramp.getMakerReputation(ctx.alice.address);
    expect(fillCount).to.equal(0);
    expect(disputeCount).to.equal(1);
  });

  it("anti-replay: same Reclaim proof submitted twice reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));

    // Make TWO offers from alice. Second one's full-fill amount must
    // match the same proof to test replay rejection.
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );

    const enc2 = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin2 = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      enc2, encMin2, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );

    await ctx.offramp.connect(ctx.bob).takeOffer(0);
    await ctx.offramp.connect(ctx.bob).takeOffer(1);

    const proof = await signReclaimMessage(ctx.operator, RAIL_UPI_PHONEPE, handleHash, 50_000_000n);

    await ctx.offramp.connect(ctx.bob).submitProof(0, proof, RAIL_UPI_PHONEPE);

    // Re-submitting the same proof on a different fill must revert in
    // the adapter via usedProofs[proofHash].
    await expect(
      ctx.offramp.connect(ctx.bob).submitProof(1, proof, RAIL_UPI_PHONEPE),
    ).to.be.revertedWith("ReclaimAdapter: proof replayed");
  });

  it("guard: maker cannot self-take", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );
    await expect(
      ctx.offramp.connect(ctx.alice).takeOffer(0),
    ).to.be.revertedWith("P2POfframp: maker cannot self-take");
  });

  it("guard: cancelOffer flips state and blocks subsequent take", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );

    await expect(ctx.offramp.connect(ctx.alice).cancelOffer(0))
      .to.emit(ctx.offramp, "OfferCancelled");

    await expect(
      ctx.offramp.connect(ctx.bob).takeOffer(0),
    ).to.be.revertedWith("P2POfframp: offer not open");
  });

  it("expire path: maker reclaims after 24h proof window", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 24 * 3600 * 2,
    );
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    // Bob never submits; Alice cannot expire before 24h.
    await expect(
      ctx.offramp.connect(ctx.alice).expireFill(0),
    ).to.be.revertedWith("P2POfframp: proof window open");

    await time.increase(24 * 3600 + 1);
    await expect(ctx.offramp.connect(ctx.alice).expireFill(0))
      .to.emit(ctx.offramp, "FillRefunded");
  });

  it("guard: dispute after window closed reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const encAmount = await encUint64(ctx, ctx.alice, usdc(50));
    const encMin    = await encUint64(ctx, ctx.alice, usdc(50));
    await ctx.offramp.connect(ctx.alice).createOffer(
      await ctx.vault.getAddress(),
      encAmount, encMin, RAIL_UPI_PHONEPE, handleHash, 50_000_000n, 83_000_000n, 3600,
    );
    await ctx.offramp.connect(ctx.bob).takeOffer(0);

    const proof = await signReclaimMessage(ctx.operator, RAIL_UPI_PHONEPE, handleHash, 50_000_000n);
    await ctx.offramp.connect(ctx.bob).submitProof(0, proof, RAIL_UPI_PHONEPE);

    await time.increase(CHALLENGE_WINDOW + 1);

    await expect(
      ctx.offramp.connect(ctx.alice).disputeFill(0, "too late"),
    ).to.be.revertedWith("P2POfframp: window closed");
  });
});

describe("MockReclaimVerifier", () => {
  it("rejects bad operator signature", async () => {
    const [owner, operator, attacker] = await hre.ethers.getSigners();
    const verifier = await deployProxy("MockReclaimVerifier", [operator.address]);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    // Sign with the wrong key.
    const proof = await signReclaimMessage(attacker, RAIL_UPI_PHONEPE, handleHash, 50_000_000n);
    await expect(
      verifier.verifyAndConsume(proof, RAIL_UPI_PHONEPE, handleHash, 50_000_000n),
    ).to.be.revertedWith("MockReclaimVerifier: wrong signer");
  });

  it("rejects malformed proof length", async () => {
    const [owner, operator] = await hre.ethers.getSigners();
    const verifier = await deployProxy("MockReclaimVerifier", [operator.address]);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    await expect(
      verifier.verifyAndConsume("0xdeadbeef", RAIL_UPI_PHONEPE, handleHash, 50_000_000n),
    ).to.be.revertedWith("MockReclaimVerifier: bad sig length");
  });

  it("disabled when operator set to address(0)", async () => {
    const [owner] = await hre.ethers.getSigners();
    const verifier = await deployProxy("MockReclaimVerifier", [hre.ethers.ZeroAddress]);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const fakeProof = "0x" + "00".repeat(65);
    await expect(
      verifier.verifyAndConsume(fakeProof, RAIL_UPI_PHONEPE, handleHash, 50_000_000n),
    ).to.be.revertedWith("MockReclaimVerifier: disabled");
  });
});

describe("ReclaimAdapter", () => {
  it("rejects calls from non-allowed callers", async () => {
    const [owner, operator, randomCaller] = await hre.ethers.getSigners();
    const verifier = await deployProxy("MockReclaimVerifier", [operator.address]);
    const adapter = await deployProxy("ReclaimAdapter", [await verifier.getAddress()]);
    const handleHash = keccak256(getBytes("0x" + Buffer.from("alice@upi").toString("hex")));
    const proof = await signReclaimMessage(operator, RAIL_UPI_PHONEPE, handleHash, 50_000_000n);
    await expect(
      adapter.connect(randomCaller).verifyAndConsume(proof, RAIL_UPI_PHONEPE, handleHash, 50_000_000n),
    ).to.be.revertedWith("ReclaimAdapter: caller not allowed");
  });
});
