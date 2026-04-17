import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * fund-paymaster — top up BlankPaymaster's stake in the EntryPoint so
 * it can sponsor UserOps. Fails closed with a revert-like "transaction
 * execution reverted" message otherwise, which looks cryptic from the
 * frontend.
 *
 * Run once per chain after deployment, and any time the stake drops
 * below ~0.05 ETH. Each UserOp with initCode pre-charges the paymaster
 * roughly 0.007–0.01 ETH at 1 gwei; a 0.05 ETH top-up sponsors ~5–7
 * first-time passkey deployments on Sepolia.
 *
 * Usage:
 *   npx hardhat fund-paymaster --network eth-sepolia --amount 0.05
 *   npx hardhat fund-paymaster --network base-sepolia --amount 0.05
 *
 * Caller must be the deployer (or any address with enough ETH; the
 * EntryPoint's depositTo accepts any payer). Defaults to 0.05 ETH.
 */
task("fund-paymaster", "Deposit ETH into EntryPoint on behalf of BlankPaymaster")
  .addOptionalParam("amount", "ETH amount to deposit (default 0.05)", "0.05")
  .setAction(async ({ amount }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      null;
    if (!deploymentFile) {
      throw new Error(`Unknown network "${networkName}" — expected eth-sepolia or base-sepolia.`);
    }

    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const entryPointAddr = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
    const paymasterAddr = deployments.BlankPaymaster;
    if (!paymasterAddr) {
      throw new Error(`BlankPaymaster not found in ${deploymentFile}`);
    }

    const [signer] = await hre.ethers.getSigners();
    console.log(`Network:    ${networkName}`);
    console.log(`Signer:     ${signer.address}`);
    console.log(`Paymaster:  ${paymasterAddr}`);
    console.log(`EntryPoint: ${entryPointAddr}`);

    const entryPoint = new hre.ethers.Contract(
      entryPointAddr,
      [
        "function depositTo(address account) external payable",
        "function balanceOf(address account) external view returns (uint256)",
      ],
      signer,
    );

    const balBefore = await entryPoint.balanceOf(paymasterAddr);
    console.log(`\nBefore: paymaster EP deposit = ${hre.ethers.formatEther(balBefore)} ETH`);

    const value = hre.ethers.parseEther(amount);
    const signerBal = await hre.ethers.provider.getBalance(signer.address);
    if (signerBal < value + hre.ethers.parseEther("0.001")) {
      throw new Error(
        `Signer only has ${hre.ethers.formatEther(signerBal)} ETH — not enough to deposit ${amount} plus gas.`,
      );
    }

    console.log(`\nDepositing ${amount} ETH into EntryPoint for paymaster...`);
    const tx = await entryPoint.depositTo(paymasterAddr, { value });
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();

    const balAfter = await entryPoint.balanceOf(paymasterAddr);
    console.log(`\nAfter:  paymaster EP deposit = ${hre.ethers.formatEther(balAfter)} ETH`);
    console.log(`Delta:  +${hre.ethers.formatEther(balAfter - balBefore)} ETH`);
    console.log(`\nDone. Try your passkey faucet again.`);
  });
