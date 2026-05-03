// Verify post-upgrade state: read each proxy's current implementation
// slot (EIP-1967) and compare to what's stored in deployments/<chain>.json.
//
// Run with: pnpm exec hardhat run scripts/verify-upgrade.js --network <chain>

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// EIP-1967 implementation slot
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CONTRACTS = [
  { name: "BusinessHub",     deployKey: "BusinessHub" },
  { name: "CreatorHub",      deployKey: "CreatorHub" },
  { name: "EncryptedFlags",  deployKey: "EncryptedFlags" },
  { name: "FHERC20Vault",    deployKey: "FHERC20Vault_USDC", aliasKey: "FHERC20Vault_USDT" },
  { name: "GiftMoney",       deployKey: "GiftMoney" },
  { name: "GroupManager",    deployKey: "GroupManager" },
  { name: "P2PExchange",     deployKey: "P2PExchange" },
  { name: "PaymentHub",      deployKey: "PaymentHub" },
  { name: "StealthPayments", deployKey: "StealthPayments" },
];

async function main() {
  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  const addresses = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  console.log(`Verifying ${network} post-upgrade impl pointers\n`);

  let allMatch = true;

  for (const { name, deployKey, aliasKey } of CONTRACTS) {
    const proxy = addresses[deployKey];
    const expectedImpl = addresses[`${deployKey}_Impl`];
    if (!proxy || proxy === "0x0000000000000000000000000000000000000000") {
      console.log(`SKIP  ${name.padEnd(20)} (not deployed)`);
      continue;
    }

    const slot = await hre.ethers.provider.getStorage(proxy, IMPL_SLOT);
    const actualImpl = "0x" + slot.slice(-40);

    const match = actualImpl.toLowerCase() === (expectedImpl || "").toLowerCase();
    const status = match ? "OK  " : "MISMATCH";
    console.log(`${status}  ${name.padEnd(20)} proxy=${proxy.slice(0, 10)}.. impl=${actualImpl}`);
    if (!match) {
      console.log(`     expected: ${expectedImpl}`);
      allMatch = false;
    }

    if (aliasKey && addresses[aliasKey] && addresses[aliasKey] !== "0x0000000000000000000000000000000000000000") {
      const aliasProxy = addresses[aliasKey];
      const aliasSlot = await hre.ethers.provider.getStorage(aliasProxy, IMPL_SLOT);
      const aliasImpl = "0x" + aliasSlot.slice(-40);
      const aliasMatch = aliasImpl.toLowerCase() === (expectedImpl || "").toLowerCase();
      const aliasStatus = aliasMatch ? "OK  " : "MISMATCH";
      console.log(`${aliasStatus}  ${(name + " (" + aliasKey + ")").padEnd(20)} proxy=${aliasProxy.slice(0, 10)}.. impl=${aliasImpl}`);
      if (!aliasMatch) allMatch = false;
    }
  }

  console.log(`\n${allMatch ? "✓ all proxies point at expected impls" : "✗ at least one proxy does NOT match expected impl"}`);
  if (!allMatch) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
