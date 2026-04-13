import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── setup-aa — wire paymaster + EntryPoint after deploy ─────────────────
//
// Run this AFTER deploy-aa lands the BlankAccountFactory + BlankPaymaster.
// It does the post-deploy configuration that turns those raw contracts into
// a working sponsorship system:
//
//   1. paymaster.setApprovedTarget(...) for every Blank hub the user
//      should be allowed to call from a smart account. Restricts the
//      paymaster's sponsorship surface so anyone can't drain it by aiming
//      UserOps at random contracts.
//
//   2. entryPoint.depositTo(paymaster, value) — the paymaster's ETH stake
//      that EntryPoint draws from to refund the bundler/relayer for gas.
//      Without this, every UserOp reverts with "AA31 paymaster deposit too low".
//
// Defaults: 0.05 ETH deposit (testnet sponsorship — adjust via DEPOSIT env var).
// Both ops are idempotent (setApprovedTarget short-circuits if already set;
// depositTo just adds to the existing balance), so re-running is safe.

const DEFAULT_DEPOSIT_ETH = "0.05";

const ENTRYPOINT_ABI = [
  "function depositTo(address) payable",
  "function balanceOf(address) view returns (uint256)",
];
const PAYMASTER_ABI = [
  "function setApprovedTarget(address target, bool approved)",
  "function approvedTargets(address) view returns (bool)",
  "function approvedTargetsCount() view returns (uint256)",
  "function owner() view returns (address)",
];

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

task("setup-aa", "Whitelist Blank hubs in BlankPaymaster + fund paymaster ETH stake")
  .addOptionalParam("deposit", `ETH to add to paymaster stake (default ${DEFAULT_DEPOSIT_ETH})`, DEFAULT_DEPOSIT_ETH)
  .setAction(async ({ deposit }, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const addresses = loadDeployment(hre.network.name);

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — AA Setup");
    console.log("═══════════════════════════════════════════");
    console.log("  Deployer:  ", deployer.address);
    console.log("  Network:   ", hre.network.name);
    console.log("  Balance:   ", hre.ethers.formatEther(balance), "ETH");
    console.log("  Paymaster: ", addresses.BlankPaymaster);
    console.log("═══════════════════════════════════════════\n");

    if (!addresses.BlankPaymaster || !addresses.EntryPoint) {
      throw new Error("BlankPaymaster / EntryPoint addresses missing — run deploy-aa first");
    }

    const paymaster = new hre.ethers.Contract(
      addresses.BlankPaymaster,
      PAYMASTER_ABI,
      deployer,
    );
    const entryPoint = new hre.ethers.Contract(
      addresses.EntryPoint,
      ENTRYPOINT_ABI,
      deployer,
    );

    // Sanity: deployer must own the paymaster
    const owner = await paymaster.owner();
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`paymaster owner is ${owner}, deployer is ${deployer.address}`);
    }

    // ─── 1. Whitelist Blank hubs as sponsorable targets ────────────────
    // Order matters — most-used hubs first so common UserOps pass cheapest.
    const targets: Array<{ key: string; label: string }> = [
      { key: "FHERC20Vault_USDC", label: "FHERC20Vault (shield/unshield)" },
      { key: "TestUSDC",          label: "TestUSDC (faucet/approve)" },
      { key: "PaymentHub",        label: "PaymentHub" },
      { key: "BusinessHub",       label: "BusinessHub" },
      { key: "GroupManager",      label: "GroupManager" },
      { key: "CreatorHub",        label: "CreatorHub" },
      { key: "P2PExchange",       label: "P2PExchange" },
      { key: "GiftMoney",         label: "GiftMoney" },
      { key: "StealthPayments",   label: "StealthPayments" },
      { key: "InheritanceManager",label: "InheritanceManager" },
      { key: "PrivacyRouter",     label: "PrivacyRouter" },
      { key: "PaymentReceipts",   label: "PaymentReceipts" },
      { key: "EncryptedFlags",    label: "EncryptedFlags" },
    ];

    console.log("1/2  Whitelisting sponsorable targets...\n");
    let approvedCount = 0;
    let alreadyCount = 0;
    for (const t of targets) {
      const addr = addresses[t.key];
      if (!addr) {
        console.log(`     SKIP ${t.label.padEnd(40)} (not deployed on this chain)`);
        continue;
      }
      const already = await paymaster.approvedTargets(addr);
      if (already) {
        console.log(`     OK   ${t.label.padEnd(40)} ${addr} (already approved)`);
        alreadyCount++;
        continue;
      }
      const tx = await paymaster.setApprovedTarget(addr, true);
      await tx.wait(2); // 2 confirmations — avoids public-RPC nonce-race on Base Sepolia
      console.log(`     ✓    ${t.label.padEnd(40)} ${addr}`);
      approvedCount++;
    }
    console.log(`\n     ${approvedCount} new, ${alreadyCount} already approved.`);

    // ─── 2. Fund paymaster ETH stake at EntryPoint ─────────────────────
    console.log("\n2/2  Topping up paymaster ETH stake...");
    const before = (await entryPoint.balanceOf(addresses.BlankPaymaster)) as bigint;
    console.log("     Current stake:", hre.ethers.formatEther(before), "ETH");

    const depositEth = hre.ethers.parseEther(String(deposit));
    if (balance < depositEth + hre.ethers.parseEther("0.005")) {
      throw new Error(`insufficient deployer balance for ${deposit} ETH deposit + safety margin`);
    }

    const tx = await entryPoint.depositTo(addresses.BlankPaymaster, { value: depositEth });
    await tx.wait(1);
    const after = (await entryPoint.balanceOf(addresses.BlankPaymaster)) as bigint;
    console.log("     Deposited:    ", hre.ethers.formatEther(depositEth), "ETH");
    console.log("     New stake:    ", hre.ethers.formatEther(after), "ETH");
    console.log("     Tx:           ", tx.hash);

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  AA Setup Complete");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Paymaster sponsorship is live for ${approvedCount + alreadyCount} Blank contracts.`);
    console.log(`  Stake covers ~${Math.floor(Number(hre.ethers.formatEther(after)) / 0.001)} typical UserOps`);
    console.log(`  (rough: 0.001 ETH per FHE-heavy tx at testnet gas).\n`);
  });
