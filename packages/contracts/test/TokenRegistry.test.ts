import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

// ══════════════════════════════════════════════════════════════════
//  TokenRegistry — UUPS-proxied registry mapping ERC20s to their
//  FHERC20Vault wrappers. The frontend's token-list bootstrap
//  (lib/abis.ts -> TokenRegistry.getActiveTokens) queries this on
//  every app load.
//
//  Critical because:
//   • A token that fails to register here is INVISIBLE to the
//     frontend even if its vault is deployed and funded.
//   • A duplicate registration would shadow a legit token + its
//     vault, routing user shield calls to the wrong contract.
//   • active=false on a deactivated token MUST exclude it from
//     getActiveTokens or stale entries would surface as live.
//   • Only the owner can register/deactivate/reactivate — a
//     missing onlyOwner gate would let anyone inject a malicious
//     vault into the token list.
//
//  Covers:
//   • initialize() sets owner + guards against double-init
//   • registerToken: owner-only, emits TokenRegistered, both
//     vault and underlying are indexed
//   • registerToken: rejects duplicate vault OR duplicate underlying
//   • deactivateToken: owner-only, sets active=false, emits event,
//     rejects non-existent vault
//   • reactivateToken: sets active=true, emits event
//   • getActiveTokens: returns only active, in registration order
//   • getTokenByVault / getTokenByUnderlying: revert on not-found
//   • tokenCount: monotonically increases, includes deactivated
//   • _authorizeUpgrade: non-owner cannot upgrade (UUPS gate)
// ══════════════════════════════════════════════════════════════════

async function deployProxy(contractName: string) {
  const Factory = await hre.ethers.getContractFactory(contractName);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const initData = Factory.interface.encodeFunctionData("initialize");
  const ProxyFactory = await hre.ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
  );
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Factory.attach(await proxy.getAddress()) as unknown as Awaited<
    ReturnType<typeof Factory.deploy>
  >;
}

async function fixture() {
  const [owner, alice, bob] = await hre.ethers.getSigners();
  const registry = await deployProxy("TokenRegistry");
  return { owner, alice, bob, registry };
}

// Deterministic addresses for the (vault, underlying) pairs.
const vaultA = hre.ethers.getAddress("0xaaaa000000000000000000000000000000000001");
const underlyingA = hre.ethers.getAddress("0xbbbb000000000000000000000000000000000001");
const vaultB = hre.ethers.getAddress("0xaaaa000000000000000000000000000000000002");
const underlyingB = hre.ethers.getAddress("0xbbbb000000000000000000000000000000000002");

describe("TokenRegistry — initialization", () => {
  it("sets the deployer (owner-signer) as owner after proxy init", async () => {
    const { owner, registry } = await loadFixture(fixture);
    expect(await registry.owner()).to.equal(owner.address);
  });

  it("rejects a second initialize() call (one-shot UUPS guard)", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(registry.initialize()).to.be.revertedWithCustomError(
      registry,
      "InvalidInitialization",
    );
  });
});

describe("TokenRegistry — registerToken", () => {
  it("registers a token and emits TokenRegistered with vault + underlying + symbol", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(
      registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6),
    )
      .to.emit(registry, "TokenRegistered")
      .withArgs(vaultA, underlyingA, "eUSDC");
  });

  it("registered token is queryable via getTokenByVault", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    const info = await registry.getTokenByVault(vaultA);
    expect(info.vault).to.equal(vaultA);
    expect(info.underlying).to.equal(underlyingA);
    expect(info.name).to.equal("Encrypted USDC");
    expect(info.symbol).to.equal("eUSDC");
    expect(info.decimals).to.equal(6);
    expect(info.active).to.equal(true);
  });

  it("registered token is queryable via getTokenByUnderlying", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    const info = await registry.getTokenByUnderlying(underlyingA);
    expect(info.vault).to.equal(vaultA);
    expect(info.symbol).to.equal("eUSDC");
  });

  it("only the owner can register (non-owner reverts with OwnableUnauthorizedAccount)", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await expect(
      registry.connect(alice).registerToken(vaultA, underlyingA, "x", "x", 6),
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("rejects a duplicate vault (would shadow the prior entry)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    await expect(
      // Same vault, different underlying — must still reject.
      registry.registerToken(vaultA, underlyingB, "DIFF", "DIFF", 6),
    ).to.be.revertedWith("TokenRegistry: vault already registered");
  });

  it("rejects a duplicate underlying (each ERC20 maps to ONE vault)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    await expect(
      // Same underlying, different vault — must still reject.
      registry.registerToken(vaultB, underlyingA, "DIFF", "DIFF", 6),
    ).to.be.revertedWith("TokenRegistry: underlying already registered");
  });
});

describe("TokenRegistry — deactivate + reactivate", () => {
  it("deactivateToken sets active=false and emits TokenDeactivated", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    await expect(registry.deactivateToken(vaultA))
      .to.emit(registry, "TokenDeactivated")
      .withArgs(vaultA);
    const info = await registry.getTokenByVault(vaultA);
    expect(info.active).to.equal(false);
  });

  it("deactivateToken reverts on a non-registered vault", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(registry.deactivateToken(vaultA)).to.be.revertedWith(
      "TokenRegistry: vault not found",
    );
  });

  it("deactivateToken is owner-only", async () => {
    const { alice, registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    await expect(
      registry.connect(alice).deactivateToken(vaultA),
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("reactivateToken flips active back to true and emits TokenReactivated", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    await registry.deactivateToken(vaultA);
    await expect(registry.reactivateToken(vaultA))
      .to.emit(registry, "TokenReactivated")
      .withArgs(vaultA);
    const info = await registry.getTokenByVault(vaultA);
    expect(info.active).to.equal(true);
  });

  it("reactivateToken reverts on a non-registered vault", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(registry.reactivateToken(vaultA)).to.be.revertedWith(
      "TokenRegistry: vault not found",
    );
  });
});

describe("TokenRegistry — getActiveTokens", () => {
  it("returns empty array on a fresh registry", async () => {
    const { registry } = await loadFixture(fixture);
    const active = await registry.getActiveTokens();
    expect(active.length).to.equal(0);
  });

  it("returns all registered tokens when none are deactivated", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    await registry.registerToken(vaultB, underlyingB, "Encrypted USDT", "eUSDT", 6);
    const active = await registry.getActiveTokens();
    expect(active.length).to.equal(2);
    expect(active[0].vault).to.equal(vaultA);
    expect(active[1].vault).to.equal(vaultB);
  });

  it("EXCLUDES deactivated tokens from the result (the load-bearing filter)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    await registry.registerToken(vaultB, underlyingB, "Encrypted USDT", "eUSDT", 6);
    await registry.deactivateToken(vaultA);
    const active = await registry.getActiveTokens();
    expect(active.length).to.equal(1);
    expect(active[0].vault).to.equal(vaultB);
  });

  it("includes reactivated tokens (deactivate then reactivate round-trip)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "Encrypted USDC", "eUSDC", 6);
    await registry.deactivateToken(vaultA);
    await registry.reactivateToken(vaultA);
    const active = await registry.getActiveTokens();
    expect(active.length).to.equal(1);
    expect(active[0].vault).to.equal(vaultA);
  });
});

describe("TokenRegistry — lookup reverts", () => {
  it("getTokenByVault reverts on not-found (don't return a zero-struct)", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(registry.getTokenByVault(vaultA)).to.be.revertedWith(
      "TokenRegistry: vault not found",
    );
  });

  it("getTokenByUnderlying reverts on not-found", async () => {
    const { registry } = await loadFixture(fixture);
    await expect(registry.getTokenByUnderlying(underlyingA)).to.be.revertedWith(
      "TokenRegistry: underlying not found",
    );
  });
});

describe("TokenRegistry — tokenCount", () => {
  it("starts at 0 on a fresh registry", async () => {
    const { registry } = await loadFixture(fixture);
    expect(await registry.tokenCount()).to.equal(0);
  });

  it("increments by 1 per registerToken (monotonic, never decrements)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    expect(await registry.tokenCount()).to.equal(1);
    await registry.registerToken(vaultB, underlyingB, "y", "Y", 6);
    expect(await registry.tokenCount()).to.equal(2);
  });

  it("INCLUDES deactivated tokens (count is registrations, not active)", async () => {
    const { registry } = await loadFixture(fixture);
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    await registry.registerToken(vaultB, underlyingB, "y", "Y", 6);
    await registry.deactivateToken(vaultA);
    // tokenCount is 2 even though only 1 is active.
    expect(await registry.tokenCount()).to.equal(2);
    const active = await registry.getActiveTokens();
    expect(active.length).to.equal(1);
  });
});

describe("TokenRegistry — UUPS upgrade gate", () => {
  it("non-owner cannot upgrade (upgradeToAndCall reverts)", async () => {
    const { alice, registry } = await loadFixture(fixture);
    // Deploy a fresh implementation so the call has a valid target.
    const Factory = await hre.ethers.getContractFactory("TokenRegistry");
    const newImpl = await Factory.deploy();
    await newImpl.waitForDeployment();
    await expect(
      registry.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x"),
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });
});

describe("TokenRegistry — public index mappings", () => {
  it("vaultToIndex and underlyingToIndex are 1-indexed (0 means not found)", async () => {
    const { registry } = await loadFixture(fixture);
    // Before registration, both are 0.
    expect(await registry.vaultToIndex(vaultA)).to.equal(0);
    expect(await registry.underlyingToIndex(underlyingA)).to.equal(0);
    // After registration, both are 1.
    await registry.registerToken(vaultA, underlyingA, "x", "X", 6);
    expect(await registry.vaultToIndex(vaultA)).to.equal(1);
    expect(await registry.underlyingToIndex(underlyingA)).to.equal(1);
    // Second registration uses index 2.
    await registry.registerToken(vaultB, underlyingB, "y", "Y", 6);
    expect(await registry.vaultToIndex(vaultB)).to.equal(2);
    expect(await registry.underlyingToIndex(underlyingB)).to.equal(2);
  });
});
