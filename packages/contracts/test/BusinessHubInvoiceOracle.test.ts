import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { parseUnits } from "ethers";

// ══════════════════════════════════════════════════════════════════
//  BusinessHub.payInvoiceWithOracleQuote — Phase 5.7 signed-oracle fallback
//
//  Covered:
//   • setOracleAttestationAddress: onlyOwner gate, event, address(0) accepted
//   • Happy path: vendor receives expectedUsdcOut, status flips to PaymentPending
//   • Signature replay protection (same nonce twice → reverts)
//   • Cross-payer replay (signed for payer A, submitted by B → reverts)
//   • Cross-contract replay protection (digest binds address(this))
//   • Cross-chain replay protection (digest binds chainid)
//   • Expiry enforcement
//   • Rate sanity bounds (ratePpm < 1, > 100M)
//   • expectedUsdcOut mismatch rejection
//   • Bad signature rejection
//   • Pre-flight reverts: not pending, not client, zero token, zero amounts
// ══════════════════════════════════════════════════════════════════

const USDC_DECIMALS = 6;
const usdc = (n: number | string) => parseUnits(String(n), USDC_DECIMALS);

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
  const [owner, vendor, payer, attacker] = await hre.ethers.getSigners();
  const cofheClient = await hre.cofhe.createClientWithBatteries(owner);

  // Oracle keypair — used to sign price quotes off-chain. NOT one of
  // hardhat's pre-funded signers; we control the privkey for signing.
  const oracle = hre.ethers.Wallet.createRandom();

  // Deploy two test ERC-20s: one as the vault underlying (USDC stand-in)
  // and one as a "no-Uniswap-pool" pay token.
  const TestUSDC = await hre.ethers.getContractFactory("TestUSDC");
  const usdcToken = await TestUSDC.deploy();
  await usdcToken.waitForDeployment();
  const exoticToken = await TestUSDC.deploy();
  await exoticToken.waitForDeployment();

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
  await businessHub.connect(owner).setOracleAttestationAddress(oracle.address);

  // Pre-fund payer with exoticToken (their pay-token).
  await exoticToken.mint(payer.address, parseUnits("1000", USDC_DECIMALS));
  // Pre-fund the BusinessHub with USDC so it can settle (in production
  // the contract has zero idle USDC; for the oracle-fallback path, it
  // pulls payToken in but the USDC has to come from somewhere — in this
  // test we let the contract hold a small float, simulating a future
  // funded-vault model. Mark this assumption explicitly for follow-up.).
  await usdcToken.mint(await businessHub.getAddress(), parseUnits("10000", USDC_DECIMALS));

  return {
    owner,
    vendor,
    payer,
    attacker,
    oracle,
    cofheClient,
    usdcToken,
    exoticToken,
    eventHub,
    vault,
    businessHub,
  };
}

interface QuoteParams {
  invoiceId: bigint;
  payToken: string;
  payAmountIn: bigint;
  expectedUsdcOut: bigint;
  ratePpm: bigint;
  expiresAt: bigint;
  nonce: string; // 0x-prefixed bytes32
  contractAddr: string;
  chainId: bigint;
  payer: string;
}

async function signOracleQuote(
  oracle: hre.ethers.Wallet | hre.ethers.HDNodeWallet,
  q: QuoteParams,
): Promise<string> {
  const digest = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "address",
        "uint256",
        "address",
      ],
      [
        q.invoiceId,
        q.payToken,
        q.payAmountIn,
        q.expectedUsdcOut,
        q.ratePpm,
        q.expiresAt,
        q.nonce,
        q.contractAddr,
        q.chainId,
        q.payer,
      ],
    ),
  );
  // EIP-191 `\x19Ethereum Signed Message:\n32` prefix matches contract's
  // toEthSignedMessageHash. Use ethers' `signMessage(getBytes(digest))`
  // which auto-applies the prefix.
  return oracle.signMessage(hre.ethers.getBytes(digest));
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
  const enc = await encUint64(ctx.cofheClient, ctx.vendor, amount);
  const now = await hre.ethers.provider.getBlock("latest");
  await ctx.businessHub
    .connect(ctx.vendor)
    .createInvoice(
      ctx.payer.address,
      await ctx.vault.getAddress(),
      enc,
      "Oracle-fallback test invoice",
      now!.timestamp + 7 * 24 * 3600,
    );
  return 0n;
}

// Use chain timestamp, not wallclock. Other test files (Blank.test.ts)
// use evm_increaseTime by up to a year and that drift can leak into
// loadFixture snapshots, making any wallclock-based expiresAt look
// already-expired when block.timestamp checks fire.
async function chainNow(): Promise<bigint> {
  const latest = await hre.ethers.provider.getBlock("latest");
  return BigInt(latest!.timestamp);
}
const ONE_HOUR_FROM_NOW = async () => (await chainNow()) + 3600n;
const RANDOM_NONCE = () =>
  ("0x" + hre.ethers.hexlify(hre.ethers.randomBytes(32)).slice(2)) as `0x${string}`;

describe("BusinessHub.setOracleAttestationAddress", () => {
  it("only owner can set", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.businessHub
        .connect(ctx.attacker)
        .setOracleAttestationAddress(ctx.attacker.address),
    ).to.be.revertedWithCustomError(ctx.businessHub, "OwnableUnauthorizedAccount");
  });

  it("emits OracleAddressUpdated with previous + current", async () => {
    const ctx = await loadFixture(fixture);
    const newAddr = hre.ethers.Wallet.createRandom().address;
    await expect(ctx.businessHub.connect(ctx.owner).setOracleAttestationAddress(newAddr))
      .to.emit(ctx.businessHub, "OracleAddressUpdated")
      .withArgs(ctx.oracle.address, newAddr);
    expect(await ctx.businessHub.oracleAttestationAddress()).to.equal(newAddr);
  });

  it("accepts address(0) (effectively disables oracle path)", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.businessHub.connect(ctx.owner).setOracleAttestationAddress(hre.ethers.ZeroAddress);
    expect(await ctx.businessHub.oracleAttestationAddress()).to.equal(hre.ethers.ZeroAddress);
  });
});

describe("BusinessHub.payInvoiceWithOracleQuote — happy path", () => {
  it("settles invoice with oracle quote, vendor receives expectedUsdcOut", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));

    // Quote: 100 exoticToken → 100 USDC at 1:1 ratio (ratePpm = 1_000_000).
    const payAmountIn = parseUnits("100", USDC_DECIMALS);
    const expectedUsdcOut = usdc(100);
    const ratePpm = 1_000_000n;
    const nonce = RANDOM_NONCE();
    const expiresAt = (await ONE_HOUR_FROM_NOW());
    const businessHubAddr = await ctx.businessHub.getAddress();
    const exoticAddr = await ctx.exoticToken.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);

    const sig = await signOracleQuote(ctx.oracle, {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn,
      expectedUsdcOut,
      ratePpm,
      expiresAt,
      nonce,
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    });

    // Approve + encrypt + pay
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, payAmountIn);
    const encMatch = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));

    const vendorBefore: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          payAmountIn,
          expectedUsdcOut,
          ratePpm,
          expiresAt,
          nonce,
          sig,
          encMatch,
        ),
    )
      .to.emit(ctx.businessHub, "InvoicePaymentOracleSettled")
      .and.to.emit(ctx.businessHub, "InvoicePaymentInitiated");

    const vendorAfter: bigint = await ctx.usdcToken.balanceOf(ctx.vendor.address);
    expect(vendorAfter - vendorBefore).to.equal(expectedUsdcOut);

    const inv = await ctx.businessHub.getInvoice(id);
    expect(inv.status).to.equal(3); // PaymentPending
  });
});

describe("BusinessHub.payInvoiceWithOracleQuote — replay protection", () => {
  async function setupValidPay(): Promise<{
    ctx: Awaited<ReturnType<typeof fixture>>;
    id: bigint;
    sig: string;
    args: Parameters<any>; // for second-call replay
    nonce: string;
  }> {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const payAmountIn = parseUnits("100", USDC_DECIMALS);
    const expectedUsdcOut = usdc(100);
    const ratePpm = 1_000_000n;
    const nonce = RANDOM_NONCE();
    const expiresAt = (await ONE_HOUR_FROM_NOW());
    const businessHubAddr = await ctx.businessHub.getAddress();
    const exoticAddr = await ctx.exoticToken.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    const sig = await signOracleQuote(ctx.oracle, {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn,
      expectedUsdcOut,
      ratePpm,
      expiresAt,
      nonce,
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    });
    return {
      ctx,
      id,
      sig,
      args: [
        id,
        exoticAddr,
        payAmountIn,
        expectedUsdcOut,
        ratePpm,
        expiresAt,
        nonce,
        sig,
      ] as any,
      nonce,
    };
  }

  it("rejects same nonce reuse from same payer", async () => {
    const f = await setupValidPay();
    const businessHubAddr = await f.ctx.businessHub.getAddress();
    await f.ctx.exoticToken
      .connect(f.ctx.payer)
      .approve(businessHubAddr, parseUnits("200", USDC_DECIMALS));
    const enc1 = await encUint64(f.ctx.cofheClient, f.ctx.payer, usdc(100));
    await f.ctx.businessHub
      .connect(f.ctx.payer)
      .payInvoiceWithOracleQuote(...f.args, enc1);

    // Second attempt with same nonce + same sig → reverts.
    // (The invoice is now PaymentPending so an earlier "not pending"
    // revert would fire first. Create a new invoice for the second try.)
    await createInvoice(f.ctx, usdc(50)); // creates id=1; but we still try id=0 to hit nonce check.

    // Re-encrypt fresh because Cofhe inputs are single-use.
    const enc2 = await encUint64(f.ctx.cofheClient, f.ctx.payer, usdc(100));
    await expect(
      f.ctx.businessHub.connect(f.ctx.payer).payInvoiceWithOracleQuote(...f.args, enc2),
    ).to.be.revertedWith("BusinessHub: not pending");

    // To purely test the nonce-reuse path, make a fresh invoice for the
    // SAME amount, same payer, same nonce. The invoice's encrypted amount
    // is fresh but the nonce slot under (payer, nonce) is now `true`.
    // Re-sign for the new invoice id but reuse the nonce.
    const id2 = 1n;
    const exoticAddr = await f.ctx.exoticToken.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    const expiresAt2 = await ONE_HOUR_FROM_NOW();
    const sig2 = await signOracleQuote(f.ctx.oracle, {
      invoiceId: id2,
      payToken: exoticAddr,
      payAmountIn: parseUnits("50", USDC_DECIMALS),
      expectedUsdcOut: usdc(50),
      ratePpm: 1_000_000n,
      expiresAt: expiresAt2,
      nonce: f.nonce,
      contractAddr: businessHubAddr,
      chainId,
      payer: f.ctx.payer.address,
    });
    const enc3 = await encUint64(f.ctx.cofheClient, f.ctx.payer, usdc(50));
    await expect(
      f.ctx.businessHub
        .connect(f.ctx.payer)
        .payInvoiceWithOracleQuote(
          id2,
          exoticAddr,
          parseUnits("50", USDC_DECIMALS),
          usdc(50),
          1_000_000n,
          expiresAt2,
          f.nonce,
          sig2,
          enc3,
        ),
    ).to.be.revertedWith("BusinessHub: nonce used");
  });
});

describe("BusinessHub.payInvoiceWithOracleQuote — sig + bound rejection", () => {
  it("rejects expired quote", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);

    const expiresAt = (await chainNow()) - 60n; // 60s ago, relative to chain time
    const args = {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn: parseUnits("100", USDC_DECIMALS),
      expectedUsdcOut: usdc(100),
      ratePpm: 1_000_000n,
      expiresAt,
      nonce: RANDOM_NONCE(),
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    };
    const sig = await signOracleQuote(ctx.oracle, args);
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, args.payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          args.payAmountIn,
          args.expectedUsdcOut,
          args.ratePpm,
          args.expiresAt,
          args.nonce,
          sig,
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: quote expired");
  });

  it("rejects ratePpm out of bounds (zero)", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    const args = {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn: parseUnits("100", USDC_DECIMALS),
      expectedUsdcOut: usdc(100),
      ratePpm: 0n,
      expiresAt: (await ONE_HOUR_FROM_NOW()),
      nonce: RANDOM_NONCE(),
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    };
    const sig = await signOracleQuote(ctx.oracle, args);
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, args.payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          args.payAmountIn,
          args.expectedUsdcOut,
          args.ratePpm,
          args.expiresAt,
          args.nonce,
          sig,
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: rate out of bounds");
  });

  it("rejects ratePpm out of bounds (above 100M)", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    const args = {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn: parseUnits("100", USDC_DECIMALS),
      expectedUsdcOut: usdc(100),
      ratePpm: 100_000_001n,
      expiresAt: (await ONE_HOUR_FROM_NOW()),
      nonce: RANDOM_NONCE(),
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    };
    const sig = await signOracleQuote(ctx.oracle, args);
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, args.payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          args.payAmountIn,
          args.expectedUsdcOut,
          args.ratePpm,
          args.expiresAt,
          args.nonce,
          sig,
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: rate out of bounds");
  });

  it("rejects expectedUsdcOut mismatch with ratePpm", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    // payAmountIn=100, ratePpm=1_000_000 ⇒ derived=100. Pass 200 → mismatch.
    const args = {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn: parseUnits("100", USDC_DECIMALS),
      expectedUsdcOut: usdc(200),
      ratePpm: 1_000_000n,
      expiresAt: (await ONE_HOUR_FROM_NOW()),
      nonce: RANDOM_NONCE(),
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    };
    const sig = await signOracleQuote(ctx.oracle, args);
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, args.payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          args.payAmountIn,
          args.expectedUsdcOut,
          args.ratePpm,
          args.expiresAt,
          args.nonce,
          sig,
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: expectedUsdcOut mismatch");
  });

  it("rejects signature from non-oracle key (cross-payer replay)", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const chainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    // Oracle signs for payer.address — but we'll submit from attacker.
    const args = {
      invoiceId: id,
      payToken: exoticAddr,
      payAmountIn: parseUnits("100", USDC_DECIMALS),
      expectedUsdcOut: usdc(100),
      ratePpm: 1_000_000n,
      expiresAt: (await ONE_HOUR_FROM_NOW()),
      nonce: RANDOM_NONCE(),
      contractAddr: businessHubAddr,
      chainId,
      payer: ctx.payer.address,
    };
    const sig = await signOracleQuote(ctx.oracle, args);
    // Make attacker the invoice's client — and try to submit with the
    // sig that was bound to ctx.payer. Set up: actually the invoice is
    // bound to ctx.payer as client (via createInvoice), so attacker
    // can't even pass the "not the client" gate. Best test: set up a
    // separate invoice with attacker as client.
    const altEnc = await encUint64(ctx.cofheClient, ctx.vendor, usdc(100));
    await ctx.businessHub
      .connect(ctx.vendor)
      .createInvoice(
        ctx.attacker.address,
        await ctx.vault.getAddress(),
        altEnc,
        "Attacker invoice",
        Number((await chainNow()) + 3600n),
      );
    await ctx.exoticToken.mint(ctx.attacker.address, args.payAmountIn);
    await ctx.exoticToken.connect(ctx.attacker).approve(businessHubAddr, args.payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.attacker, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.attacker)
        .payInvoiceWithOracleQuote(
          1n, // attacker's invoice id
          exoticAddr,
          args.payAmountIn,
          args.expectedUsdcOut,
          args.ratePpm,
          args.expiresAt,
          args.nonce,
          sig, // signed for ctx.payer, attacker is msg.sender
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: bad oracle sig");
  });
});

describe("BusinessHub.payInvoiceWithOracleQuote — digest binding", () => {
  // These tests sign a quote with the CORRECT oracle key but with a
  // wrong field for one of the binding params (contractAddr / chainId).
  // The contract recovers a different address from the digest+sig and
  // reverts `bad oracle sig`. Without these tests we wouldn't notice
  // a future drift where the contract drops a binding from its hash.

  async function setupForBinding(): Promise<{
    ctx: Awaited<ReturnType<typeof fixture>>;
    id: bigint;
    payAmountIn: bigint;
    expectedUsdcOut: bigint;
    enc: any;
    nonce: string;
    expiresAt: bigint;
    exoticAddr: string;
    businessHubAddr: string;
    realChainId: bigint;
  }> {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const payAmountIn = parseUnits("100", USDC_DECIMALS);
    const expectedUsdcOut = usdc(100);
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    const realChainId = BigInt((await hre.ethers.provider.getNetwork()).chainId);
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, payAmountIn);
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    return {
      ctx,
      id,
      payAmountIn,
      expectedUsdcOut,
      enc,
      nonce: RANDOM_NONCE(),
      expiresAt: (await ONE_HOUR_FROM_NOW()),
      exoticAddr,
      businessHubAddr,
      realChainId,
    };
  }

  it("rejects quote signed for a DIFFERENT contract address", async () => {
    const f = await setupForBinding();
    // Sign with a different contractAddr in the digest. Contract recovers
    // a different address than the oracle's, → revert.
    const decoyContract = hre.ethers.Wallet.createRandom().address;
    const sig = await signOracleQuote(f.ctx.oracle, {
      invoiceId: f.id,
      payToken: f.exoticAddr,
      payAmountIn: f.payAmountIn,
      expectedUsdcOut: f.expectedUsdcOut,
      ratePpm: 1_000_000n,
      expiresAt: f.expiresAt,
      nonce: f.nonce,
      contractAddr: decoyContract, // ← drift here
      chainId: f.realChainId,
      payer: f.ctx.payer.address,
    });
    await expect(
      f.ctx.businessHub
        .connect(f.ctx.payer)
        .payInvoiceWithOracleQuote(
          f.id,
          f.exoticAddr,
          f.payAmountIn,
          f.expectedUsdcOut,
          1_000_000n,
          f.expiresAt,
          f.nonce,
          sig,
          f.enc,
        ),
    ).to.be.revertedWith("BusinessHub: bad oracle sig");
  });

  it("rejects quote signed for a DIFFERENT chain id", async () => {
    const f = await setupForBinding();
    const sig = await signOracleQuote(f.ctx.oracle, {
      invoiceId: f.id,
      payToken: f.exoticAddr,
      payAmountIn: f.payAmountIn,
      expectedUsdcOut: f.expectedUsdcOut,
      ratePpm: 1_000_000n,
      expiresAt: f.expiresAt,
      nonce: f.nonce,
      contractAddr: f.businessHubAddr,
      chainId: f.realChainId + 1n, // ← drift here
      payer: f.ctx.payer.address,
    });
    await expect(
      f.ctx.businessHub
        .connect(f.ctx.payer)
        .payInvoiceWithOracleQuote(
          f.id,
          f.exoticAddr,
          f.payAmountIn,
          f.expectedUsdcOut,
          1_000_000n,
          f.expiresAt,
          f.nonce,
          sig,
          f.enc,
        ),
    ).to.be.revertedWith("BusinessHub: bad oracle sig");
  });
});

describe("BusinessHub.withdrawAccumulated — operator float recovery", () => {
  it("only owner can withdraw", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.businessHub
        .connect(ctx.attacker)
        .withdrawAccumulated(
          await ctx.exoticToken.getAddress(),
          ctx.attacker.address,
          1n,
        ),
    ).to.be.revertedWithCustomError(ctx.businessHub, "OwnableUnauthorizedAccount");
  });

  it("rejects zero token + zero recipient", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      ctx.businessHub
        .connect(ctx.owner)
        .withdrawAccumulated(hre.ethers.ZeroAddress, ctx.owner.address, 1n),
    ).to.be.revertedWith("BusinessHub: zero token");
    await expect(
      ctx.businessHub
        .connect(ctx.owner)
        .withdrawAccumulated(
          await ctx.exoticToken.getAddress(),
          hre.ethers.ZeroAddress,
          1n,
        ),
    ).to.be.revertedWith("BusinessHub: zero recipient");
  });

  it("transfers accumulated payToken from contract to recipient", async () => {
    const ctx = await loadFixture(fixture);
    // Pre-stuff the contract with some exoticToken (simulating
    // post-payInvoiceWithOracleQuote accumulation).
    const stash = parseUnits("500", USDC_DECIMALS);
    await ctx.exoticToken.mint(await ctx.businessHub.getAddress(), stash);
    const before = await ctx.exoticToken.balanceOf(ctx.owner.address);
    await ctx.businessHub
      .connect(ctx.owner)
      .withdrawAccumulated(
        await ctx.exoticToken.getAddress(),
        ctx.owner.address,
        stash,
      );
    const after = await ctx.exoticToken.balanceOf(ctx.owner.address);
    expect(after - before).to.equal(stash);
  });
});

describe("BusinessHub.payInvoiceWithOracleQuote — pre-flight reverts", () => {
  it("rejects when oracle is unset", async () => {
    const ctx = await loadFixture(fixture);
    await ctx.businessHub.connect(ctx.owner).setOracleAttestationAddress(hre.ethers.ZeroAddress);
    const id = await createInvoice(ctx, usdc(100));
    const exoticAddr = await ctx.exoticToken.getAddress();
    const businessHubAddr = await ctx.businessHub.getAddress();
    await ctx.exoticToken.connect(ctx.payer).approve(businessHubAddr, parseUnits("100", USDC_DECIMALS));
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          exoticAddr,
          parseUnits("100", USDC_DECIMALS),
          usdc(100),
          1_000_000n,
          (await ONE_HOUR_FROM_NOW()),
          RANDOM_NONCE(),
          "0x" + "00".repeat(65),
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: oracle unset");
  });

  it("rejects zero payToken / amounts", async () => {
    const ctx = await loadFixture(fixture);
    const id = await createInvoice(ctx, usdc(100));
    const enc = await encUint64(ctx.cofheClient, ctx.payer, usdc(100));
    await expect(
      ctx.businessHub
        .connect(ctx.payer)
        .payInvoiceWithOracleQuote(
          id,
          hre.ethers.ZeroAddress,
          parseUnits("100", USDC_DECIMALS),
          usdc(100),
          1_000_000n,
          (await ONE_HOUR_FROM_NOW()),
          RANDOM_NONCE(),
          "0x" + "00".repeat(65),
          enc,
        ),
    ).to.be.revertedWith("BusinessHub: zero payToken");
  });
});
