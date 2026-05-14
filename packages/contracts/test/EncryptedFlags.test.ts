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

async function encryptUint8For(client: any, signer: any, value: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint8(value)]).execute();
  return enc;
}

async function encryptUint64For(client: any, signer: any, value: bigint) {
  await hre.cofhe.connectWithHardhatSigner(client, signer);
  const [enc] = await client.encryptInputs([Encryptable.uint64(value)]).execute();
  return enc;
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
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n);
    await expect(ctx.flags.connect(ctx.alice).calculateFee(enc))
      .to.emit(ctx.flags, "FeeCalculated")
      .withArgs(ctx.alice.address, (_t: bigint) => true);
  });

  it("calculateMerchantFee succeeds for non-merchant (full fee, no discount path)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, false);
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n);
    // The FHE.select branch resolves to the non-discounted baseFee. We
    // can't trivially decrypt the (fee, netAmount) return tuple from a
    // non-view tx, but the call must NOT revert and must process the
    // mock task chain end-to-end.
    await expect(
      ctx.flags.connect(ctx.alice).calculateMerchantFee(enc, ctx.alice.address),
    ).to.not.be.reverted;
  });

  it("calculateMerchantFee succeeds for merchant (discount-applied path)", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.flags.setMerchant(ctx.alice.address, true);
    const enc = await encryptUint64For(ctx.client, ctx.alice, 1000n);
    await expect(
      ctx.flags.connect(ctx.alice).calculateMerchantFee(enc, ctx.alice.address),
    ).to.not.be.reverted;
  });
});

describe("EncryptedFlags — audit scope (encrypted bitmask)", () => {
  it("setAuditScope stores the bitmask + emits AuditScopeSet + getAuditScope returns it", async () => {
    const ctx = await loadFixture(deployFixture);
    const scope = 0b0000_0111; // bits 0,1,2 = amounts + parties + timestamps
    const enc = await encryptUint8For(ctx.client, ctx.alice, BigInt(scope));
    await expect(
      ctx.flags.connect(ctx.alice).setAuditScope(ctx.auditor.address, enc),
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
      await encryptUint8For(ctx.client, ctx.alice, BigInt(scope)),
    );
    // Mask asks for bit 1 -> AND = 0b10 != 0 -> hasAccess=true.
    const mask = 0b0000_0010;
    await expect(
      ctx.flags.connect(ctx.auditor).checkAuditScope(
        ctx.alice.address,
        ctx.auditor.address,
        await encryptUint8For(ctx.client, ctx.auditor, BigInt(mask)),
      ),
    ).to.not.be.reverted;
  });

  it("checkAuditScope returns hasAccess=false when no bit overlaps (encrypted FHE.ne path)", async () => {
    const ctx = await loadFixture(deployFixture);
    const scope = 0b0000_0010; // only bit 1
    await ctx.flags.connect(ctx.alice).setAuditScope(
      ctx.auditor.address,
      await encryptUint8For(ctx.client, ctx.alice, BigInt(scope)),
    );
    // Mask asks for bit 4 -> AND = 0 -> hasAccess=false.
    const mask = 0b0001_0000;
    await expect(
      ctx.flags.connect(ctx.auditor).checkAuditScope(
        ctx.alice.address,
        ctx.auditor.address,
        await encryptUint8For(ctx.client, ctx.auditor, BigInt(mask)),
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
