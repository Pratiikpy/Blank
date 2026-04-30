import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  BusinessHub.payInvoiceWithSwap — Phase 5.6 token-agnostic invoice
//
//  Covered:
//   • Same-token short-circuit (payToken == vault.underlyingToken)
//     deposits exactly expectedUsdcOut to vendor, no swap.
//   • Same-token mismatch (payAmountInMax != expectedUsdcOut) reverts.
//   • Swap path with mock router that consumes 95% — verifies the 5%
//     refund and the vendor gets the full expectedUsdcOut.
//   • Async finalize: the FHE match verification still gates Paid vs.
//     Disputed, so an honest payer who provided matching encAmount can
//     finalize to Paid; a payer who lied about the match flips to
//     Disputed (even though USDC was already sent — vendor is paid
//     plaintext but the invoice shows the dispute, signaling something
//     off-chain to follow up on).
//   • Pre-flight reverts: not-client, wrong status, zero args.
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const USDT_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);
const usdt = (n: number | string) => parseUnits(String(n), USDT_DECIMALS);

async function deployProxy(contractName: string, initArgs: unknown[] = []) {
  const Factory = await hre.ethers.getContractFactory(contractName);
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

async function fixture() {
  const [owner, vendor, payer] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);

  // Tokens
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const usdcToken = await TestUSDC.deploy();
  await usdcToken.waitForDeployment();
  // Reuse TestUSDC source for a second "USDT-like" token so the mock has
  // two ERC-20s to swap between.
  const usdtToken = await TestUSDC.deploy();
  await usdtToken.waitForDeployment();

  // Hubs + vault
  const eventHub = await deployProxy("EventHub");
  const vault = await deployProxy("FHERC20Vault", [
    await usdcToken.getAddress(),
    "Blank USDC Vault",
    "bvUSDC",
    USDC_DECIMALS,
    await eventHub.getAddress(),
  ]);
  const businessHub = await deployProxy("BusinessHub", [await eventHub.getAddress()]);
  await eventHub.batchWhitelist([await businessHub.getAddress()]);

  // Mock SwapRouter02
  const MockRouter = await hre.ethers.getContractFactory("MockSwapRouter02");
  const router = await MockRouter.deploy();
  await router.waitForDeployment();

  // Pre-fund the router with USDC so its swaps can deliver tokenOut.
  await usdcToken.mint(await router.getAddress(), usdc(10_000));

  // Pre-fund the payer with USDT (their pay-token).
  await usdtToken.mint(payer.address, usdt(1_000));
  // And pre-fund the payer with some USDC for same-token tests.
  await usdcToken.mint(payer.address, usdc(1_000));

  return {
    owner,
    vendor,
    payer,
    client,
    usdcToken,
    usdtToken,
    eventHub,
    vault,
    businessHub,
    router,
  };
}

async function encUint64(client: any, signer: any, amount: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(amount)]).execute();
  return enc;
}

async function createInvoice(
  ctx: Awaited<ReturnType<typeof fixture>>,
  amount: bigint,
): Promise<bigint> {
  const enc = await encUint64(ctx.client, ctx.vendor, amount);
  const tx = await ctx.businessHub
    .connect(ctx.vendor)
    .createInvoice(
      ctx.payer.address,
      await ctx.vault.getAddress(),
      enc,
      "Token-agnostic test invoice",
      Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    );
  await tx.wait();
  // Invoice ids start at 0 and increment.
  return 0n;
}

describe("BusinessHub.payInvoiceWithSwap — same-token short-circuit", () => {
  it("transfers exactly expectedUsdcOut to vendor, no swap, marks PaymentPending", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));

    await ctx.usdcToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), usdc(100));

    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));
    const vendorBefore: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);

    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        id,
        await ctx.usdcToken.getAddress(),
        usdc(100),
        usdc(100),
        3000,
        await ctx.router.getAddress(),
        encMatch,
      ),
    )
      .to.emit(ctx.businessHub, "InvoicePaymentSwapped")
      .and.to.emit(ctx.businessHub, "InvoicePaymentInitiated");

    const vendorAfter: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);
    expect(vendorAfter - vendorBefore).to.equal(usdc(100));

    const inv = await ctx.businessHub.getInvoice(id);
    expect(inv.status).to.equal(3); // PaymentPending
  });

  it("rejects same-token call where payAmountInMax != expectedUsdcOut", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    await ctx.usdcToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), usdc(150));
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));

    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        id,
        await ctx.usdcToken.getAddress(),
        usdc(150), // > expectedUsdcOut — same-token requires exact equality
        usdc(100),
        3000,
        await ctx.router.getAddress(),
        encMatch,
      ),
    ).to.be.revertedWith("BusinessHub: same-token requires payAmountInMax == expectedUsdcOut");
  });
});

describe("BusinessHub.payInvoiceWithSwap — swap path", () => {
  it("swaps payToken, refunds unused, vendor gets full expectedUsdcOut", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));

    // Mock router consumes 95% by default — payer should be refunded 5%.
    const payAmountInMax = usdt(110);
    const expectedConsumed = (payAmountInMax * 9500n) / 10000n; // 104.5 USDT
    const expectedRefund = payAmountInMax - expectedConsumed; // 5.5 USDT

    await ctx.usdtToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), payAmountInMax);
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));

    const vendorBefore: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);
    const payerUsdtBefore: bigint = await ctx.usdtToken.balanceOf(ctx.payer.address);

    await ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
      id,
      await ctx.usdtToken.getAddress(),
      payAmountInMax,
      usdc(100),
      3000,
      await ctx.router.getAddress(),
      encMatch,
    );

    const vendorAfter: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);
    const payerUsdtAfter: bigint = await ctx.usdtToken.balanceOf(ctx.payer.address);

    // Vendor receives the full expectedUsdcOut.
    expect(vendorAfter - vendorBefore).to.equal(usdc(100));
    // Payer's USDT balance went down by exactly the consumed amount
    // (refund returned the rest).
    expect(payerUsdtBefore - payerUsdtAfter).to.equal(expectedConsumed);

    // Status flipped to PaymentPending — caller still needs to finalize
    // via payInvoiceFinalize for the FHE match validation to land.
    const inv = await ctx.businessHub.getInvoice(id);
    expect(inv.status).to.equal(3); // PaymentPending
  });

  it("emits InvoicePaymentSwapped with correct payToken / amountIn / amountOut", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));

    await ctx.router.setConsumedFractionBps(8000); // 80%
    const payAmountInMax = usdt(125);
    const expectedConsumed = (payAmountInMax * 8000n) / 10000n;

    await ctx.usdtToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), payAmountInMax);
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));

    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        id,
        await ctx.usdtToken.getAddress(),
        payAmountInMax,
        usdc(100),
        3000,
        await ctx.router.getAddress(),
        encMatch,
      ),
    )
      .to.emit(ctx.businessHub, "InvoicePaymentSwapped")
      .withArgs(
        id,
        await ctx.usdtToken.getAddress(),
        expectedConsumed,
        usdc(100),
        anyTimestamp(),
      );
  });
});

describe("BusinessHub.payInvoiceWithSwap — pre-flight reverts", () => {
  it("rejects wrong client", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const [, , , otherSigner] = await hre.ethers.getSigners();
    const encMatch = await encUint64(ctx.client, otherSigner, usdc(100));
    await expect(
      ctx.businessHub.connect(otherSigner).payInvoiceWithSwap(
        id,
        await ctx.usdcToken.getAddress(),
        usdc(100),
        usdc(100),
        3000,
        await ctx.router.getAddress(),
        encMatch,
      ),
    ).to.be.revertedWith("BusinessHub: not the client");
  });

  it("rejects when invoice already cancelled", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    await ctx.businessHub.connect(ctx.vendor).cancelInvoice(id);
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        id,
        await ctx.usdcToken.getAddress(),
        usdc(100),
        usdc(100),
        3000,
        await ctx.router.getAddress(),
        encMatch,
      ),
    ).to.be.revertedWith("BusinessHub: not pending");
  });

  it("rejects zero payToken / swapRouter / amounts", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));
    const args = [
      id,
      await ctx.usdcToken.getAddress(),
      usdc(100),
      usdc(100),
      3000,
      await ctx.router.getAddress(),
      encMatch,
    ] as const;
    // zero payToken
    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        args[0],
        hre.ethers.ZeroAddress,
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
      ),
    ).to.be.revertedWith("BusinessHub: zero payToken");
    // zero swapRouter
    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        hre.ethers.ZeroAddress,
        args[6],
      ),
    ).to.be.revertedWith("BusinessHub: zero swapRouter");
    // zero amounts
    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        args[0],
        args[1],
        0n,
        args[3],
        args[4],
        args[5],
        args[6],
      ),
    ).to.be.revertedWith("BusinessHub: zero payAmountInMax");
    await expect(
      ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
        args[0],
        args[1],
        args[2],
        0n,
        args[4],
        args[5],
        args[6],
      ),
    ).to.be.revertedWith("BusinessHub: zero expectedUsdcOut");
  });
});

describe("BusinessHub.payInvoiceWithSwap — finalize integration", () => {
  it("matching encAmount finalizes to Paid; vendor already plaintext-paid", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    await ctx.usdcToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), usdc(100));
    const encMatch = await encUint64(ctx.client, ctx.payer, usdc(100));
    await ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
      id,
      await ctx.usdcToken.getAddress(),
      usdc(100),
      usdc(100),
      3000,
      await ctx.router.getAddress(),
      encMatch,
    );

    // Off-chain decrypt the validation handle, sign, finalize.
    const handle = await ctx.businessHub.getInvoiceValidationHandle(id);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.payer);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub
      .connect(ctx.payer)
      .payInvoiceFinalize(id, Boolean(proof.decryptedValue), proof.signature);

    const inv = await ctx.businessHub.getInvoice(id);
    expect(inv.status).to.equal(1); // Paid
  });

  it("mismatched encAmount finalizes to Disputed even though plaintext USDC moved", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    await ctx.usdcToken
      .connect(ctx.payer)
      .approve(await ctx.businessHub.getAddress(), usdc(100));
    // Payer LIES: encrypts a different value than the invoice amount.
    const encWrong = await encUint64(ctx.client, ctx.payer, usdc(50));
    await ctx.businessHub.connect(ctx.payer).payInvoiceWithSwap(
      id,
      await ctx.usdcToken.getAddress(),
      usdc(100),
      usdc(100),
      3000,
      await ctx.router.getAddress(),
      encWrong,
    );

    const handle = await ctx.businessHub.getInvoiceValidationHandle(id);
    await hre.cofhe.connectWithHardhatSigner(ctx.client, ctx.payer);
    const proof = await ctx.client.decryptForTx(handle, FheTypes.Bool).withoutPermit().execute();
    await ctx.businessHub
      .connect(ctx.payer)
      .payInvoiceFinalize(id, Boolean(proof.decryptedValue), proof.signature);

    const inv = await ctx.businessHub.getInvoice(id);
    // Status flipped to Disputed because the FHE match check failed.
    // Vendor still got the plaintext USDC (already transferred during the
    // payInvoiceWithSwap call), so the dispute is a soft signal — vendor
    // and client must reconcile off-chain.
    expect(inv.status).to.equal(4); // Disputed
  });
});

// recharts-style chai matcher for "any value" — chai doesn't ship one for
// withArgs predicates that ignore a single positional, so we wrap it.
function anyTimestamp(): (v: any) => boolean {
  return (v) => typeof v === "bigint" && v > 0n;
}
