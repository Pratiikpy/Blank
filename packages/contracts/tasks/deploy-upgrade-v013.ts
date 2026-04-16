import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── v0.1.3 upgrade task ──────────────────────────────────────────────
// All storage layouts are unchanged from v0.1.0 — function signatures and
// internal behavior changed, but no struct/storage was modified. So every
// affected contract is a UUPS upgrade in place: deploy a new impl, point
// the existing proxy at it. Same proxy addresses → frontend constants and
// Supabase data are preserved.
//
// Affected contracts:
//   - FHERC20Vault_USDC (claimUnshield + pendingUnshield)
//   - BusinessHub (payInvoiceFinalize + getInvoiceValidationHandle)
//   - P2PExchange (publishTradeValidation + getValidationHandle + bool getTradeValidation)
//   - PrivacyRouter (executeSwap/claimCancelledSwap/claimExpiredSwap signatures)
//   - StealthPayments (finalizeClaim + getPendingClaimHandle)
// Unchanged: TokenRegistry, EventHub, PaymentHub, GroupManager, CreatorHub,
//            InheritanceManager, GiftMoney, MockDEX, PaymentReceipts, EncryptedFlags

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDeployment(network: string, addresses: Record<string, string>) {
  const dir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(dir, `${network}.json`);
  fs.writeFileSync(filePath, JSON.stringify(addresses, null, 2));
  console.log(`\nDeployment updated: ${filePath}`);
}

async function upgradeInPlace(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  proxyAddress: string,
): Promise<string> {
  console.log(`     proxy:`, proxyAddress);
  const Factory = await hre.ethers.getContractFactory(contractName);
  const newImpl = await Factory.deploy();
  await newImpl.deploymentTransaction()?.wait(2);
  const newImplAddress = await newImpl.getAddress();
  console.log(`     new impl:`, newImplAddress);

  const proxy = Factory.attach(proxyAddress);
  // upgradeToAndCall("0x") — empty calldata = no re-init, just swap impl
  const tx = await (proxy as any).upgradeToAndCall(newImplAddress, "0x");
  await tx.wait(2);
  console.log(`     ✓ proxy upgraded`);
  return newImplAddress;
}

task("deploy-upgrade-v013", "Upgrade FHE contracts in-place to cofhe v0.1.3 (UUPS)").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — v0.1.3 In-Place Upgrade");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:", deployer.address);
    console.log("  Network: ", hre.network.name);
    console.log("  Balance: ", hre.ethers.formatEther(balance), "ETH");
    console.log("═══════════════════════════════════════════\n");

    // Filter via env var: ONLY=PrivacyRouter,StealthPayments (case-sensitive contract names)
    const onlyEnv = process.env.ONLY;
    const onlyFilter = onlyEnv ? new Set(onlyEnv.split(",").map(s => s.trim())) : null;

    const all: Array<{ name: string; key: string; required: boolean }> = [
      { name: "FHERC20Vault",     key: "FHERC20Vault_USDC", required: true  },
      { name: "BusinessHub",      key: "BusinessHub",       required: true  },
      { name: "P2PExchange",      key: "P2PExchange",       required: true  },
      { name: "PrivacyRouter",    key: "PrivacyRouter",     required: false },
      { name: "StealthPayments",  key: "StealthPayments",   required: false },
      { name: "PaymentReceipts",  key: "PaymentReceipts",   required: false },
      { name: "PaymentHub",       key: "PaymentHub",        required: false },
    ];
    const upgrades = onlyFilter ? all.filter(u => onlyFilter.has(u.name)) : all;

    let i = 0;
    for (const u of upgrades) {
      i++;
      const proxy = addresses[u.key];
      if (!proxy) {
        if (u.required) {
          throw new Error(`Missing proxy address for ${u.key} in deployment file`);
        }
        console.log(`${i}/${upgrades.length}  ${u.name}: skipped (proxy not deployed yet)`);
        continue;
      }
      console.log(`\n${i}/${upgrades.length}  Upgrading ${u.name}...`);
      const newImpl = await upgradeInPlace(hre, u.name, proxy);
      addresses[`${u.key}_Impl`] = newImpl;
    }

    saveDeployment(hre.network.name, addresses);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  v0.1.3 Upgrade Complete — proxy addresses unchanged");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  No constants.ts update required.");
    console.log("  Supabase data preserved (no schema/address change).\n");
  }
);
