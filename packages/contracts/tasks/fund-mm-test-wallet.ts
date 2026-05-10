import { task } from "hardhat/config";
import { mnemonicToAccount } from "viem/accounts";
import { generateMnemonic, english } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Wave 4 E2E support — provision a fresh test wallet and fund it from the
 * deployer for MetaMask-driven E2E tests.
 *
 * Behavior:
 *   - On first run: generates a fresh mnemonic, derives address[0], saves
 *     `e2e-test-wallet.json` next to deployments/ for re-use.
 *   - On subsequent runs: re-loads the saved wallet, just tops it up.
 *   - Sends 0.005 ETH + 200 TestUSDC to the test wallet.
 *
 * Why fresh wallet (not deployer):
 *   The deployer's PRIVATE_KEY in .env is a real funded wallet on multiple
 *   chains. Importing it into a MetaMask Playwright session would expose
 *   it through extension storage / session artifacts. Using a throwaway
 *   keeps the deployer's key off any test surface.
 *
 * IMPORTANT (operators): the wallet file written here contains a real
 *   testnet mnemonic + private key. It is gitignored at
 *   packages/contracts/.gitignore. Never reuse this address for production,
 *   never commit the file, never share the mnemonic. If the file ever
 *   appears in git history, drain testnet funds and regenerate immediately.
 */
task("fund-mm-test-wallet", "Generate (or reuse) a test wallet and fund it from the deployer")
  .setAction(async (_args, hre) => {
    const networkName = hre.network.name;
    const isBase = networkName === "base-sepolia";
    if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
      throw new Error(`unsupported network ${networkName}`);
    }

    const walletPath = resolve(__dirname, "..", "deployments", "e2e-test-wallet.json");
    let mnemonic: string;
    let address: `0x${string}`;
    let privateKey: `0x${string}`;

    if (existsSync(walletPath)) {
      const existing = JSON.parse(readFileSync(walletPath, "utf8"));
      mnemonic = existing.mnemonic;
      address = existing.address;
      privateKey = existing.privateKey;
      console.log(`[mm-wallet] Reusing test wallet at ${walletPath}`);
    } else {
      mnemonic = generateMnemonic(english);
      const acct = mnemonicToAccount(mnemonic);
      address = acct.address;
      // Derive PK from the mnemonic for MM "import account" flow if needed.
      // We can't directly export the PK from the viem account, but the
      // mnemonic alone is enough for MM (Import Wallet flow).
      privateKey = "0x" + Buffer.from(acct.getHdKey().privateKey!).toString("hex") as `0x${string}`;
      writeFileSync(walletPath, JSON.stringify({ mnemonic, address, privateKey, createdAt: new Date().toISOString() }, null, 2));
      console.log(`[mm-wallet] Generated NEW test wallet`);
      console.log(`[mm-wallet] Saved to ${walletPath}`);
    }

    console.log(`[mm-wallet] Address: ${address}`);
    console.log(`[mm-wallet] Network: ${networkName}`);

    // Read deployments to find TestUSDC.
    const deploymentFile = isBase ? "base-sepolia.json" : "eth-sepolia.json";
    const deploymentPath = resolve(__dirname, "..", "deployments", deploymentFile);
    const deployments = JSON.parse(readFileSync(deploymentPath, "utf8"));
    const testUSDC = deployments.TestUSDC;
    if (!testUSDC) throw new Error(`TestUSDC missing in ${deploymentFile}`);

    const [deployer] = await hre.ethers.getSigners();
    const deployerBalance = await hre.ethers.provider.getBalance(deployer.address);
    console.log(`[mm-wallet] Deployer: ${deployer.address}`);
    console.log(`[mm-wallet] Deployer balance: ${hre.ethers.formatEther(deployerBalance)} ETH`);

    // Send 0.005 ETH for gas if test wallet is below 0.003 ETH.
    const testBalance = await hre.ethers.provider.getBalance(address);
    console.log(`[mm-wallet] Current test balance: ${hre.ethers.formatEther(testBalance)} ETH`);
    if (testBalance < hre.ethers.parseEther("0.003")) {
      const tx = await deployer.sendTransaction({ to: address, value: hre.ethers.parseEther("0.005") });
      console.log(`[mm-wallet] Sending 0.005 ETH... tx: ${tx.hash}`);
      await tx.wait(1);
    } else {
      console.log(`[mm-wallet] Skipping ETH top-up (already has enough)`);
    }

    // Send 200 TestUSDC.
    const usdc = new hre.ethers.Contract(
      testUSDC,
      [
        "function balanceOf(address) view returns (uint256)",
        "function mint(address to, uint256 amount)",
        "function transfer(address to, uint256 amount)",
      ],
      deployer,
    );
    const usdcBalance = await usdc.balanceOf(address);
    console.log(`[mm-wallet] Current test USDC: ${hre.ethers.formatUnits(usdcBalance, 6)} USDC`);
    if (usdcBalance < hre.ethers.parseUnits("100", 6)) {
      // Mint to deployer first if needed (some chains have public mint), then transfer.
      try {
        const mintTx = await usdc.mint(address, hre.ethers.parseUnits("200", 6));
        console.log(`[mm-wallet] Minting 200 USDC directly to test wallet... tx: ${mintTx.hash}`);
        await mintTx.wait(1);
      } catch (err) {
        // Fallback: if mint reverted (e.g., not callable), transfer from deployer.
        console.log(`[mm-wallet] Direct mint failed (${err instanceof Error ? err.message.slice(0, 60) : "?"}). Transferring from deployer...`);
        const tx = await usdc.transfer(address, hre.ethers.parseUnits("200", 6));
        console.log(`[mm-wallet] tx: ${tx.hash}`);
        await tx.wait(1);
      }
    } else {
      console.log(`[mm-wallet] Skipping USDC top-up (already has enough)`);
    }

    console.log(`\n══════════════════════════════════════`);
    console.log(`  Test wallet ready`);
    console.log(`══════════════════════════════════════`);
    console.log(`  Address:    ${address}`);
    console.log(`  Network:    ${networkName}`);
    console.log(`  Mnemonic:   (in deployments/e2e-test-wallet.json)`);
    console.log(`  ETH:        ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(address))}`);
    console.log(`  USDC:       ${hre.ethers.formatUnits(await usdc.balanceOf(address), 6)}`);
    console.log(`══════════════════════════════════════\n`);
  });
