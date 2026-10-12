import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  InheritanceManager — Dead-man's-switch for encrypted wallets
//
//  Pre-existing Blank.test.ts coverage: #185 finalizeClaim mutex and
//  #351 setVaults bad-vault guards. The setHeir/heartbeat/startClaim
//  lifecycle, time-window invariants, the "setHeir clears the
//  finalize mutex" carry-over behaviour, and the cancel-claim-via-
//  heartbeat path are all UNTESTED — yet they protect against the
//  principal-cannot-rotate-after-finalize bug and against an heir
//  finalizing before the challenge window.
//
//  Covers:
//   • setHeir guards: zero heir, heir == sender, period < 30d
//   • setHeir resets claimFinalized so a post-finalize principal can
//     rotate to a new plan (load-bearing per the source comment)
//   • removeHeir guard: no plan
//   • setVaults guard: max 20 vaults (DoS cap)
//   • heartbeat: cancels a pending claim + emits ClaimCancelled
//   • startClaim guards: no plan, not heir, already pending,
//     owner still within inactivity period
//   • finalizeClaim guards: not heir, no pending claim, challenge
//     period still active, amounts/vaults length mismatch
//   • Happy-path finalize: heir receives vault balances post-window
//   • isClaimable view flips at the right time
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);
const MIN_INACTIVITY = 30 * 86400;
const CHALLENGE_PERIOD = 7 * 86400;

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
  const [owner, principal, heir, otherHeir, stranger] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const testUSDC = await TestUSDC.deploy();
  await testUSDC.waitForDeployment();

  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await testUSDC.getAddress(), "Blank USDC Vault", "bvUSDC", USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const im = await deployProxy("InheritanceManager", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await im.getAddress()]);

  // Principal shields some USDC + approves IM as a spender on the vault.
  await testUSDC.mint(principal.address, usdc(10_000));
  await testUSDC.connect(principal).approve(await vault.getAddress(), usdc(10_000));
  await vault.connect(principal).shield(usdc(500));
  const MAX = (1n << 64n) - 1n;
  await vault.connect(principal).approvePlaintext(await im.getAddress(), MAX);

  return { owner, principal, heir, otherHeir, stranger, client, testUSDC, vault, im };
}

async function encAmt(client: any, signer: any, amount: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(amount)]).setConsumingContract(consuming).execute();
}

describe("InheritanceManager — setHeir guards", () => {
  it("rejects zero heir", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.principal).setHeir(hre.ethers.ZeroAddress, MIN_INACTIVITY),
    ).to.be.revertedWith("InheritanceManager: invalid heir");
  });

  it("rejects heir == sender (self-inheritance loop)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.principal).setHeir(ctx.principal.address, MIN_INACTIVITY),
    ).to.be.revertedWith("InheritanceManager: invalid heir");
  });

  it("rejects inactivityPeriod < 30 days (MIN_INACTIVITY)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, 86400), // 1 day
    ).to.be.revertedWith("InheritanceManager: min 30 days");
  });

  it("accepts exactly 30 days", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY),
    ).to.emit(ctx.im, "HeirSet");
  });
});

describe("InheritanceManager — setHeir resets claimFinalized (post-finalize re-plan)", () => {
  it("a principal who outlives a finalize can call setHeir again and start fresh", async () => {
    // This pins the load-bearing comment at setHeir's `claimFinalized = false`
    // reset. Without that reset, a principal who happens to keep enough
    // balance after a finalize (or shields fresh funds) would never be able
    // to set up a NEW inheritance plan — claimFinalized[principal] stays
    // true forever and blocks every future heir at finalizeClaim.
    const ctx = await loadFixture(deployFixture);
    const oneVault = [await ctx.vault.getAddress()];

    // Plan 1: setHeir → setVaults → wait inactivity → startClaim → wait
    // challenge → finalizeClaim.
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults(oneVault);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);
    const e1 = await encAmt(ctx.client, ctx.heir, usdc(500), await ctx.im.getAddress());
    await ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [e1[0]], e1[1]);
    expect(await ctx.im.claimFinalized(ctx.principal.address)).to.equal(true);

    // Principal sets a fresh plan — the mutex flag should be cleared on
    // setHeir.
    await ctx.im.connect(ctx.principal).setHeir(ctx.otherHeir.address, MIN_INACTIVITY);
    expect(await ctx.im.claimFinalized(ctx.principal.address)).to.equal(false);

    // Now the new heir can also reach finalize (proving the mutex no
    // longer blocks them).
    await ctx.im.connect(ctx.principal).setVaults(oneVault);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.otherHeir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);
    const e2 = await encAmt(ctx.client, ctx.otherHeir, usdc(1), await ctx.im.getAddress());
    await expect(
      ctx.im.connect(ctx.otherHeir).finalizeClaim(ctx.principal.address, [e2[0]], e2[1]),
    ).to.not.be.reverted;
  });
});

describe("InheritanceManager — heartbeat + removeHeir", () => {
  it("heartbeat cancels a pending claim and emits ClaimCancelled", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);

    await expect(
      ctx.im.connect(ctx.principal).heartbeat(),
    ).to.emit(ctx.im, "ClaimCancelled").withArgs(ctx.principal.address, await timestamp1());

    const plan = await ctx.im.getPlan(ctx.principal.address);
    expect(plan.claimStartedAt).to.equal(0);
  });

  it("heartbeat without an active plan reverts", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.stranger).heartbeat(),
    ).to.be.revertedWith("InheritanceManager: no plan");
  });

  it("removeHeir rejects when no plan exists", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.stranger).removeHeir(),
    ).to.be.revertedWith("InheritanceManager: no plan");
  });

  it("removeHeir flips active=false", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).removeHeir();
    const plan = await ctx.im.getPlan(ctx.principal.address);
    expect(plan.active).to.equal(false);
  });
});

describe("InheritanceManager — setVaults DoS cap (P2.14)", () => {
  it("rejects > 20 vaults to prevent finalizeClaim out-of-gas DoS", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    // 21 distinct non-zero addresses (offset to avoid colliding with signers).
    const vaults = [];
    for (let i = 1; i <= 21; i++) {
      vaults.push(hre.ethers.getAddress("0x" + i.toString(16).padStart(40, "0")));
    }
    await expect(
      ctx.im.connect(ctx.principal).setVaults(vaults),
    ).to.be.revertedWith("InheritanceManager: too many vaults");
  });
});

describe("InheritanceManager — startClaim guards", () => {
  it("rejects startClaim when no plan exists", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.im.connect(ctx.heir).startClaim(ctx.stranger.address),
    ).to.be.revertedWith("InheritanceManager: no plan");
  });

  it("rejects startClaim from non-heir", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await time.increase(MIN_INACTIVITY + 1);
    await expect(
      ctx.im.connect(ctx.otherHeir).startClaim(ctx.principal.address),
    ).to.be.revertedWith("InheritanceManager: not heir");
  });

  it("rejects startClaim when owner is still within inactivity period", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    // No time advance — owner is fresh from setHeir's heartbeat.
    await expect(
      ctx.im.connect(ctx.heir).startClaim(ctx.principal.address),
    ).to.be.revertedWith("InheritanceManager: owner still active");
  });

  it("rejects second startClaim if one is already pending", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await expect(
      ctx.im.connect(ctx.heir).startClaim(ctx.principal.address),
    ).to.be.revertedWith("InheritanceManager: claim already pending");
  });
});

describe("InheritanceManager — finalizeClaim guards + happy path", () => {
  it("rejects finalize within the 7-day challenge period", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    // Only advance 6 days — still inside challenge.
    await time.increase(6 * 86400);
    const e = await encAmt(ctx.client, ctx.heir, usdc(100), await ctx.im.getAddress());
    await expect(
      ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [e[0]], e[1]),
    ).to.be.revertedWith("InheritanceManager: challenge period active");
  });

  it("rejects finalize from non-heir", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);
    const e = await encAmt(ctx.client, ctx.otherHeir, usdc(100), await ctx.im.getAddress());
    await expect(
      ctx.im.connect(ctx.otherHeir).finalizeClaim(ctx.principal.address, [e[0]], e[1]),
    ).to.be.revertedWith("InheritanceManager: not heir");
  });

  it("rejects finalize when there is no pending claim (startClaim wasn't called)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    const e = await encAmt(ctx.client, ctx.heir, usdc(100), await ctx.im.getAddress());
    await expect(
      ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [e[0]], e[1]),
    ).to.be.revertedWith("InheritanceManager: no pending claim");
  });

  it("rejects amounts.length != vaults.length", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);
    // Pass zero amounts but one vault → mismatch.
    await expect(
      ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [], "0x"),
    ).to.be.revertedWith("InheritanceManager: amounts/vaults length mismatch");
  });

  it("happy path: heir passes the EXACT balance and receives the principal's encrypted vault balance", async () => {
    // NOTE — the contract's transferFromVerified returns ZERO on over-
    // request (FHE.select with balance>=amount check, not a min-clamp).
    // The heir MUST encrypt the exact amount, not type(uint64).max.
    // Pinning this contract behaviour so a future docstring drift can't
    // mislead heirs into encrypting MAX and losing all funds (#185 mutex
    // blocks retry).
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);

    // Heir knows the balance is 500 USDC (e.g. via off-chain coordination
    // or by the principal having FHE.allow'd the heir on _balances).
    const e = await encAmt(ctx.client, ctx.heir, usdc(500), await ctx.im.getAddress());

    await ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [e[0]], e[1]);
    expect(await ctx.im.claimFinalized(ctx.principal.address)).to.equal(true);
    const plan = await ctx.im.getPlan(ctx.principal.address);
    expect(plan.active).to.equal(false);

    await mock_expectPlaintext(ctx.heir.provider, await ctx.vault.balanceOf(ctx.heir.address), usdc(500));
    await mock_expectPlaintext(ctx.principal.provider, await ctx.vault.balanceOf(ctx.principal.address), 0n);
  });

  it("FOOTGUN PIN: over-requesting (uint64.max) transfers ZERO, not the available balance", async () => {
    // This pins the actual contract behaviour and ensures the contract
    // never silently changes to a min-clamp under the heir's feet. If
    // someone "fixes" transferFromVerified to clamp instead of zero,
    // this test fails — forcing a coordinated update across all callers.
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await ctx.im.connect(ctx.principal).setVaults([await ctx.vault.getAddress()]);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.heir).startClaim(ctx.principal.address);
    await time.increase(CHALLENGE_PERIOD + 1);

    const max = (1n << 64n) - 1n;
    const e = await encAmt(ctx.client, ctx.heir, max, await ctx.im.getAddress());
    await ctx.im.connect(ctx.heir).finalizeClaim(ctx.principal.address, [e[0]], e[1]);

    // claimFinalized is set TRUE (the mutex burns), but the heir's
    // balance is ZERO because the vault returned 0 on over-request.
    // Funds are now permanently stuck — heir can't retry, principal's
    // claimFinalized blocks future claims until setHeir is called.
    expect(await ctx.im.claimFinalized(ctx.principal.address)).to.equal(true);
    await mock_expectPlaintext(ctx.heir.provider, await ctx.vault.balanceOf(ctx.heir.address), 0n);
    await mock_expectPlaintext(ctx.principal.provider, await ctx.vault.balanceOf(ctx.principal.address), usdc(500));
  });
});

describe("InheritanceManager — isClaimable view", () => {
  it("isClaimable returns false before the inactivity period elapses", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    expect(await ctx.im.isClaimable(ctx.principal.address)).to.equal(false);
  });

  it("isClaimable flips to true once inactivity elapses on an active plan", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await time.increase(MIN_INACTIVITY + 1);
    expect(await ctx.im.isClaimable(ctx.principal.address)).to.equal(true);
  });

  it("isClaimable returns false after removeHeir (no active plan)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.im.connect(ctx.principal).setHeir(ctx.heir.address, MIN_INACTIVITY);
    await time.increase(MIN_INACTIVITY + 1);
    await ctx.im.connect(ctx.principal).removeHeir();
    expect(await ctx.im.isClaimable(ctx.principal.address)).to.equal(false);
  });
});

// Helper — return the timestamp that hardhat will mine the NEXT block at.
async function timestamp1(): Promise<number> {
  return (await time.latest()) + 1;
}
