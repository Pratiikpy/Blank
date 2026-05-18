import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * wire-paymaster-targets — audit + fix BlankPaymaster.approvedTargets so
 * AA UserOps for all top-level Blank contracts (not just PaymentHub)
 * pass the paymaster's whitelist check.
 *
 * Identified during the Wave 4 audit run: P2 sendPayment (PaymentHub)
 * works through the AA-paymaster path, but P3 createInvoice
 * (BusinessHub), P4 createEscrow (BusinessHub), P19 setHeir
 * (InheritanceManager), P20 createGift (GiftMoney), and P8 upgrade
 * (BlankAccount self-call) all fail. Page snapshots confirm the on-
 * chain state never advances. Paymaster's `setApprovedTarget` is the
 * only allowlist gate that fits the symptom: PaymentHub is sponsored
 * but the newer hubs were never added.
 *
 * --dry-run  -> just print which targets are missing
 * (default)  -> submit one tx per missing target
 *
 * Usage:
 *   npx hardhat wire-paymaster-targets --network eth-sepolia --dry-run
 *   npx hardhat wire-paymaster-targets --network eth-sepolia
 *   npx hardhat wire-paymaster-targets --network base-sepolia
 *
 * Caller MUST be the paymaster owner (typically the deployer).
 */

const PAYMASTER_ABI = [
  "function approvedTargets(address) external view returns (bool)",
  "function setApprovedTarget(address target, bool approved) external",
  "function owner() external view returns (address)",
  "function approvedTargetsCount() external view returns (uint256)",
];

// Contracts that frontend AA UserOps will target. Pulled from the
// recordProof matrix in proof-gap-audit.ts so it stays in sync with
// what wave4 tests exercise.
const TARGETED_CONTRACTS = [
  "PaymentHub",
  "FHERC20Vault_USDC",
  "BusinessHub",
  "GroupManager",
  "CreatorHub",
  "P2PExchange",
  "InheritanceManager",
  "GiftMoney",
  "PrivacyRouter",
  "StealthPayments",
  "EncryptedFlags",
  "PaymentReceipts",
];

task(
  "wire-paymaster-targets",
  "Audit + fix BlankPaymaster.approvedTargets allowlist",
)
  .addFlag("dryRun", "Skip on-chain writes; just report missing approvals")
  .setAction(async ({ dryRun }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia"
        ? "base-sepolia.json"
        : networkName === "eth-sepolia"
        ? "eth-sepolia.json"
        : null;
    if (!deploymentFile) {
      throw new Error(
        `Unknown network "${networkName}" — expected eth-sepolia or base-sepolia.`,
      );
    }

    const deployments = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "deployments", deploymentFile),
        "utf8",
      ),
    ) as Record<string, string>;

    const paymasterAddr = deployments.BlankPaymaster;
    if (!paymasterAddr) {
      throw new Error(`BlankPaymaster not found in ${deploymentFile}`);
    }

    const [signer] = await hre.ethers.getSigners();
    const paymaster = new hre.ethers.Contract(
      paymasterAddr,
      PAYMASTER_ABI,
      signer,
    );

    const owner = await paymaster.owner();
    console.log(`Network:           ${networkName}`);
    console.log(`Paymaster:         ${paymasterAddr}`);
    console.log(`Paymaster owner:   ${owner}`);
    console.log(`Signer:            ${signer.address}`);
    console.log(
      `Approved count:    ${await paymaster.approvedTargetsCount()}`,
    );
    console.log("");

    // Audit phase — read current approval state.
    const missing: { name: string; addr: string }[] = [];
    const present: { name: string; addr: string }[] = [];
    for (const name of TARGETED_CONTRACTS) {
      const addr = deployments[name];
      if (!addr) {
        console.warn(
          `  skip:    ${name} (not in deployments JSON for ${networkName})`,
        );
        continue;
      }
      const approved: boolean = await paymaster.approvedTargets(addr);
      if (approved) {
        present.push({ name, addr });
        console.log(`  ok:      ${name.padEnd(20)} ${addr}`);
      } else {
        missing.push({ name, addr });
        console.log(`  missing: ${name.padEnd(20)} ${addr}`);
      }
    }

    console.log("");
    console.log(
      `Summary: ${present.length} approved, ${missing.length} missing.`,
    );

    if (missing.length === 0) {
      console.log("Nothing to do — all targeted contracts are approved.");
      return;
    }

    if (dryRun) {
      console.log("");
      console.log("--dry-run: no on-chain writes.");
      console.log("Re-run without --dry-run to submit setApprovedTarget txs.");
      return;
    }

    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(
        `Signer ${signer.address} is not the paymaster owner ${owner}.`,
      );
    }

    console.log("");
    console.log(`Submitting ${missing.length} setApprovedTarget txs...`);
    for (const { name, addr } of missing) {
      const tx = await paymaster.setApprovedTarget(addr, true);
      console.log(`  ${name.padEnd(20)} -> tx ${tx.hash}`);
      await tx.wait();
    }
    console.log("Done.");
    console.log(
      `New approved count: ${await paymaster.approvedTargetsCount()}`,
    );
  });
