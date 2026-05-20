import { task } from "hardhat/config";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Shield USDC into the FHE vault for the MM test wallet (signs with the
 * test wallet's PK, NOT the deployer). Run once per chain so the test
 * wallet has shielded balance to spend in claim-link / storefront flows.
 */
task("shield-mm-test-wallet", "Approve + shield USDC for the MM test wallet")
  .addOptionalParam("amount", "USDC amount (default 100)", "100")
  .setAction(async ({ amount }, hre) => {
    const networkName = hre.network.name;
    if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
      throw new Error(`unsupported ${networkName}`);
    }
    const walletPath = resolve(__dirname, "..", "deployments", "e2e-test-wallet.json");
    if (!existsSync(walletPath)) {
      throw new Error("Test wallet not found. Run `pnpm hardhat fund-mm-test-wallet` first.");
    }
    const w = JSON.parse(readFileSync(walletPath, "utf8"));

    const deploymentFile = networkName === "base-sepolia" ? "base-sepolia.json" : "eth-sepolia.json";
    const deployments = JSON.parse(readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"));
    const usdcAddr = deployments.TestUSDC;
    const vaultAddr = deployments.FHERC20Vault_USDC;

    // Use the test wallet's PK to sign.
    const provider = hre.ethers.provider;
    const wallet = new hre.ethers.Wallet(w.privateKey, provider);

    console.log(`[shield-mm] network=${networkName} signer=${wallet.address}`);
    console.log(`[shield-mm] USDC=${usdcAddr} vault=${vaultAddr}`);

    const amountUnits = hre.ethers.parseUnits(amount, 6);
    const usdc = new hre.ethers.Contract(
      usdcAddr,
      [
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
      ],
      wallet,
    );
    const vault = new hre.ethers.Contract(
      vaultAddr,
      ["function shield(uint256 amount)"],
      wallet,
    );

    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log(`[shield-mm] USDC balance: ${hre.ethers.formatUnits(usdcBal, 6)}`);
    if (usdcBal < amountUnits) {
      throw new Error(`Insufficient USDC. Need ${amount}, have ${hre.ethers.formatUnits(usdcBal, 6)}`);
    }

    // Approve vault for the amount.
    const allowance = await usdc.allowance(wallet.address, vaultAddr);
    if (allowance < amountUnits) {
      console.log(`[shield-mm] approving vault for ${amount} USDC...`);
      const tx = await usdc.approve(vaultAddr, amountUnits);
      await tx.wait(1);
      console.log(`[shield-mm]   tx: ${tx.hash}`);
    } else {
      console.log("[shield-mm] approval already sufficient");
    }

    console.log(`[shield-mm] shielding ${amount} USDC...`);
    const shieldTx = await vault.shield(amountUnits);
    await shieldTx.wait(1);
    console.log(`[shield-mm]   tx: ${shieldTx.hash}`);

    console.log(`\n✓ Shielded ${amount} USDC into the vault for ${wallet.address}`);
  });
