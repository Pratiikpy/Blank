import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-upgrade-security-v1 - ship the pre-mainnet audit fixes to a testnet.
 *
 * Every proxy keeps its address and state. Storage changes are append-only and
 * gated by `pnpm storage:check` plus `BASE_REF=main node scripts/storage-append-check.cjs`.
 *
 * Order matters:
 *   1. TokenRegistry first, then register every live vault, because every hub
 *      now fails closed until its vault is on the allowlist.
 *   2. Callees (vaults, receipts) before the hubs that call them.
 *   3. The three P2P offramp contracts together: their call interface changed.
 *   4. Wire setTokenRegistry on every hub, then the one-time migrations.
 *   5. Fresh deploys for non-proxy contracts whose code changed.
 *
 * Ownership is NOT moved here. `transfer-ownership-to-safe` does that after
 * this run is verified, so a failed step can still be fixed by the deployer.
 *
 * Args:
 *   --dry-run : print the plan, send nothing.
 *   --only    : comma-separated step names (upgrade keys or wire/migrate/fresh) to resume.
 */

const UPGRADES: Array<{ key: string; contract: string; probe: string }> = [
  { key: "TokenRegistry", contract: "TokenRegistry", probe: "tokenCount" },
  { key: "FHERC20Vault_USDC", contract: "FHERC20Vault", probe: "underlyingToken" },
  { key: "FHERC20Vault_USDT", contract: "FHERC20Vault", probe: "underlyingToken" },
  { key: "PaymentReceipts", contract: "PaymentReceipts", probe: "owner" },
  { key: "EventHub", contract: "EventHub", probe: "owner" },
  { key: "EncryptedFlags", contract: "EncryptedFlags", probe: "owner" },
  { key: "PaymentHub", contract: "PaymentHub", probe: "nextRequestId" },
  { key: "EncryptedEscrow", contract: "EncryptedEscrow", probe: "nextEscrowId" },
  { key: "BusinessHub", contract: "BusinessHub", probe: "nextInvoiceId" },
  { key: "GroupManager", contract: "GroupManager", probe: "owner" },
  { key: "GiftMoney", contract: "GiftMoney", probe: "nextEnvelopeId" },
  { key: "ClaimLinks", contract: "ClaimLinks", probe: "owner" },
  { key: "Storefront", contract: "Storefront", probe: "owner" },
  { key: "EncryptedCrowdfund", contract: "EncryptedCrowdfund", probe: "owner" },
  { key: "CreatorHub", contract: "CreatorHub", probe: "owner" },
  { key: "PrivacyRouter", contract: "PrivacyRouter", probe: "owner" },
  { key: "StealthPayments", contract: "StealthPayments", probe: "owner" },
  { key: "InheritanceManager", contract: "InheritanceManager", probe: "owner" },
  { key: "P2PExchange", contract: "P2PExchange", probe: "owner" },
  { key: "ProofOfBalance", contract: "ProofOfBalance", probe: "owner" },
  { key: "MockReclaimVerifier", contract: "MockReclaimVerifier", probe: "operator" },
  { key: "ReclaimAdapter", contract: "ReclaimAdapter", probe: "verifier" },
  { key: "P2POfframp", contract: "P2POfframp", probe: "nextOfferId" },
  { key: "GuardianModule", contract: "GuardianModule", probe: "owner" },
  { key: "BlankHandles", contract: "BlankHandles", probe: "owner" },
];

/** hubs that take a caller-supplied vault and fail closed until wired */
const WIRE_REGISTRY = [
  "PaymentHub", "EncryptedEscrow", "BusinessHub", "GroupManager", "GiftMoney", "ClaimLinks",
  "Storefront", "EncryptedCrowdfund", "CreatorHub", "PrivacyRouter", "StealthPayments",
  "InheritanceManager", "P2POfframp",
];

/** non-proxy contracts whose code changed: deploy fresh, keep the old address under *_v0 */
const FRESH = ["InvoiceApprovalResolver", "BurnerRegistry", "SessionKeyValidator"];

const GUARDIAN_MIN_WINDOW = 86_400;
const FLAGS_BASE_FEE = 100; // 1.00% in basis points, the value deploy-fhe-extras used
const FLAGS_MERCHANT_DISCOUNT = 5000; // 50%

function deploymentsPath(networkName: string): string {
  const file =
    networkName === "arb-sepolia" ? "arb-sepolia.json" :
    networkName === "base-sepolia" ? "base-sepolia.json" :
    networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
  if (!file) throw new Error(`deploy-upgrade-security-v1: unsupported network ${networkName}`);
  return resolve(__dirname, "..", "deployments", file);
}

/**
 * Campaigns that may have been swept before the upgrade. claimRelease needs
 * resultPublished && goalMet, so only those campaigns can have been swept.
 * Whether a sweep actually happened is only visible in CampaignReleased logs,
 * which public testnet RPCs no longer serve for old blocks. So: if no
 * campaign is a candidate, the list is provably empty. Otherwise the operator
 * must pass the swept ids explicitly (from an explorer), and we refuse to guess.
 */
async function releasedCampaignIds(
  hre: HardhatRuntimeEnvironment,
  addr: string,
  explicit?: string,
): Promise<bigint[]> {
  const cf = await hre.ethers.getContractAt("EncryptedCrowdfund", addr);
  const n: bigint = await cf.nextCampaignId();
  const candidates: bigint[] = [];
  for (let i = 0n; i < n; i++) {
    const c = await cf.getCampaign(i);
    if (c.resultPublished && c.goalMet) candidates.push(i);
  }
  console.log(`   crowdfund: ${n} campaigns, ${candidates.length} could have been swept`);
  if (explicit !== undefined) {
    const ids = explicit.split(",").filter(Boolean).map((s) => BigInt(s.trim()));
    for (const id of ids) {
      if (!candidates.includes(id)) throw new Error(`crowdfund: id ${id} was never releasable`);
    }
    return ids;
  }
  if (candidates.length > 0) {
    throw new Error(
      `crowdfund: campaigns [${candidates.join(", ")}] may have been swept. ` +
      `Pass the ids that emitted CampaignReleased with --crowdfund-released (empty string for none).`,
    );
  }
  return [];
}

task("deploy-upgrade-security-v1", "Ship the pre-mainnet audit fixes to a testnet")
  .addFlag("dryRun", "Print the plan without sending txs")
  .addOptionalParam("only", "Comma-separated step names to run")
  .addOptionalParam("crowdfundReleased", "Comma-separated campaign ids swept before the upgrade")
  .setAction(async (args: { dryRun: boolean; only?: string; crowdfundReleased?: string }, hre: HardhatRuntimeEnvironment) => {
    const path = deploymentsPath(hre.network.name);
    const d: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const save = () => writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
    const want = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
    const run = (step: string) => (want ? want.has(step) : true);

    const [deployer] = await hre.ethers.getSigners();
    if (!deployer) throw new Error("deploy-upgrade-security-v1: no signer, set PRIVATE_KEY");
    const wait = async (tx: { hash: string; wait: (n?: number) => Promise<unknown> }, label: string) => {
      const rcpt = (await tx.wait(2)) as { status?: number } | null;
      if (rcpt?.status !== 1) throw new Error(`${label}: tx ${tx.hash} reverted`);
      console.log(`   ${label} tx=${tx.hash}`);
    };

    console.log(`network=${hre.network.name} deployer=${deployer.address}`);
    console.log(`balance=${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);

    const plan = UPGRADES.filter((u) => d[u.key] && run(u.key));
    for (const u of UPGRADES) if (!d[u.key]) console.log(`  (skip ${u.key}: not deployed here)`);
    if (args.dryRun) {
      for (const u of plan) console.log(`[dry-run] upgrade ${u.key} (${u.contract}) proxy=${d[u.key]}`);
      console.log(`[dry-run] register vaults, wire registry on ${WIRE_REGISTRY.filter((k) => d[k]).join(", ")}`);
      console.log(`[dry-run] migrate: BusinessHub.accountLegacyEscrows, PaymentReceipts.publishGlobalSnapshot, EncryptedFlags.setFeeRates, GuardianModule.setRecoveryWindow`);
      console.log(`[dry-run] fresh: ${FRESH.filter((k) => d[k]).join(", ")}, BlankAccount implementation`);
      return;
    }

    const registerVaults = async () => {
      const registry = await hre.ethers.getContractAt("TokenRegistry", d.TokenRegistry!, deployer);
      console.log(`\n── register vaults`);
      for (const key of Object.keys(d).filter((k) => /^FHERC20Vault_[A-Z]+$/.test(k))) {
        const vault = d[key]!;
        if ((await registry.vaultToIndex(vault)) !== 0n) {
          console.log(`   ${key} already registered`);
          continue;
        }
        const v = await hre.ethers.getContractAt("FHERC20Vault", vault);
        const underlying: string = await v.underlyingToken();
        const erc = await hre.ethers.getContractAt(
          "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
          underlying,
        );
        const [sym, dec] = await Promise.all([erc.symbol(), erc.decimals()]);
        await wait(
          await registry.registerToken(vault, underlying, `Encrypted ${sym}`, `e${sym}`, dec),
          `registerToken ${key} (${sym}, ${dec} dec)`,
        );
      }
    };

    // ── 1. upgrades. TokenRegistry goes first and every live vault is
    // registered before any hub upgrade, because hubs fail closed on an
    // unregistered vault. Hubs that take a vault get setTokenRegistry in the
    // same upgradeToAndCall, so no hub is ever live without its allowlist.
    for (const u of plan) {
      const implKey = `${u.key}_Impl_security_v1`;
      if (d[implKey]) {
        console.log(`\n── ${u.key} already upgraded (${d[implKey]})`);
        if (u.key === "TokenRegistry" && run("register")) await registerVaults();
        continue;
      }
      console.log(`\n── upgrade ${u.key} (${u.contract})`);
      const proxy = await hre.ethers.getContractAt(u.contract, d[u.key]!, deployer);
      const owner: string = await proxy.owner();
      if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
        throw new Error(`${u.key}: deployer is not owner (${owner})`);
      }
      const before = await proxy[u.probe]();
      const Factory = await hre.ethers.getContractFactory(u.contract);
      const impl = await Factory.deploy();
      await impl.deploymentTransaction()?.wait(2);
      const implAddr = await impl.getAddress();
      let initData = WIRE_REGISTRY.includes(u.key)
        ? Factory.interface.encodeFunctionData("setTokenRegistry", [d.TokenRegistry!])
        : "0x";
      if (u.key === "EncryptedCrowdfund") {
        // Campaigns swept before this upgrade have releasePaid == false. Mark
        // them in the upgrade call itself; claimRelease stays closed until
        // finishLegacyMigration, and setTokenRegistry follows right after.
        const ids = await releasedCampaignIds(hre, d.EncryptedCrowdfund!, args.crowdfundReleased);
        console.log(`   legacy released campaigns: [${ids.join(", ")}]`);
        initData = Factory.interface.encodeFunctionData("markLegacyReleased", [ids]);
      }
      await wait(
        await proxy.upgradeToAndCall(implAddr, initData),
        initData === "0x" ? "upgradeToAndCall" : "upgradeToAndCall + setTokenRegistry",
      );
      const after = await proxy[u.probe]();
      if (String(before) !== String(after)) {
        throw new Error(`${u.key}: ${u.probe} changed across upgrade (${before} -> ${after})`);
      }
      console.log(`   impl=${implAddr}, ${u.probe} survived: ${after}`);
      d[implKey] = implAddr;
      save();
      if (u.key === "TokenRegistry" && run("register")) await registerVaults();
    }

    // ── 3. wire the allowlist into every hub ───────────────────────────
    if (run("wire")) {
      console.log(`\n── wire tokenRegistry`);
      for (const key of WIRE_REGISTRY.filter((k) => d[k])) {
        const c = await hre.ethers.getContractAt(key, d[key]!, deployer);
        const cur: string = await c.tokenRegistry();
        if (cur.toLowerCase() === d.TokenRegistry!.toLowerCase()) {
          console.log(`   ${key} already wired`);
          continue;
        }
        await wait(await c.setTokenRegistry(d.TokenRegistry!), `${key}.setTokenRegistry`);
      }
    }

    // ── 4. one-time migrations ─────────────────────────────────────────
    if (run("migrate")) {
      console.log(`\n── migrations`);
      if (d.BusinessHub) {
        const bh = await hre.ethers.getContractAt("BusinessHub", d.BusinessHub, deployer);
        for (let i = 0; i < 50; i++) {
          const [cursor, next] = await Promise.all([bh.escrowAccountingCursor(), bh.nextEscrowId()]);
          if (cursor >= next) {
            console.log(`   BusinessHub legacy escrows accounted (${cursor}/${next})`);
            break;
          }
          await wait(await bh.accountLegacyEscrows(25), `BusinessHub.accountLegacyEscrows ${cursor}/${next}`);
        }
      }
      if (d.EncryptedCrowdfund) {
        const cf = await hre.ethers.getContractAt("EncryptedCrowdfund", d.EncryptedCrowdfund, deployer);
        if (!(await cf.legacyMigrationDone())) {
          await wait(await cf.finishLegacyMigration(), "EncryptedCrowdfund.finishLegacyMigration");
        } else console.log(`   EncryptedCrowdfund legacy migration already closed`);
      }
      if (d.PaymentReceipts) {
        const pr = await hre.ethers.getContractAt("PaymentReceipts", d.PaymentReceipts, deployer);
        if ((await pr.lastSnapshotAt()) === 0n) {
          await wait(await pr.publishGlobalSnapshot(), "PaymentReceipts.publishGlobalSnapshot");
        } else console.log(`   PaymentReceipts snapshot already published`);
      }
      if (d.EncryptedFlags) {
        const ef = await hre.ethers.getContractAt("EncryptedFlags", d.EncryptedFlags, deployer);
        await wait(await ef.setFeeRates(FLAGS_BASE_FEE, FLAGS_MERCHANT_DISCOUNT), "EncryptedFlags.setFeeRates");
      }
      if (d.GuardianModule) {
        const gm = await hre.ethers.getContractAt("GuardianModule", d.GuardianModule, deployer);
        if (BigInt(await gm.RECOVERY_WINDOW_SECONDS()) < BigInt(GUARDIAN_MIN_WINDOW)) {
          await wait(await gm.setRecoveryWindow(GUARDIAN_MIN_WINDOW), "GuardianModule.setRecoveryWindow");
        }
      }
      if (d.P2POfframp) {
        const off = await hre.ethers.getContractAt("P2POfframp", d.P2POfframp, deployer);
        const arb: string = await off.arbiter();
        if (arb === hre.ethers.ZeroAddress) throw new Error("P2POfframp: live arbiter is zero, run rotate-offramp-arbiter");
        console.log(`   P2POfframp arbiter=${arb}`);
      }
    }

    // ── 5. fresh deploys of changed non-proxy contracts ────────────────
    if (run("fresh")) {
      console.log(`\n── fresh deploys`);
      for (const key of FRESH.filter((k) => d[k])) {
        if (d[`${key}_v0`]) {
          console.log(`   ${key} already redeployed (${d[key]})`);
          continue;
        }
        const c = await (await hre.ethers.getContractFactory(key)).deploy();
        await c.deploymentTransaction()?.wait(2);
        d[`${key}_v0`] = d[key]!;
        d[key] = await c.getAddress();
        console.log(`   ${key} ${d[`${key}_v0`]} -> ${d[key]}`);
        save();
      }
      if (!d.BlankAccount_Impl_security_v1) {
        const entryPoint = d.EntryPoint;
        if (!entryPoint) throw new Error("BlankAccount: no EntryPoint in deployments");
        const impl = await (await hre.ethers.getContractFactory("BlankAccount")).deploy(entryPoint);
        await impl.deploymentTransaction()?.wait(2);
        d.BlankAccount_Impl_security_v1 = await impl.getAddress();
        console.log(`   BlankAccount implementation ${d.BlankAccount_Impl_security_v1}`);
        save();
      }
    }

    save();
    console.log(`\ndone on ${hre.network.name}. Deployment file updated.`);
  });
