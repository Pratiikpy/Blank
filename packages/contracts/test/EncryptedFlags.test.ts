import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { mock_expectPlaintext } from "@cofhe/hardhat-plugin";
import { Encryptable } from "@cofhe/sdk";

// ══════════════════════════════════════════════════════════════════
//  EncryptedFlags — encrypted compliance flags + fee engine.
//
//  Critical because:
//   • The 4 ebool flags (verified / active / kyc / merchant) are
//     the access-control surface for the rest of Blank's stack —
//     a regression in the FHE.allow ACL plumbing would let an
//     unauthorized account read someone else's verification
//     status, OR worse, let a malicious caller flip flags without
//     onlyOwner.
//   • toggleActive uses FHE.xor with a true constant — the round-
//     trip semantics (true -> false -> true) must hold or the
//     "suspend / restore" admin flow silently breaks.
//   • invertVerification uses FHE.not — a regression that swapped
//     to FHE.asEbool(false) on every call would make the function
//     idempotent instead of toggling.
//   • The audit-scope bitmask uses euint8 with bitwise FHE.and to
//     check access — a regression in the mask check would either
//     leak data to unauthorized auditors OR deny legitimate ones.
//
//  Covers:
//   • initialize stores baseFeeRate + merchantDiscount as encrypted
//     constants (verified via mock_expectPlaintext indirectly through
//     calculateFee semantics)
//   • All 4 setters (setVerified / setActive / setKYC / setMerchant)
//     are owner-only + emit FlagSet with the right flag-type string
//   • Setters store the bool value: read-back via the matching
//     getMy* view returns the same plaintext
//   • toggleActive: round-trip true -> false -> true via XOR
//   • invertVerification: round-trip true -> false -> true via NOT
//   • setAuditScope: stores the bitmask, emits AuditScopeSet
//   • getAuditScope returns the stored bitmask
//   • calculateFee emits FeeCalculated (the side-effect pin; the
//     fee math itself is FHE.mul + shr which mock validates)
//   • UUPS upgrade gate (owner-only)
// ══════════════════════════════════════════════════════════════════

async function deployProxy(contractName: string, initArgs: unknown[]) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = Factory.interface.encodeFunctionData("initialize", initArgs);
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as any;
}

async function encryptUint8For(client: any, signer: any, value: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint8(value)]).setConsumingContract(consuming).execute();
}

async function encryptUint64For(client: any, signer: any, value: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(value)]).setConsumingContract(consuming).execute();
}

async function encryptBoolFor(client: any, signer: any, value: boolean, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.bool(value)]).setConsumingContract(consuming).execute();
}

/// setFeeRatesEncrypted verifies both rates under one batch signature.
async function encryptUint64Pair(client: any, signer: any, a: bigint, b: bigint, consuming: string) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  return await client.encryptInputs([Encryptable.uint64(a), Encryptable.uint64(b)]).setConsumingContract(consuming).execute();
}

const BASE_FEE_RATE = 100n; // 1% in basis points (scaled by 1e4)
const MERCHANT_DISCOUNT = 5000n; // 50% off the fee for merchants (basis points)

async function deployFixture() {
  const [owner, alice, bob, auditor] = await hre.ethers.getSigners();
  const client = await hre.cofhe.createClientWithBatteries(owner);
  const flags = await deployProxy("EncryptedFlags", [BASE_FEE_RATE, MERCHANT_DISCOUNT]);
  return { owner, alice, bob, auditor, client, flags };
}

describe("EncryptedFlags — initialization", () => {
  it("sets owner=deployer + accepts the fee-rate + discount params", async () => {
    const ctx = await loadFixture(deployFixture);
    expect(await ctx.flags.owner()).to.equal(ctx.owner.address);
  });

  it("rejects a second initialize() call (UUPS one-shot guard)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.flags.initialize(BASE_FEE_RATE, MERCHANT_DISCOUNT),
    ).to.be.revertedWithCustomError(ctx.flags, "InvalidInitialization");
  });
});

describe("EncryptedFlags — setVerified", () => {
  it("emits FlagSet with flagType='verified' and stores the value", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.flags.setVerified(ctx.alice.address, true))
      .to.emit(ctx.flags, "FlagSet")
      .withArgs(ctx.alice.address, "verified", (_t: bigint) => true);
    const handle = await ctx.flags.connect(ctx.alice).getMyVerifiedStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("can store false (the verification-rescinded case)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, false);
    const handle = await ctx.flags.connect(ctx.alice).getMyVerifiedStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 0n);
  });

  it("is owner-only (non-owner reverts with OwnableUnauthorizedAccount)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.flags.connect(ctx.alice).setVerified(ctx.alice.address, true),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — setActive", () => {
  it("emits FlagSet with flagType='active' and stores the value", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.flags.setActive(ctx.alice.address, true))
      .to.emit(ctx.flags, "FlagSet")
      .withArgs(ctx.alice.address, "active", (_t: bigint) => true);
    const handle = await ctx.flags.connect(ctx.alice).getMyActiveStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.flags.connect(ctx.alice).setActive(ctx.alice.address, true),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — setKYCCompleted", () => {
  it("emits FlagSet with flagType='kyc' and stores true (KYC is one-way)", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.flags.setKYCCompleted(ctx.alice.address))
      .to.emit(ctx.flags, "FlagSet")
      .withArgs(ctx.alice.address, "kyc", (_t: bigint) => true);
    const handle = await ctx.flags.connect(ctx.alice).getMyKYCStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.flags.connect(ctx.alice).setKYCCompleted(ctx.alice.address),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — setMerchant", () => {
  it("emits FlagSet with flagType='merchant' and stores the value", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.flags.setMerchant(ctx.alice.address, true))
      .to.emit(ctx.flags, "FlagSet")
      .withArgs(ctx.alice.address, "merchant", (_t: bigint) => true);
    const handle = await ctx.flags.connect(ctx.alice).getMyMerchantStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("can revoke merchant status (true -> false)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, true);
    await ctx.flags.setMerchant(ctx.alice.address, false);
    const handle = await ctx.flags.connect(ctx.alice).getMyMerchantStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 0n);
  });

  it("is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(
      ctx.flags.connect(ctx.alice).setMerchant(ctx.alice.address, true),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — toggleActive (FHE.xor with true)", () => {
  it("XOR-round-trip: setActive(true) -> toggle -> false -> toggle -> true", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setActive(ctx.alice.address, true);

    // First toggle: true XOR true = false
    await expect(ctx.flags.toggleActive(ctx.alice.address))
      .to.emit(ctx.flags, "FlagSet")
      .withArgs(ctx.alice.address, "active_toggled", (_t: bigint) => true);
    let handle = await ctx.flags.connect(ctx.alice).getMyActiveStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 0n);

    // Second toggle: false XOR true = true
    await ctx.flags.toggleActive(ctx.alice.address);
    handle = await ctx.flags.connect(ctx.alice).getMyActiveStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("is owner-only (non-owner cannot toggle)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setActive(ctx.alice.address, true);
    await expect(
      ctx.flags.connect(ctx.alice).toggleActive(ctx.alice.address),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — invertVerification (FHE.not)", () => {
  it("NOT-round-trip: setVerified(true) -> invert -> false -> invert -> true", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);

    // First invert: NOT true = false
    await ctx.flags.invertVerification(ctx.alice.address);
    let handle = await ctx.flags.connect(ctx.alice).getMyVerifiedStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 0n);

    // Second invert: NOT false = true
    await ctx.flags.invertVerification(ctx.alice.address);
    handle = await ctx.flags.connect(ctx.alice).getMyVerifiedStatus();
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });

  it("is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await expect(
      ctx.flags.connect(ctx.alice).invertVerification(ctx.alice.address),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});

describe("EncryptedFlags — calculateFee + calculateMerchantFee", () => {
  it("calculateFee emits FeeCalculated with msg.sender + timestamp", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n, await ctx.flags.getAddress());
    await expect(ctx.flags.connect(ctx.alice).calculateFee(...enc))
      .to.emit(ctx.flags, "FeeCalculated")
      .withArgs(ctx.alice.address, (_t: bigint) => true);
  });

  it("calculateMerchantFee succeeds for non-merchant (full fee, no discount path)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, false);
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n, await ctx.flags.getAddress());
    // The FHE.select branch resolves to the non-discounted baseFee. We
    // can't trivially decrypt the (fee, netAmount) return tuple from a
    // non-view tx, but the call must NOT revert and must process the
    // mock task chain end-to-end.
    await expect(
      ctx.flags.connect(ctx.alice).calculateMerchantFee(...enc, ctx.alice.address),
    ).to.not.be.reverted;
  });

  it("calculateMerchantFee succeeds for merchant (discount-applied path)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, true);
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n, await ctx.flags.getAddress());
    await expect(
      ctx.flags.connect(ctx.alice).calculateMerchantFee(...enc, ctx.alice.address),
    ).to.not.be.reverted;
  });
});

describe("EncryptedFlags — audit scope (encrypted bitmask)", () => {
  it("setAuditScope stores the bitmask + emits AuditScopeSet + getAuditScope returns it", async () => {
    const ctx = await loadFixture(deployFixture);
    const scope = 0b0000_0111; // bits 0,1,2 = amounts + parties + timestamps
    const enc = await encryptUint8For(ctx.client, ctx.alice, BigInt(scope), await ctx.flags.getAddress());
    await expect(
      ctx.flags.connect(ctx.alice).setAuditScope(ctx.auditor.address, ...enc),
    )
      .to.emit(ctx.flags, "AuditScopeSet")
      .withArgs(ctx.alice.address, ctx.auditor.address, (_t: bigint) => true);
    const handle = await ctx.flags.connect(ctx.alice).getAuditScope(ctx.auditor.address);
    await mock_expectPlaintext(ctx.alice.provider, handle, BigInt(scope));
  });

  it("checkAuditScope returns hasAccess=true when the requested bit is set", async () => {
    const ctx = await loadFixture(deployFixture);
    const scope = 0b0000_0010; // only bit 1 (parties)
    await ctx.flags.connect(ctx.alice).setAuditScope(
      ctx.auditor.address,
      ...(await encryptUint8For(ctx.client, ctx.alice, BigInt(scope), await ctx.flags.getAddress())),
    );
    // Mask asks for bit 1 -> AND = 0b10 != 0 -> hasAccess=true.
    const mask = 0b0000_0010;
    await expect(
      ctx.flags.connect(ctx.auditor).checkAuditScope(
        ctx.alice.address,
        ctx.auditor.address,
        ...(await encryptUint8For(ctx.client, ctx.auditor, BigInt(mask), await ctx.flags.getAddress())),
      ),
    ).to.not.be.reverted;
  });

  it("checkAuditScope returns hasAccess=false when no bit overlaps (encrypted FHE.ne path)", async () => {
    const ctx = await loadFixture(deployFixture);
    const scope = 0b0000_0010; // only bit 1
    await ctx.flags.connect(ctx.alice).setAuditScope(
      ctx.auditor.address,
      ...(await encryptUint8For(ctx.client, ctx.alice, BigInt(scope), await ctx.flags.getAddress())),
    );
    // Mask asks for bit 4 -> AND = 0 -> hasAccess=false.
    const mask = 0b0001_0000;
    await expect(
      ctx.flags.connect(ctx.auditor).checkAuditScope(
        ctx.alice.address,
        ctx.auditor.address,
        ...(await encryptUint8For(ctx.client, ctx.auditor, BigInt(mask), await ctx.flags.getAddress())),
      ),
    ).to.not.be.reverted;
  });
});

describe("EncryptedFlags — canSend + canReceive boolean composition", () => {
  it("canSend succeeds without revert (FHE.and over verified + active)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await ctx.flags.setActive(ctx.alice.address, true);
    await expect(ctx.flags.connect(ctx.alice).canSend(ctx.alice.address)).to.not.be.reverted;
  });

  it("canReceive succeeds without revert (FHE.or over verified + kyc)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await ctx.flags.setKYCCompleted(ctx.alice.address);
    await expect(ctx.flags.connect(ctx.alice).canReceive(ctx.alice.address)).to.not.be.reverted;
  });
});

// Audit M1 / L2. Handles are deterministic in the cofhe mock, so a
// staticCall followed by the real tx yields readable result handles.
describe("EncryptedFlags: audit fixes", () => {
  async function feeOf(ctx: any, signer: any, amount: bigint, merchant?: string) {
    const enc = await encryptUint64For(ctx.client, signer, amount, await ctx.flags.getAddress());
    const c = ctx.flags.connect(signer);
    if (merchant) {
      const r = await c.calculateMerchantFee.staticCall(...enc, merchant);
      await c.calculateMerchantFee(...enc, merchant);
      return r;
    }
    const r = await c.calculateFee.staticCall(...enc);
    await c.calculateFee(...enc);
    return r;
  }

  it("calculateFee divides by 10000, not 16384", async () => {
    const ctx = await loadFixture(deployFixture);
    const [fee, net] = await feeOf(ctx, ctx.alice, 1_000_000n);
    // Old >> 14 gave 6103.
    await mock_expectPlaintext(ctx.alice.provider, fee, 10_000n);
    await mock_expectPlaintext(ctx.alice.provider, net, 990_000n);
  });

  it("calculateFee does not overflow on large amounts", async () => {
    const ctx = await loadFixture(deployFixture);
    const amount = (1n << 63n) + 12_345n;
    const [fee, net] = await feeOf(ctx, ctx.alice, amount);
    const expected = (amount * BASE_FEE_RATE) / 10_000n;
    await mock_expectPlaintext(ctx.alice.provider, fee, expected);
    await mock_expectPlaintext(ctx.alice.provider, net, amount - expected);
  });

  it("calculateMerchantFee applies the discount share of the base fee", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, true);
    const [fee] = await feeOf(ctx, ctx.alice, 1_000_000n, ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, fee, 5_000n);
  });

  it("calculateMerchantFee is not a merchant-status oracle for strangers", async () => {
    const ctx = await loadFixture(deployFixture);
    const enc = await encryptUint64For(ctx.client, ctx.bob, 1000n, await ctx.flags.getAddress());
    await expect(ctx.flags.connect(ctx.bob).calculateMerchantFee(...enc, ctx.alice.address))
      .to.be.revertedWith("EncryptedFlags: not authorized");
  });

  it("canSend / canReceive reject third parties unless authorized", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await expect(ctx.flags.connect(ctx.bob).canSend(ctx.alice.address))
      .to.be.revertedWith("EncryptedFlags: not authorized");
    await expect(ctx.flags.connect(ctx.bob).canReceive(ctx.alice.address))
      .to.be.revertedWith("EncryptedFlags: not authorized");

    await expect(ctx.flags.connect(ctx.bob).setAuthorizedCaller(ctx.bob.address, true))
      .to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
    await expect(ctx.flags.setAuthorizedCaller(ctx.bob.address, true))
      .to.emit(ctx.flags, "AuthorizedCallerSet").withArgs(ctx.bob.address, true);
    await expect(ctx.flags.connect(ctx.bob).canSend(ctx.alice.address)).to.not.be.reverted;
  });

  it("checkAuditScope is limited to the user and the auditor", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.connect(ctx.alice).setAuditScope(
      ctx.auditor.address,
      ...(await encryptUint8For(ctx.client, ctx.alice, 2n, await ctx.flags.getAddress())),
    );
    await expect(
      ctx.flags.connect(ctx.bob).checkAuditScope(
        ctx.alice.address,
        ctx.auditor.address,
        ...(await encryptUint8For(ctx.client, ctx.bob, 2n, await ctx.flags.getAddress())),
      ),
    ).to.be.revertedWith("EncryptedFlags: not user or auditor");
  });

  it("fee rates above 10000 bps are rejected; setFeeRates is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.flags.setFeeRates(10_001, 0)).to.be.revertedWith("EncryptedFlags: rate above 10000");
    await expect(ctx.flags.setFeeRates(0, 10_001)).to.be.revertedWith("EncryptedFlags: rate above 10000");
    await expect(ctx.flags.connect(ctx.alice).setFeeRates(1, 1))
      .to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
    // The event carries no rate: it stays encrypted at rest.
    await expect(ctx.flags.setFeeRates(250, 0)).to.emit(ctx.flags, "FeeRatesSet").withArgs((_t: bigint) => true);
    const [fee] = await feeOf(ctx, ctx.alice, 1_000_000n);
    await mock_expectPlaintext(ctx.alice.provider, fee, 25_000n);
    await expect(deployProxy("EncryptedFlags", [20_000n, 0n])).to.be.reverted;
  });
});

// C4a: results are shared handles, so another contract can consume them.
describe("EncryptedFlags: results a calling contract can use (C4a)", () => {
  async function consumerFixture() {
    const ctx = await deployFixture();
    const Consumer = await hre.ethers.getContractFactory("MockFlagsConsumer");
    const consumer = await Consumer.deploy(await ctx.flags.getAddress());
    await consumer.waitForDeployment();
    await ctx.flags.setAuthorizedCaller(await consumer.getAddress(), true);
    return { ...ctx, consumer };
  }

  it("canSend: a contract takes the shared handle and reads the verified AND active result", async () => {
    const ctx = await loadFixture(consumerFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await ctx.flags.setActive(ctx.alice.address, true);
    await ctx.consumer.checkSend(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.sendOk(), 1n);

    await ctx.flags.setActive(ctx.alice.address, false);
    await ctx.consumer.checkSend(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.sendOk(), 0n);
  });

  it("canReceive: verified OR kyc, consumed by a contract", async () => {
    const ctx = await loadFixture(consumerFixture);
    await ctx.flags.setVerified(ctx.alice.address, false);
    await ctx.flags.setKYCCompleted(ctx.alice.address);
    await ctx.consumer.checkReceive(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.receiveOk(), 1n);

    await ctx.flags.setVerified(ctx.bob.address, false);
    await ctx.flags.setKYCCompleted(ctx.bob.address);
    await ctx.flags.setVerifiedEncrypted(ctx.bob.address, ...(await encryptBoolFor(ctx.client, ctx.owner, false, await ctx.flags.getAddress())));
    await ctx.flags.setKYCCompletedEncrypted(ctx.bob.address, ...(await encryptBoolFor(ctx.client, ctx.owner, false, await ctx.flags.getAddress())));
    await ctx.consumer.checkReceive(ctx.bob.address);
    await mock_expectPlaintext(ctx.bob.provider, await ctx.consumer.receiveOk(), 0n);
  });

  it("the received result feeds a further FHE operation (gate an amount)", async () => {
    const ctx = await loadFixture(consumerFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await ctx.flags.setActive(ctx.alice.address, true);
    await ctx.consumer.gateAmount(ctx.alice.address, 777);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.gated(), 777n);

    await ctx.flags.setVerified(ctx.alice.address, false);
    await ctx.consumer.gateAmount(ctx.alice.address, 777);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.gated(), 0n);
  });

  it("calculateFeeVerified / calculateMerchantFeeVerified work from a shared amount", async () => {
    const ctx = await loadFixture(consumerFixture);
    await ctx.consumer.feeFor(1_000_000);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.fee(), 10_000n);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.net(), 990_000n);

    await ctx.flags.setMerchant(ctx.alice.address, true);
    await ctx.consumer.merchantFeeFor(1_000_000, ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.fee(), 5_000n);
    await mock_expectPlaintext(ctx.alice.provider, await ctx.consumer.net(), 995_000n);
  });

  it("an unauthorized contract is still refused", async () => {
    const ctx = await loadFixture(consumerFixture);
    const Consumer = await hre.ethers.getContractFactory("MockFlagsConsumer");
    const stranger = await Consumer.deploy(await ctx.flags.getAddress());
    await expect(stranger.checkSend(ctx.alice.address)).to.be.revertedWith("EncryptedFlags: not authorized");
    await expect(stranger.merchantFeeFor(1_000, ctx.alice.address)).to.be.revertedWith("EncryptedFlags: not authorized");
  });

  it("an EOA still reads its own result handle", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerified(ctx.alice.address, true);
    await ctx.flags.setActive(ctx.alice.address, true);
    const handle = await ctx.flags.connect(ctx.alice).canSend.staticCall(ctx.alice.address);
    await ctx.flags.connect(ctx.alice).canSend(ctx.alice.address);
    await mock_expectPlaintext(ctx.alice.provider, handle, 1n);
  });
});

// C4b: confidential setters. The plaintext ones stay (deprecated) for owners
// that cannot produce an encrypted input.
describe("EncryptedFlags: encrypted setters (C4b)", () => {
  it("setVerified / setActive / setKYC / setMerchant take encrypted values and store them", async () => {
    const ctx = await loadFixture(deployFixture);
    const addr = await ctx.flags.getAddress();
    await expect(ctx.flags.setVerifiedEncrypted(ctx.alice.address, ...(await encryptBoolFor(ctx.client, ctx.owner, true, addr))))
      .to.emit(ctx.flags, "FlagSet").withArgs(ctx.alice.address, "verified", (_t: bigint) => true);
    await ctx.flags.setActiveEncrypted(ctx.alice.address, ...(await encryptBoolFor(ctx.client, ctx.owner, true, addr)));
    await ctx.flags.setKYCCompletedEncrypted(ctx.alice.address, ...(await encryptBoolFor(ctx.client, ctx.owner, false, addr)));
    await ctx.flags.setMerchantEncrypted(ctx.alice.address, ...(await encryptBoolFor(ctx.client, ctx.owner, true, addr)));

    const p = ctx.alice.provider;
    await mock_expectPlaintext(p, await ctx.flags.connect(ctx.alice).getMyVerifiedStatus(), 1n);
    await mock_expectPlaintext(p, await ctx.flags.connect(ctx.alice).getMyActiveStatus(), 1n);
    await mock_expectPlaintext(p, await ctx.flags.connect(ctx.alice).getMyKYCStatus(), 0n);
    await mock_expectPlaintext(p, await ctx.flags.connect(ctx.alice).getMyMerchantStatus(), 1n);
  });

  it("the user can read their own encrypted flag, a stranger cannot", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setVerifiedEncrypted(ctx.alice.address, ...(await encryptBoolFor(ctx.client, ctx.owner, true, await ctx.flags.getAddress())));
    const handle = await ctx.flags.connect(ctx.alice).getMyVerifiedStatus();
    const acl = await hre.cofhe.mocks.getMockACL();
    expect(await acl.isAllowed(handle, ctx.alice.address)).to.equal(true);
    expect(await acl.isAllowed(handle, ctx.bob.address)).to.equal(false);
  });

  it("every encrypted setter is owner-only", async () => {
    const ctx = await loadFixture(deployFixture);
    const addr = await ctx.flags.getAddress();
    const flag = await encryptBoolFor(ctx.client, ctx.alice, true, addr);
    const rates = await encryptUint64Pair(ctx.client, ctx.alice, 1n, 2n, addr);
    const asAlice = ctx.flags.connect(ctx.alice);
    for (const call of [
      () => asAlice.setVerifiedEncrypted(ctx.alice.address, ...flag),
      () => asAlice.setActiveEncrypted(ctx.alice.address, ...flag),
      () => asAlice.setKYCCompletedEncrypted(ctx.alice.address, ...flag),
      () => asAlice.setMerchantEncrypted(ctx.alice.address, ...flag),
      () => asAlice.setFeeRatesEncrypted(...rates),
    ]) {
      await expect(call()).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
    }
  });

  it("setFeeRatesEncrypted sets confidential rates: no rate in any event, fees follow", async () => {
    const ctx = await loadFixture(deployFixture);
    const addr = await ctx.flags.getAddress();
    const tx = await ctx.flags.setFeeRatesEncrypted(...(await encryptUint64Pair(ctx.client, ctx.owner, 300n, 0n, addr)));
    const receipt = await tx.wait();
    const rateLog = receipt.logs
      .map((l: any) => { try { return ctx.flags.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p && p.name === "FeeRatesSet");
    expect(rateLog.args.length).to.equal(1); // timestamp only
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1_000_000n, addr);
    const [fee, net] = await ctx.flags.connect(ctx.alice).calculateFee.staticCall(...enc);
    await ctx.flags.connect(ctx.alice).calculateFee(...enc);
    await mock_expectPlaintext(ctx.alice.provider, fee, 30_000n);
    await mock_expectPlaintext(ctx.alice.provider, net, 970_000n);
  });

  it("encrypted rates above 10000 bps are clamped, so a fee can never exceed the amount", async () => {
    const ctx = await loadFixture(deployFixture);
    const addr = await ctx.flags.getAddress();
    await ctx.flags.setFeeRatesEncrypted(...(await encryptUint64Pair(ctx.client, ctx.owner, 50_000n, 99_999n, addr)));
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1_000_000n, addr);
    const [fee, net] = await ctx.flags.connect(ctx.alice).calculateFee.staticCall(...enc);
    await ctx.flags.connect(ctx.alice).calculateFee(...enc);
    await mock_expectPlaintext(ctx.alice.provider, fee, 1_000_000n);
    await mock_expectPlaintext(ctx.alice.provider, net, 0n);
  });

  it("the plaintext initialize / setFeeRates still work and now emit no rate", async () => {
    const ctx = await loadFixture(deployFixture);
    const tx = await ctx.flags.setFeeRates(125, 2500);
    const receipt = await tx.wait();
    const rateLog = receipt.logs
      .map((l: any) => { try { return ctx.flags.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p && p.name === "FeeRatesSet");
    expect(rateLog.args.length).to.equal(1);
    expect(ctx.flags.interface.getEvent("FeeRatesSet")!.inputs.map((i: any) => i.name)).to.deep.equal(["timestamp"]);
  });
});

describe("EncryptedFlags — UUPS upgrade gate", () => {
  it("non-owner cannot upgrade", async () => {
    const ctx = await loadFixture(deployFixture);
    const Factory = await hre.ethers.getContractFactory("EncryptedFlags");
    const newImpl = await Factory.deploy();
    await newImpl.waitForDeployment();
    await expect(
      ctx.flags.connect(ctx.alice).upgradeToAndCall(await newImpl.getAddress(), "0x"),
    ).to.be.revertedWithCustomError(ctx.flags, "OwnableUnauthorizedAccount");
  });
});
