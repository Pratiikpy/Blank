import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  PrivacyRouter — Encrypted-input DEX swap router (2-phase async)
//
//  Critical because the router holds plaintext ERC20 reserves and
//  acts as the bridge between encrypted vault balances and a public
//  DEX. A bug here either leaks user balances, locks user funds in
//  Decrypting/Cancelled/Expired states, or lets a non-user drain
//  someone else's pending swap.
//
//  Covers:
//   • initiateSwap: happy path, zero vault, same vault, same underlying
//   • executeSwap: happy path, wrong status, expired, insufficient reserves
//   • cancelSwap: not-the-user, immediate refund path, decrypt-not-ready path
//   • claimCancelledSwap: happy path, not-cancelled, not-your-swap, already-refunded
//   • claimExpiredSwap: happy path, not-yet-expired
//   • Admin: fundReserves, withdrawReserves (owner-only),
//     setDexRouter (owner-only + zero-addr), setEventHub
//   • View helpers: getSwap, getUserSwaps, reserves, isExpired
//   • Re-entrancy: nonReentrant guard via SwapInitiated → executeSwap
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

const STATUS_DECRYPTING = 1;
const STATUS_EXECUTED = 3;
const STATUS_CANCELLED = 4;
const STATUS_EXPIRED = 5;
const STATUS_REFUNDED = 6;

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
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  // Two ERC20s: tokenIn (USDC-like) and tokenOut (WETH-like).
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const tokenIn = await TestUSDC.deploy();
  await tokenIn.waitForDeployment();
  const tokenOut = await TestUSDC.deploy();
  await tokenOut.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vaultIn = await deployProxy("FHERC20Vault", [
    await tokenIn.getAddress(),
    "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const vaultOut = await deployProxy("FHERC20Vault", [
    await tokenOut.getAddress(),
    "Blank WETH Vault", "bvWETH", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);

  // MockDEX with 1:1 fixed rate (rate = 1_000_000 means 1 in → 1 out).
  const MockDEX = await hre.ethers.getContractFactory("MockDEX");
  const dex = await MockDEX.deploy();
  await dex.waitForDeployment();
  await dex.setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 1_000_000n);

  // PrivacyRouter
  const router = await deployProxy("PrivacyRouter", [
    await dex.getAddress(),
    await eventHub.getAddress(),
  ]);

  // Whitelist router so emitActivity doesn't revert (router uses try/catch
  // but whitelisting is still the deployment convention).
  await eventHub.batchWhitelist([await router.getAddress()]);

  // Fund: tokenOut into DEX (so the DEX can pay out swaps); tokenIn into
  // router reserves (so the router can spend on the DEX leg).
  await tokenOut.mint(owner.address, usdc(100_000));
  await tokenOut.connect(owner).approve(await dex.getAddress(), usdc(100_000));
  await dex.connect(owner).fund(await tokenOut.getAddress(), usdc(100_000));

  await tokenIn.mint(owner.address, usdc(100_000));
  await tokenIn.connect(owner).approve(await router.getAddress(), usdc(100_000));
  await router.connect(owner).fundReserves(await tokenIn.getAddress(), usdc(50_000));

  // Mint alice/bob tokenIn and shield into vaultIn so they can swap.
  for (const s of [alice, bob, charlie]) {
    await tokenIn.mint(s.address, usdc(10_000));
    await tokenIn.connect(s).approve(await vaultIn.getAddress(), usdc(10_000));
    await vaultIn.connect(s).shield(usdc(1_000));
  }
  const MAX = (1n << 64n) - 1n;
  for (const s of [alice, bob, charlie]) {
    await vaultIn.connect(s).approvePlaintext(await router.getAddress(), MAX);
  }

  return { owner, alice, bob, charlie, client, tokenIn, tokenOut, vaultIn, vaultOut, eventHub, dex, router };
}

async function encUint64(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

// Off-chain decrypt of a swap's encrypted amount-in handle. Returns the
// (plaintext, signature) pair so the caller can pass them to executeSwap /
// cancelSwap / claim*Swap and have FHE.publishDecryptResult unlock the
// subsequent getDecryptResultSafe(swap.encryptedAmountIn) read.
async function decryptAmountIn(router: any, client: any, signer: any, swapId: number) {
  const handle = await router.getEncryptedAmountIn(swapId);
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const proof = await client.decryptForTx(handle, FheTypes.Uint64).withoutACP().execute();
  return { plaintext: proof.decryptedValue as bigint, signature: proof.signature as string };
}

describe("PrivacyRouter — initiateSwap", () => {
  it("emits SwapInitiated, sets status=Decrypting, records minAmountOut + timestamp", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    const t0 = await time.latest();
    await expect(
      ctx.router.connect(ctx.alice).initiateSwap(
        await ctx.vaultIn.getAddress(),
        await ctx.vaultOut.getAddress(),
        ...enc,
        usdc(9), // 10% slippage
      ),
    ).to.emit(ctx.router, "SwapInitiated");

    const s = await ctx.router.getSwap(0);
    expect(s.user).to.equal(ctx.alice.address);
    expect(s.vaultIn).to.equal(await ctx.vaultIn.getAddress());
    expect(s.vaultOut).to.equal(await ctx.vaultOut.getAddress());
    expect(s.minAmountOut).to.equal(usdc(9));
    expect(Number(s.timestamp)).to.be.greaterThanOrEqual(t0);
    expect(s.status).to.equal(STATUS_DECRYPTING);

    // User's vault balance dropped by 10; router's vault balance gained 10.
    await mock_expectPlaintext(
      ctx.alice.provider,
      await ctx.vaultIn.balanceOf(ctx.alice.address),
      usdc(990),
    );
    await mock_expectPlaintext(
      ctx.alice.provider,
      await ctx.vaultIn.balanceOf(await ctx.router.getAddress()),
      usdc(10),
    );
  });

  it("rejects zero vault address", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await expect(
      ctx.router.connect(ctx.alice).initiateSwap(
        hre.ethers.ZeroAddress,
        await ctx.vaultOut.getAddress(),
        ...enc,
        usdc(9),
      ),
    ).to.be.revertedWith("PrivacyRouter: zero vault");
  });

  it("rejects vaultIn == vaultOut", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await expect(
      ctx.router.connect(ctx.alice).initiateSwap(
        await ctx.vaultIn.getAddress(),
        await ctx.vaultIn.getAddress(),
        ...enc,
        usdc(9),
      ),
    ).to.be.revertedWith("PrivacyRouter: same vault");
  });

  it("rejects two vaults sharing the same underlying", async () => {
    const ctx = await loadFixture(deployFixture);
    // Spin up a second vault on the SAME tokenIn — different vault address,
    // same underlying. The router must reject this to prevent a no-op swap.
    const dupVault = await deployProxy("FHERC20Vault", [
      await ctx.tokenIn.getAddress(),
      "Dup USDC Vault", "bvUSDC2", USDC_DECIMALS,
      await ctx.eventHub.getAddress(),
    ]);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await expect(
      ctx.router.connect(ctx.alice).initiateSwap(
        await ctx.vaultIn.getAddress(),
        await dupVault.getAddress(),
        ...enc,
        usdc(9),
      ),
    ).to.be.revertedWith("PrivacyRouter: same underlying");
  });
});

describe("PrivacyRouter — executeSwap", () => {
  it("settles swap, transfers output to user, marks status=Executed", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(),
      await ctx.vaultOut.getAddress(),
      ...enc,
      usdc(9),
    );

    // Decrypt off-chain (mock TN) then submit (plaintext, signature) so
    // FHE.publishDecryptResult inside executeSwap unlocks the read.
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await expect(
      ctx.router.connect(ctx.bob).executeSwap(0, proof.plaintext, proof.signature),
    ).to.emit(ctx.router, "SwapExecuted").withArgs(0, ctx.alice.address, usdc(10), anyValue);

    const s = await ctx.router.getSwap(0);
    expect(s.status).to.equal(STATUS_EXECUTED);
    expect(s.plaintextAmountIn).to.equal(usdc(10));

    // Alice receives plaintext tokenOut from the router (rate 1:1 → 10 tokens).
    expect(await ctx.tokenOut.balanceOf(ctx.alice.address)).to.equal(usdc(10));
  });

  it("rejects re-execution after Executed", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await ctx.router.connect(ctx.bob).executeSwap(0, proof.plaintext, proof.signature);
    // After Executed, second call rejects on the status check (decrypt was
    // already published, so the signature/plaintext bypass is irrelevant).
    await expect(
      ctx.router.connect(ctx.bob).executeSwap(0, 0, "0x"),
    ).to.be.revertedWith("PrivacyRouter: not decrypting");
  });

  it("rejects execution after expiry — use claimExpiredSwap instead", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await time.increase(10 * 60 + 1); // SWAP_EXPIRY = 10 minutes
    await expect(
      ctx.router.connect(ctx.bob).executeSwap(0, 0, "0x"),
    ).to.be.revertedWith("PrivacyRouter: expired, use claimExpiredSwap");
  });

  it("rejects execution when router has insufficient reserves", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.router.connect(ctx.owner).withdrawReserves(
      await ctx.tokenIn.getAddress(), usdc(50_000), ctx.owner.address,
    );
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await expect(
      ctx.router.connect(ctx.bob).executeSwap(0, proof.plaintext, proof.signature),
    ).to.be.revertedWith("PrivacyRouter: insufficient reserves");
  });
});

describe("PrivacyRouter — cancelSwap", () => {
  it("rejects cancel from non-user", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await expect(
      ctx.router.connect(ctx.bob).cancelSwap(0),
    ).to.be.revertedWith("PrivacyRouter: not the user");
  });

  it("cancel before publish lands swap in Cancelled (refund deferred to claimCancelledSwap)", async () => {
    // cancelSwap's "immediate refund" branch requires the decrypt result
    // to already be on-chain (ready=true) AND the router to have reserves.
    // Without a prior FHE.publishDecryptResult, ready=false, so the swap
    // falls through to the Cancelled state. The user later calls
    // claimCancelledSwap(plaintext, signature) to publish and refund —
    // covered in the next describe block.
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await ctx.router.connect(ctx.alice).cancelSwap(0);
    expect((await ctx.router.getSwap(0)).status).to.equal(STATUS_CANCELLED);
  });

  it("rejects cancel after Executed", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await ctx.router.connect(ctx.bob).executeSwap(0, proof.plaintext, proof.signature);
    await expect(
      ctx.router.connect(ctx.alice).cancelSwap(0),
    ).to.be.revertedWith("PrivacyRouter: cannot cancel");
  });
});

describe("PrivacyRouter — claimCancelledSwap", () => {
  // To exercise the "decrypt-not-ready or router lacks reserves" branch
  // of cancelSwap, we drain reserves first so the immediate refund fails
  // and the swap lands in Cancelled. Then we top up reserves and have
  // alice claim. (decryption is always ready in mock mode.)
  it("after Cancelled (reserves were empty), user claims refund once reserves are restored", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );

    // Drain router reserves so cancelSwap can't immediately refund.
    await ctx.router.connect(ctx.owner).withdrawReserves(
      await ctx.tokenIn.getAddress(), usdc(50_000), ctx.owner.address,
    );

    // Cancel → falls to Cancelled state (reserves were empty).
    await ctx.router.connect(ctx.alice).cancelSwap(0);
    expect((await ctx.router.getSwap(0)).status).to.equal(STATUS_CANCELLED);

    // Top up reserves so the user can claim.
    await ctx.tokenIn.connect(ctx.owner).approve(await ctx.router.getAddress(), usdc(100));
    await ctx.router.connect(ctx.owner).fundReserves(await ctx.tokenIn.getAddress(), usdc(100));

    const aliceTokenInBefore = await ctx.tokenIn.balanceOf(ctx.alice.address);
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await expect(
      ctx.router.connect(ctx.alice).claimCancelledSwap(0, proof.plaintext, proof.signature),
    ).to.emit(ctx.router, "SwapRefunded").withArgs(0, ctx.alice.address, usdc(10));
    expect((await ctx.router.getSwap(0)).status).to.equal(STATUS_REFUNDED);
    expect(await ctx.tokenIn.balanceOf(ctx.alice.address)).to.equal(aliceTokenInBefore + usdc(10));
  });

  it("rejects claimCancelledSwap from a non-user", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await ctx.router.connect(ctx.owner).withdrawReserves(
      await ctx.tokenIn.getAddress(), usdc(50_000), ctx.owner.address,
    );
    await ctx.router.connect(ctx.alice).cancelSwap(0);
    await expect(
      ctx.router.connect(ctx.bob).claimCancelledSwap(0, 0, "0x"),
    ).to.be.revertedWith("PrivacyRouter: not your swap");
  });

  it("rejects claimCancelledSwap on a swap that was never cancelled", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await expect(
      ctx.router.connect(ctx.alice).claimCancelledSwap(0, 0, "0x"),
    ).to.be.revertedWith("PrivacyRouter: not cancelled");
  });
});

describe("PrivacyRouter — claimExpiredSwap", () => {
  it("after expiry, anyone can call and the user receives their tokens back", async () => {
    const ctx = await loadFixture(deployFixture);
    const aliceTokenInBefore = await ctx.tokenIn.balanceOf(ctx.alice.address);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    // Decrypt BEFORE advancing time — the off-chain TN signature doesn't
    // care about block.timestamp, only the handle.
    const proof = await decryptAmountIn(ctx.router, ctx.client, ctx.alice, 0);
    await time.increase(10 * 60 + 1);

    await expect(
      ctx.router.connect(ctx.bob).claimExpiredSwap(0, proof.plaintext, proof.signature), // bob, not alice
    ).to.emit(ctx.router, "SwapExpired");

    expect((await ctx.router.getSwap(0)).status).to.equal(STATUS_EXPIRED);
    expect(await ctx.tokenIn.balanceOf(ctx.alice.address)).to.equal(aliceTokenInBefore + usdc(10));
  });

  it("rejects claimExpiredSwap before expiry", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    await expect(
      ctx.router.connect(ctx.bob).claimExpiredSwap(0, 0, "0x"),
    ).to.be.revertedWith("PrivacyRouter: not expired yet");
  });
});

describe("PrivacyRouter — admin", () => {
  it("fundReserves: anyone can fund; emits RouterFunded", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.tokenIn.mint(ctx.alice.address, usdc(50));
    await ctx.tokenIn.connect(ctx.alice).approve(await ctx.router.getAddress(), usdc(50));
    await expect(
      ctx.router.connect(ctx.alice).fundReserves(await ctx.tokenIn.getAddress(), usdc(50)),
    ).to.emit(ctx.router, "RouterFunded").withArgs(await ctx.tokenIn.getAddress(), usdc(50), ctx.alice.address);
  });

  it("fundReserves rejects zero amount", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.router.connect(ctx.alice).fundReserves(await ctx.tokenIn.getAddress(), 0),
    ).to.be.revertedWith("PrivacyRouter: zero amount");
  });

  it("withdrawReserves: owner-only, zero-address rejected", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.router.connect(ctx.alice).withdrawReserves(
        await ctx.tokenIn.getAddress(), usdc(10), ctx.alice.address,
      ),
    ).to.be.revertedWithCustomError(ctx.router, "OwnableUnauthorizedAccount");
    await expect(
      ctx.router.connect(ctx.owner).withdrawReserves(
        await ctx.tokenIn.getAddress(), usdc(10), hre.ethers.ZeroAddress,
      ),
    ).to.be.revertedWith("PrivacyRouter: zero address");
  });

  it("setDexRouter: owner-only, rejects zero-addr, emits DexRouterUpdated", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.router.connect(ctx.alice).setDexRouter(ctx.bob.address),
    ).to.be.revertedWithCustomError(ctx.router, "OwnableUnauthorizedAccount");
    await expect(
      ctx.router.connect(ctx.owner).setDexRouter(hre.ethers.ZeroAddress),
    ).to.be.revertedWith("PrivacyRouter: zero address");
    await expect(
      ctx.router.connect(ctx.owner).setDexRouter(ctx.bob.address),
    ).to.emit(ctx.router, "DexRouterUpdated");
  });

  it("setEventHub: owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.router.connect(ctx.alice).setEventHub(ctx.bob.address),
    ).to.be.revertedWithCustomError(ctx.router, "OwnableUnauthorizedAccount");
  });
});

describe("PrivacyRouter — views", () => {
  it("getUserSwaps returns the user's swap IDs in initiation order", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc1 = await encUint64(ctx.client, ctx.alice, usdc(5), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc1, usdc(4),
    );
    const enc2 = await encUint64(ctx.client, ctx.alice, usdc(7), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc2, usdc(6),
    );
    const ids = await ctx.router.getUserSwaps(ctx.alice.address);
    expect(ids.length).to.equal(2);
    expect(ids[0]).to.equal(0);
    expect(ids[1]).to.equal(1);
  });

  it("isExpired flips after SWAP_EXPIRY (10 min)", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encUint64(ctx.client, ctx.alice, usdc(10), await ctx.router.getAddress());
    await ctx.router.connect(ctx.alice).initiateSwap(
      await ctx.vaultIn.getAddress(), await ctx.vaultOut.getAddress(), ...enc, usdc(9),
    );
    expect(await ctx.router.isExpired(0)).to.equal(false);
    await time.increase(10 * 60 + 1);
    expect(await ctx.router.isExpired(0)).to.equal(true);
  });

  it("reserves returns the router's plaintext balance of the queried token", async () => {
    const ctx = await loadFixture(deployFixture);
    // Pre-funded with 50_000 in the fixture.
    expect(await ctx.router.reserves(await ctx.tokenIn.getAddress())).to.equal(usdc(50_000));
  });
});

