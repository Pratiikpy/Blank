import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { sepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

// One-shot: send N encrypted USDC from the deployer's vault balance to a
// recipient via PaymentHub.sendPayment, using the hardhat-cofhe plugin to
// encrypt the amount against the testnet's threshold network.
//
// Mirrors what the Blank app's Send screen does end-to-end — permit, encrypt,
// approve, sendPayment — minus the passkey/UI layer. Useful for verifying a
// live prod deployment without a browser.
//
// Usage:
//   npx hardhat send-from-deployer --network eth-sepolia --to 0xe... --amount 33 --note "test"
task("send-from-deployer", "Send N encrypted USDC from the deployer via PaymentHub")
  .addParam("to", "Recipient address (0x...)")
  .addOptionalParam("amount", "USDC amount (human units, default 33)", "33")
  .addOptionalParam("note", "Memo (default empty)", "")
  .setAction(async ({ to, amount, note }, hre) => {
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

    const vaultAddr = deployments.FHERC20Vault_USDC;
    const hubAddr = deployments.PaymentHub;
    if (!vaultAddr || !hubAddr) {
      throw new Error(`Missing FHERC20Vault_USDC or PaymentHub in ${deploymentFile}`);
    }
    if (!hre.ethers.isAddress(to)) {
      throw new Error(`--to must be a valid address, got "${to}"`);
    }

    const [signer] = await hre.ethers.getSigners();
    const amountUnits = hre.ethers.parseUnits(amount, 6);

    console.log(`Network:     ${networkName}`);
    console.log(`Sender:      ${signer.address}`);
    console.log(`Recipient:   ${to}`);
    console.log(`Amount:      ${amount} USDC (${amountUnits.toString()} units)`);
    console.log(`Vault:       ${vaultAddr}`);
    console.log(`PaymentHub:  ${hubAddr}`);

    // ── Approve PaymentHub to pull from the deployer's encrypted balance ──
    // Uses approvePlaintext with MAX uint64 so the hub has effectively
    // infinite allowance for this sender (same pattern as the app).
    // FHERC20Vault.approvePlaintext takes uint64. The real allowance is
    // encrypted (euint64) so we can't cheaply read it — approvePlaintext is
    // idempotent and gas-cheap, so just always call it with MAX uint64.
    const vault = new hre.ethers.Contract(
      vaultAddr,
      ["function approvePlaintext(address spender, uint64 amount)"],
      signer,
    );

    const MAX_U64 = (1n << 64n) - 1n;
    console.log(`\nApproving PaymentHub for MAX uint64...`);
    const approveTx = await vault.approvePlaintext(hubAddr, MAX_U64);
    console.log(`  approve tx: ${approveTx.hash}`);
    await approveTx.wait();

    // ── Client-side FHE encryption of the amount ──────────────────────────
    // The hardhat-cofhe plugin's createClientWithBatteries uses
    // hardhat_impersonateAccount which doesn't exist on real Sepolia RPCs,
    // so we bypass it and build a real CoFHE client against the live TN
    // endpoints using viem + the signer's private key directly.
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY env missing");
    const pkHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com";
    const account = privateKeyToAccount(pkHex);
    const publicClient = createPublicClient({ chain: viemSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: viemSepolia, transport: http(rpcUrl) });

    console.log(`\nConnecting CoFHE client to Sepolia TN...`);
    const cofheConfig = createCofheConfig({ supportedChains: [sepolia] });
    const client = createCofheClient(cofheConfig);
    await client.connect(publicClient as any, walletClient as any);

    console.log(`Encrypting ${amount} USDC against the threshold network...`);
    const [encAmount] = await client.encryptInputs([Encryptable.uint64(amountUnits)]).execute();
    console.log(`  encrypted handle: ${encAmount.ctHash}`);

    // ── PaymentHub.sendPayment ────────────────────────────────────────────
    const hub = new hre.ethers.Contract(
      hubAddr,
      [
        "function sendPayment(address to, address token, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encAmount, string note)",
      ],
      signer,
    );

    console.log(`\nSending payment...`);
    const sendTx = await hub.sendPayment(to, vaultAddr, encAmount, note);
    console.log(`  send tx: ${sendTx.hash}`);
    const receipt = await sendTx.wait();

    if (receipt?.status !== 1) {
      throw new Error(`sendPayment reverted — tx ${sendTx.hash}`);
    }

    console.log(`\nDone.`);
    console.log(`Etherscan: https://sepolia.etherscan.io/tx/${sendTx.hash}`);
    console.log(`\nRecipient ${to}'s encrypted balance has been credited ${amount} USDC.`);
    console.log(`Open the Blank app with that address connected — autogeneratePermits`);
    console.log(`will create a permit on connect and the balance will decrypt automatically.`);
  });
