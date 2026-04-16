import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// ─── setup-mockdex — wire MockDEX rates for PrivacyRouter swaps ──────────
//
// MockDEX needs an exchange-rate pair set before any PrivacyRouter swap
// can settle. The pair is (TestUSDC ↔ a synthetic WETH placeholder) since
// MockDEX rejects same-token swaps.
//
// We use TestUSDC's own contract address as the "WETH" placeholder for
// testnet — there's no real WETH on Sepolia anyway, and the only thing
// that matters is the routing math. Real swaps won't move tokens because
// PrivacyRouter holds reserves it manages internally.
//
// Skipped on first deploy (deploy-new-features had a bug — wrong arg
// count — so MockDEX rate was never set on Base Sepolia).
//
// Rate convention: rate × 10^-6 = output / input. So rate = 1_000_000
// means 1:1, rate = 500_000 means 1 input → 0.5 output, etc.

const SYNTHETIC_WETH_PLACEHOLDER = "0x0000000000000000000000000000000000000001";

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

task("setup-mockdex", "Set MockDEX exchange rates so PrivacyRouter swaps work").setAction(
  async (_, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const addresses = loadDeployment(hre.network.name);
    if (!addresses.MockDEX || addresses.MockDEX === "0x0000000000000000000000000000000000000000") {
      throw new Error("MockDEX not deployed on this chain");
    }
    if (!addresses.TestUSDC) throw new Error("TestUSDC missing from deployment file");

    console.log("═══════════════════════════════════════════");
    console.log("  Blank — MockDEX Setup");
    console.log("═══════════════════════════════════════════");
    console.log("  Network:           ", hre.network.name);
    console.log("  MockDEX:           ", addresses.MockDEX);
    console.log("  TestUSDC:          ", addresses.TestUSDC);
    console.log("  Synthetic WETH ptr:", SYNTHETIC_WETH_PLACEHOLDER);
    console.log("═══════════════════════════════════════════\n");

    const mockDex = new hre.ethers.Contract(
      addresses.MockDEX,
      [
        "function setRateBidirectional(address,address,uint256,uint256) external",
        "function exchangeRates(address,address) view returns (uint256)",
        "function owner() view returns (address)",
      ],
      deployer,
    );

    const owner = await mockDex.owner();
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`MockDEX owner is ${owner}, deployer is ${deployer.address}`);
    }

    // Skip if rates already set
    const forwardExisting = (await mockDex.exchangeRates(
      addresses.TestUSDC,
      SYNTHETIC_WETH_PLACEHOLDER,
    )) as bigint;
    if (forwardExisting > 0n) {
      console.log(`Rates already set (forward = ${forwardExisting}). Skipping.\n`);
      return;
    }

    // 1 USDC → 0.0004 WETH (forward = 400, since rate is scaled by 1e6 and 0.0004 * 1e6 = 400)
    // 1 WETH → 2500 USDC (reverse = 2_500_000_000)
    // These match the rough $2500/ETH price as of writing — adjust if needed.
    const FORWARD_RATE = 400n;             // USDC → WETH
    const REVERSE_RATE = 2_500_000_000n;   // WETH → USDC

    console.log("Setting bidirectional rate (USDC ↔ WETH placeholder)...");
    const tx = await mockDex.setRateBidirectional(
      addresses.TestUSDC,
      SYNTHETIC_WETH_PLACEHOLDER,
      FORWARD_RATE,
      REVERSE_RATE,
    );
    await tx.wait(2);

    console.log(`  ✓ USDC → WETH rate: ${FORWARD_RATE} (1 USDC ≈ 0.0004 WETH)`);
    console.log(`  ✓ WETH → USDC rate: ${REVERSE_RATE} (1 WETH ≈ 2500 USDC)`);
    console.log(`  Tx: ${tx.hash}\n`);

    console.log("MockDEX is now ready for PrivacyRouter swap settlement.");
  }
);
