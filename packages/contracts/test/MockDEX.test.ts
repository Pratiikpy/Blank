import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  MockDEX — Fixed-rate testnet DEX used by PrivacyRouter's swap
//  settlement path. Real production swaps go through Uniswap; this
//  mock lets us test the full encrypted-swap flow without external
//  liquidity.
//
//  Critical because:
//   • PrivacyRouter holds reserves and uses MockDEX to settle the
//     plaintext leg of encrypted swaps. A bug in rate math or in
//     the deadline / minimum-output checks would either lock funds
//     or silently route wrong-amount transfers.
//   • The exchange rate is scaled by 1e6: amountOut = (amountIn *
//     rate) / 1e6. Off-by-decimal mistakes here are easy and
//     impossible to catch without a unit test.
//   • Anyone can `fund` but only `owner` can withdraw / set rates /
//     transferOwnership. Missing access gates would let attackers
//     drain the DEX or steer routing prices.
//
//  Covers:
//   • constructor sets owner=deployer
//   • setRate: owner-only, validates non-zero address, non-same
//     token, non-zero rate; emits RateSet
//   • setRateBidirectional: forward + reverse rates set in one call
//   • exactInputSingle: rate math (amountOut = amountIn * rate / 1e6),
//     deadline check, no-rate revert, slippage protection,
//     insufficient-liquidity revert, transfers tokens, emits Swapped
//   • fund: anyone can fund, emits Funded
//   • liquidity / quote: view functions return correct values
//   • transferOwnership: owner-only, rejects zero address
//   • withdraw: owner-only, rejects zero recipient
// ══════════════════════════════════════════════════════════════════

const ONE_E6 = 1_000_000n;

async function fixture() {
  const [owner, alice, bob] = await hre.ethers.getSigners();

  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const tokenIn = await TestUSDC.deploy();
  await tokenIn.waitForDeployment();
  const tokenOut = await TestUSDC.deploy();
  await tokenOut.waitForDeployment();

  const MockDEX = await hre.ethers.getContractFactory("MockDEX");
  const dex = await MockDEX.deploy();
  await dex.waitForDeployment();

  // Mint to alice (the swapper) and fund the DEX with tokenOut so it
  // can fulfill swaps.
  await tokenIn.mint(alice.address, 1_000_000n * ONE_E6);
  await tokenOut.mint(await dex.getAddress(), 1_000_000n * ONE_E6);

  return { owner, alice, bob, tokenIn, tokenOut, dex };
}

async function getDeadline(): Promise<number> {
  return (await time.latest()) + 3600;
}

describe("MockDEX — constructor", () => {
  it("sets owner=deployer", async () => {
    const { owner, dex } = await loadFixture(fixture);
    expect(await dex.owner()).to.equal(owner.address);
  });
});

describe("MockDEX — setRate", () => {
  it("sets the rate and emits RateSet", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(dex.setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 400))
      .to.emit(dex, "RateSet")
      .withArgs(await tokenIn.getAddress(), await tokenOut.getAddress(), 400);
    expect(
      await dex.exchangeRates(await tokenIn.getAddress(), await tokenOut.getAddress()),
    ).to.equal(400);
  });

  it("is owner-only (non-owner reverts)", async () => {
    const { alice, tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(alice).setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 400),
    ).to.be.revertedWith("MockDEX: not owner");
  });

  it("rejects zero tokenIn address", async () => {
    const { tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.setRate(hre.ethers.ZeroAddress, await tokenOut.getAddress(), 400),
    ).to.be.revertedWith("MockDEX: zero address");
  });

  it("rejects zero tokenOut address", async () => {
    const { tokenIn, dex } = await loadFixture(fixture);
    await expect(
      dex.setRate(await tokenIn.getAddress(), hre.ethers.ZeroAddress, 400),
    ).to.be.revertedWith("MockDEX: zero address");
  });

  it("rejects same-token swap (tokenIn == tokenOut)", async () => {
    const { tokenIn, dex } = await loadFixture(fixture);
    const addr = await tokenIn.getAddress();
    await expect(dex.setRate(addr, addr, 400)).to.be.revertedWith("MockDEX: same token");
  });

  it("rejects zero rate (would yield zero output for any input)", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 0),
    ).to.be.revertedWith("MockDEX: zero rate");
  });

  it("overwrites a prior rate (re-set is allowed)", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await dex.setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 400);
    await dex.setRate(await tokenIn.getAddress(), await tokenOut.getAddress(), 800);
    expect(
      await dex.exchangeRates(await tokenIn.getAddress(), await tokenOut.getAddress()),
    ).to.equal(800);
  });
});

describe("MockDEX — setRateBidirectional", () => {
  it("sets both forward and reverse rates in one call + emits two RateSet events", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    const tx = await dex.setRateBidirectional(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      500_000,
      2_000_000,
    );
    const receipt = await tx.wait();
    expect(receipt!.logs.length).to.equal(2);
    expect(
      await dex.exchangeRates(await tokenIn.getAddress(), await tokenOut.getAddress()),
    ).to.equal(500_000);
    expect(
      await dex.exchangeRates(await tokenOut.getAddress(), await tokenIn.getAddress()),
    ).to.equal(2_000_000);
  });

  it("is owner-only", async () => {
    const { alice, tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(alice).setRateBidirectional(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        500_000,
        2_000_000,
      ),
    ).to.be.revertedWith("MockDEX: not owner");
  });

  it("rejects zero forward rate", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.setRateBidirectional(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        0,
        2_000_000,
      ),
    ).to.be.revertedWith("MockDEX: zero rate");
  });

  it("rejects zero reverse rate", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.setRateBidirectional(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        500_000,
        0,
      ),
    ).to.be.revertedWith("MockDEX: zero rate");
  });
});

describe("MockDEX — exactInputSingle (the swap)", () => {
  async function setupSwap() {
    const ctx = await loadFixture(fixture);
    // 1 input -> 0.5 output (rate = 500_000)
    await ctx.dex.setRate(
      await ctx.tokenIn.getAddress(),
      await ctx.tokenOut.getAddress(),
      500_000,
    );
    return ctx;
  }

  it("computes amountOut = (amountIn * rate) / 1e6 and transfers correctly", async () => {
    const { alice, tokenIn, tokenOut, dex } = await setupSwap();
    const amountIn = 1000n * ONE_E6;
    const expectedOut = (amountIn * 500_000n) / ONE_E6; // 500 * 1e6
    const aliceOutBefore = await tokenOut.balanceOf(alice.address);
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    await dex.connect(alice).exactInputSingle({
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      fee: 3000,
      recipient: alice.address,
      deadline: await getDeadline(),
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    const aliceOutAfter = await tokenOut.balanceOf(alice.address);
    expect(aliceOutAfter - aliceOutBefore).to.equal(expectedOut);
  });

  it("emits Swapped with tokenIn + tokenOut + amounts + recipient", async () => {
    const { alice, tokenIn, tokenOut, dex } = await setupSwap();
    const amountIn = 1000n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    await expect(
      dex.connect(alice).exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        fee: 3000,
        recipient: alice.address,
        deadline: await getDeadline(),
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }),
    )
      .to.emit(dex, "Swapped")
      .withArgs(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        amountIn,
        500n * ONE_E6,
        alice.address,
      );
  });

  it("reverts when deadline is in the past", async () => {
    const { alice, tokenIn, tokenOut, dex } = await setupSwap();
    const amountIn = 1000n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    const pastDeadline = (await time.latest()) - 1;
    await expect(
      dex.connect(alice).exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        fee: 3000,
        recipient: alice.address,
        deadline: pastDeadline,
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }),
    ).to.be.revertedWith("MockDEX: deadline expired");
  });

  it("reverts when no rate is set for the pair", async () => {
    const { alice, tokenIn, tokenOut, dex } = await loadFixture(fixture);
    const amountIn = 1000n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    await expect(
      dex.connect(alice).exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        fee: 3000,
        recipient: alice.address,
        deadline: await getDeadline(),
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }),
    ).to.be.revertedWith("MockDEX: no rate set");
  });

  it("reverts when amountOut < amountOutMinimum (slippage protection)", async () => {
    const { alice, tokenIn, tokenOut, dex } = await setupSwap();
    const amountIn = 1000n * ONE_E6;
    // Expected out = 500 * 1e6. Demand 501 * 1e6 -> revert.
    const minTooHigh = 501n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    await expect(
      dex.connect(alice).exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        fee: 3000,
        recipient: alice.address,
        deadline: await getDeadline(),
        amountIn,
        amountOutMinimum: minTooHigh,
        sqrtPriceLimitX96: 0,
      }),
    ).to.be.revertedWith("MockDEX: insufficient output amount");
  });

  it("reverts when DEX has insufficient liquidity for the output", async () => {
    const { owner, alice, tokenIn, tokenOut, dex } = await loadFixture(fixture);
    // Withdraw all tokenOut from the DEX so liquidity is zero.
    const dexBal = await tokenOut.balanceOf(await dex.getAddress());
    await dex.connect(owner).withdraw(await tokenOut.getAddress(), dexBal, owner.address);
    await dex.setRate(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      500_000,
    );
    const amountIn = 1000n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    await expect(
      dex.connect(alice).exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        fee: 3000,
        recipient: alice.address,
        deadline: await getDeadline(),
        amountIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }),
    ).to.be.revertedWith("MockDEX: insufficient liquidity");
  });

  it("routes output to the recipient field, NOT msg.sender (PrivacyRouter use case)", async () => {
    const { alice, bob, tokenIn, tokenOut, dex } = await setupSwap();
    const amountIn = 1000n * ONE_E6;
    const bobOutBefore = await tokenOut.balanceOf(bob.address);
    const aliceOutBefore = await tokenOut.balanceOf(alice.address);
    await tokenIn.connect(alice).approve(await dex.getAddress(), amountIn);
    // Alice signs the swap; output goes to Bob (the recipient param).
    await dex.connect(alice).exactInputSingle({
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      fee: 3000,
      recipient: bob.address,
      deadline: await getDeadline(),
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    const bobOutAfter = await tokenOut.balanceOf(bob.address);
    const aliceOutAfter = await tokenOut.balanceOf(alice.address);
    expect(bobOutAfter - bobOutBefore).to.equal(500n * ONE_E6);
    expect(aliceOutAfter).to.equal(aliceOutBefore); // alice gets nothing
  });
});

describe("MockDEX — fund", () => {
  it("anyone can fund (no access control)", async () => {
    const { alice, tokenIn, dex } = await loadFixture(fixture);
    const amount = 100n * ONE_E6;
    await tokenIn.connect(alice).approve(await dex.getAddress(), amount);
    await expect(dex.connect(alice).fund(await tokenIn.getAddress(), amount))
      .to.emit(dex, "Funded")
      .withArgs(await tokenIn.getAddress(), amount, alice.address);
  });

  it("rejects zero amount (catches accidental no-op funds)", async () => {
    const { alice, tokenIn, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(alice).fund(await tokenIn.getAddress(), 0),
    ).to.be.revertedWith("MockDEX: zero amount");
  });
});

describe("MockDEX — view functions", () => {
  it("liquidity returns the DEX's balance of a token", async () => {
    const { tokenOut, dex } = await loadFixture(fixture);
    const expected = await tokenOut.balanceOf(await dex.getAddress());
    expect(await dex.liquidity(await tokenOut.getAddress())).to.equal(expected);
  });

  it("quote returns amountIn * rate / 1e6 when rate is set", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    await dex.setRate(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      500_000,
    );
    const out = await dex.quote(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      1000n * ONE_E6,
    );
    expect(out).to.equal(500n * ONE_E6);
  });

  it("quote returns 0 when no rate is set (caller checks before calling exactInputSingle)", async () => {
    const { tokenIn, tokenOut, dex } = await loadFixture(fixture);
    const out = await dex.quote(
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      1000n * ONE_E6,
    );
    expect(out).to.equal(0);
  });
});

describe("MockDEX — admin (transferOwnership + withdraw)", () => {
  it("transferOwnership moves ownership to newOwner", async () => {
    const { owner, alice, dex } = await loadFixture(fixture);
    await dex.connect(owner).transferOwnership(alice.address);
    expect(await dex.owner()).to.equal(alice.address);
  });

  it("transferOwnership is owner-only", async () => {
    const { alice, bob, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(alice).transferOwnership(bob.address),
    ).to.be.revertedWith("MockDEX: not owner");
  });

  it("transferOwnership rejects zero address (prevents accidental ownership loss)", async () => {
    const { owner, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(owner).transferOwnership(hre.ethers.ZeroAddress),
    ).to.be.revertedWith("MockDEX: zero address");
  });

  it("withdraw moves tokens from DEX to recipient (owner-only fund recovery)", async () => {
    const { owner, bob, tokenOut, dex } = await loadFixture(fixture);
    const amount = 100n * ONE_E6;
    const bobBefore = await tokenOut.balanceOf(bob.address);
    await dex.connect(owner).withdraw(await tokenOut.getAddress(), amount, bob.address);
    const bobAfter = await tokenOut.balanceOf(bob.address);
    expect(bobAfter - bobBefore).to.equal(amount);
  });

  it("withdraw is owner-only", async () => {
    const { alice, bob, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(alice).withdraw(await tokenOut.getAddress(), 100n * ONE_E6, bob.address),
    ).to.be.revertedWith("MockDEX: not owner");
  });

  it("withdraw rejects zero recipient address", async () => {
    const { owner, tokenOut, dex } = await loadFixture(fixture);
    await expect(
      dex.connect(owner).withdraw(
        await tokenOut.getAddress(),
        100n * ONE_E6,
        hre.ethers.ZeroAddress,
      ),
    ).to.be.revertedWith("MockDEX: zero address");
  });
});
