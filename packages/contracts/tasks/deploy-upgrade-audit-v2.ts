import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * deploy-upgrade-audit-v2 - ship the pre-mainnet CoFHE checklist fixes.
 *
 * Funding gates (escrow, claim links, gifts, crowdfund, tips, store, P2P fills),
 * shared handles on the vault and receipts, silent-zero counters, encrypted flag
 * setters. Every proxy keeps its address and state; storage is append-only and
 * gated by `pnpm storage:check`.
 *
 * All proxies are Safe-owned, so each upgradeToAndCall runs through
 * Safe.execTransaction signed by two of the three testnet signers. Implementations
 * are plain deployments from the deployer.
 *
 * Order (callees before callers, so nothing calls a function that is not there yet):
 *   1. vaults  2. PaymentReceipts, PaymentHub  3. PrivacyRouter, BusinessHub
 *   4. everything else  5. Safe: vault.setTrustedBalanceReader(PaymentReceipts, true)
 *
 * Ship the web app build that does the confirmFunding step BEFORE running this on a
 * live testnet: until then new tips, purchases, escrows, gifts, links, contributions
 * and P2P fills would sit Pending.
 *
 *   SAFE_ENV=<signer env> npx hardhat deploy-upgrade-audit-v2 --network <chain> [--dry-run] [--only A,B]
 *   Fork rehearsal: DEPLOYMENTS_FILE=<scratch copy> --network localhost (against `hardhat node --fork <rpc>`)
 */

const PLAN: Array<{ key: string; contract: string; probe?: string; probeArgs?: unknown[] }> = [
  { key: "FHERC20Vault_USDC", contract: "FHERC20Vault", probe: "trustedBalanceReaders", probeArgs: ["0x0000000000000000000000000000000000000000"] },
  { key: "FHERC20Vault_USDT", contract: "FHERC20Vault", probe: "trustedBalanceReaders", probeArgs: ["0x0000000000000000000000000000000000000000"] },
  { key: "PaymentReceipts", contract: "PaymentReceipts" },
  { key: "PaymentHub", contract: "PaymentHub", probe: "SETTLING_TIMEOUT" },
  { key: "PrivacyRouter", contract: "PrivacyRouter" },
  { key: "BusinessHub", contract: "BusinessHub" },
  { key: "EncryptedEscrow", contract: "EncryptedEscrow", probe: "nextEscrowId" },
  { key: "ClaimLinks", contract: "ClaimLinks", probe: "nextLinkId" },
  { key: "GiftMoney", contract: "GiftMoney", probe: "nextEnvelopeId" },
  { key: "EncryptedCrowdfund", contract: "EncryptedCrowdfund", probe: "nextCampaignId" },
  { key: "CreatorHub", contract: "CreatorHub", probe: "nextTipId" },
  { key: "P2POfframp", contract: "P2POfframp", probe: "nextOfferId" },
  { key: "Storefront", contract: "Storefront", probe: "nextPurchaseId" },
  { key: "EncryptedFlags", contract: "EncryptedFlags" },
  { key: "StealthPayments", contract: "StealthPayments" },
  { key: "InheritanceManager", contract: "InheritanceManager", probe: "CLAIM_RETRY_COOLDOWN" },
];

function loadEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

function deploymentsPath(networkName: string): string {
  if (process.env.DEPLOYMENTS_FILE) {
    if (networkName !== "fork" && networkName !== "localhost") {
      throw new Error("DEPLOYMENTS_FILE is only for fork rehearsals on localhost");
    }
    return resolve(process.env.DEPLOYMENTS_FILE);
  }
  if (!["arb-sepolia", "base-sepolia", "eth-sepolia"].includes(networkName)) {
    throw new Error(`deploy-upgrade-audit-v2: unsupported network ${networkName}`);
  }
  return resolve(__dirname, "..", "deployments", `${networkName}.json`);
}

task("deploy-upgrade-audit-v2", "Ship the CoFHE pre-mainnet checklist fixes through the Safe")
  .addFlag("dryRun", "Print the plan without sending txs")
  .addOptionalParam("only", "Comma-separated step keys to run")
  .setAction(async (args: { dryRun: boolean; only?: string }, hre: HardhatRuntimeEnvironment) => {
    const path = deploymentsPath(hre.network.name);
    const d: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const save = () => writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
    const want = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
    const run = (k: string) => (want ? want.has(k) : true);

    const env = loadEnv(process.env.SAFE_ENV ?? "");
    const safeAddr = hre.ethers.getAddress((env.SAFE_ADDRESS ?? d.Safe ?? "").toLowerCase());
    const [deployer] = await hre.ethers.getSigners();
    console.log(`network=${hre.network.name} deployer=${deployer.address} safe=${safeAddr}`);

    const plan = PLAN.filter((p) => d[p.key] && run(p.key));
    for (const p of PLAN) if (!d[p.key]) console.log(`  (skip ${p.key}: not deployed here)`);
    if (args.dryRun) {
      for (const p of plan) console.log(`[dry-run] upgrade ${p.key} (${p.contract}) proxy=${d[p.key]}`);
      console.log(`[dry-run] Safe: setTrustedBalanceReader(PaymentReceipts) on each vault`);
      return;
    }
    if (!env.SAFE_SIGNER_1_PK || !env.SAFE_SIGNER_2_PK) throw new Error("SAFE_ENV must hold SAFE_SIGNER_1_PK and SAFE_SIGNER_2_PK");

    const safe = new hre.ethers.Contract(safeAddr, [
      "function nonce() view returns (uint256)",
      "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
      "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
      "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
    ], deployer);
    // A fork enforces the 16.7M per-tx cap while estimating against a 60M block limit.
    const isFork = hre.network.name === "fork" || hre.network.name === "localhost";
    const ov = isFork ? { gasLimit: 15_000_000 } : {};
    const Z = hre.ethers.ZeroAddress;
    const signers = [env.SAFE_SIGNER_1_PK, env.SAFE_SIGNER_2_PK].map((k) => new hre.ethers.Wallet(k));
    signers.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));

    const exec = async (to: string, data: string, label: string) => {
      const nonce = await safe.nonce();
      const txHash: string = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, Z, Z, nonce);
      const sigs = hre.ethers.concat(signers.map((w) => w.signingKey.sign(txHash).serialized));
      const tx = await safe.execTransaction(to, 0, data, 0, 0, 0, 0, Z, Z, sigs, ov);
      const rcpt = await tx.wait(isFork ? 1 : 2);
      const topic = safe.interface.getEvent("ExecutionSuccess")!.topicHash;
      const ok = rcpt!.logs.some((l: { topics: string[] }) => l.topics[0] === topic);
      if (!ok) throw new Error(`Safe tx FAILED: ${label} (${tx.hash})`);
      console.log(`   Safe 2-of-3 ${label} tx=${tx.hash}`);
    };

    for (const p of plan) {
      const implKey = `${p.key}_Impl_audit_v2`;
      if (d[implKey]) {
        console.log(`\n── ${p.key} already upgraded (${d[implKey]})`);
        continue;
      }
      console.log(`\n── upgrade ${p.key} (${p.contract})`);
      const proxy = await hre.ethers.getContractAt(p.contract, d[p.key], deployer);
      const owner: string = await proxy.owner();
      if (owner.toLowerCase() !== safeAddr.toLowerCase()) throw new Error(`${p.key}: owner ${owner} is not the Safe`);

      const factory = await hre.ethers.getContractFactory(p.contract, deployer);
      const impl = await factory.deploy(ov);
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();
      console.log(`   implementation ${implAddr}`);

      await exec(d[p.key], proxy.interface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]), `upgradeToAndCall ${p.key}`);
      d[implKey] = implAddr;
      save();

      if (p.probe) {
        const after = await hre.ethers.getContractAt(p.contract, d[p.key], deployer);
        const v = await (after as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[p.probe](...(p.probeArgs ?? []));
        console.log(`   probe ${p.probe}() = ${String(v)}`);
      }
    }

    // The receipts contract may read a balance only if the vault owner trusts it.
    if (run("trust-readers") && d.PaymentReceipts) {
      console.log(`\n── trust PaymentReceipts as a balance reader`);
      for (const key of Object.keys(d).filter((k) => /^FHERC20Vault_[A-Z]+$/.test(k))) {
        const vault = await hre.ethers.getContractAt("FHERC20Vault", d[key], deployer);
        if (await vault.trustedBalanceReaders(d.PaymentReceipts)) {
          console.log(`   ${key} already trusts it`);
          continue;
        }
        await exec(d[key], vault.interface.encodeFunctionData("setTrustedBalanceReader", [d.PaymentReceipts, true]), `${key}.setTrustedBalanceReader`);
      }
    }
    console.log("\naudit-v2 upgrade complete");
  });
