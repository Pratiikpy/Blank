import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";

// One-shot: shield N USDC from the deployer EOA into the FHERC20Vault on the
// chosen testnet. Does what the Blank app's shield button does, minus the
// passkey/ERC-4337 wrapper. Good for sanity-checking that the vault is live
// and the shield codepath hasn't regressed after a contract upgrade.
//
// Usage:
//   npx hardhat shield-from-deployer --network eth-sepolia --amount 33
task("shield-from-deployer", "Approve + shield N USDC from the deployer EOA")
  .addOptionalParam("amount", "USDC amount (human units, default 33)", "33")
  .setAction(async ({ amount }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      null;
    if (!deploymentFile) {
      throw new Error(`Unknown network "${networkName}" — use eth-sepolia or base-sepolia.`);
    }

    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const usdcAddr = deployments.TestUSDC;
    const vaultAddr = deployments.FHERC20Vault_USDC;
    if (!usdcAddr || !vaultAddr) {
      throw new Error(`Missing TestUSDC or FHERC20Vault_USDC in ${deploymentFile}`);
    }

    const [signer] = await hre.ethers.getSigners();
    const amountWei = hre.ethers.parseUnits(amount, 6);

    console.log(`Network:    ${networkName}`);
    console.log(`Signer:     ${signer.address}`);
    console.log(`USDC:       ${usdcAddr}`);
    console.log(`Vault:      ${vaultAddr}`);
    console.log(`Amount:     ${amount} USDC (${amountWei.toString()} units)`);

    const usdc = new hre.ethers.Contract(
      usdcAddr,
      [
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function mint(address,uint256)",
      ],
      signer,
    );
    const vault = new hre.ethers.Contract(
      vaultAddr,
      ["function shield(uint256)"],
      signer,
    );

    const ethBal = await hre.ethers.provider.getBalance(signer.address);
    const usdcBal: bigint = await usdc.balanceOf(signer.address);
    console.log(`\nSigner ETH: ${hre.ethers.formatEther(ethBal)}`);
    console.log(`Signer USDC: ${hre.ethers.formatUnits(usdcBal, 6)}`);

    if (usdcBal < amountWei) {
      const shortfall = amountWei - usdcBal;
      console.log(`\nShort ${hre.ethers.formatUnits(shortfall, 6)} USDC — minting from faucet...`);
      const mintTx = await usdc.mint(signer.address, shortfall);
      console.log(`  mint tx: ${mintTx.hash}`);
      await mintTx.wait();
    }

    console.log(`\nApproving vault to pull ${amount} USDC...`);
    const approveTx = await usdc.approve(vaultAddr, amountWei);
    console.log(`  approve tx: ${approveTx.hash}`);
    await approveTx.wait();

    console.log(`\nShielding ${amount} USDC...`);
    const shieldTx = await vault.shield(amountWei);
    console.log(`  shield tx: ${shieldTx.hash}`);
    const receipt = await shieldTx.wait();

    if (receipt?.status !== 1) {
      throw new Error(`Shield reverted — tx ${shieldTx.hash}`);
    }

    const usdcBalAfter: bigint = await usdc.balanceOf(signer.address);
    console.log(`\nDone. Signer USDC now: ${hre.ethers.formatUnits(usdcBalAfter, 6)}`);
    console.log(`Etherscan: https://sepolia.etherscan.io/tx/${shieldTx.hash}`);
    console.log(`\nBalance in vault is encrypted (ciphertext handle). To verify, open the Blank app with this EOA connected — it will prompt permit creation and decrypt the balance.`);
  });
