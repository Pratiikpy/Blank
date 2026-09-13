import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia as viemArbSepolia } from "viem/chains";

// One-shot: trigger a single on-chain DECRYPT event on Arbitrum Sepolia from
// the deployer EOA, to satisfy the Fhenix loyalty "Run your first Decrypt
// event" quest. The flow:
//   1. shield a small plaintext amount into FHERC20Vault_USDC (encrypt op)
//   2. requestUnshield(encAmount) — marks the pending amount publicly
//      decryptable via FHE.allowPublic, which is the CoFHE decrypt request
//      the loyalty program counts.
//
// Usage:
//   npx hardhat decrypt-once --network arb-sepolia
task("decrypt-once", "Trigger one CoFHE decrypt (shield + requestUnshield) from the deployer")
  .addOptionalParam("amount", "USDC to shield (human units, default 2)", "2")
  .addOptionalParam("unshield", "USDC to unshield/decrypt (human units, default 1)", "1")
  .setAction(async ({ amount, unshield }, hre) => {
    if (hre.network.name !== "arb-sepolia") {
      throw new Error(`Run on arb-sepolia (got "${hre.network.name}")`);
    }
    const d = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", "arb-sepolia.json"), "utf8"),
    ) as Record<string, string>;
    const usdcAddr = d.TestUSDC;
    const vaultAddr = d.FHERC20Vault_USDC;
    if (!usdcAddr || !vaultAddr) throw new Error("Missing TestUSDC / FHERC20Vault_USDC");

    const [signer] = await hre.ethers.getSigners();
    const shieldUnits = hre.ethers.parseUnits(amount, 6);
    const unshieldUnits = hre.ethers.parseUnits(unshield, 6);
    console.log(`Network: ${hre.network.name}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`Vault:   ${vaultAddr}`);

    // ── 1. shield (plaintext in; contract encrypts) ──────────────────────
    const usdc = new hre.ethers.Contract(usdcAddr, [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function mint(address,uint256)",
    ], signer);
    const vault = new hre.ethers.Contract(vaultAddr, [
      "function shield(uint256)",
      "function requestUnshield(bytes32 encAmount, bytes proof) returns (uint256)",
    ], signer);

    const bal: bigint = await usdc.balanceOf(signer.address);
    if (bal < shieldUnits) {
      console.log(`\nMinting ${hre.ethers.formatUnits(shieldUnits - bal, 6)} USDC from faucet...`);
      await (await usdc.mint(signer.address, shieldUnits - bal)).wait();
    }
    console.log(`\nApproving + shielding ${amount} USDC...`);
    await (await usdc.approve(vaultAddr, shieldUnits)).wait();
    const shieldTx = await vault.shield(shieldUnits);
    console.log(`  shield tx: ${shieldTx.hash}`);
    await shieldTx.wait();

    // ── 2. cofhe-encrypt the unshield amount + requestUnshield (DECRYPT) ──
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY env missing");
    const pkHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
    const account = privateKeyToAccount(pkHex);
    const publicClient = createPublicClient({ chain: viemArbSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: viemArbSepolia, transport: http(rpcUrl) });
    console.log(`\nConnecting CoFHE client to Arbitrum Sepolia...`);
    const client = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
    await client.connect(publicClient as any, walletClient as any);
    console.log(`Encrypting ${unshield} USDC...`);
    // 0.7: one handle per input followed by a single batch signature, and the
    // consuming contract (the vault, which runs FHE.asEuint64) is bound into
    // the signed digest.
    const [encAmount, proof] = await client
      .encryptInputs([Encryptable.uint64(unshieldUnits)])
      .setConsumingContract(vaultAddr as `0x${string}`)
      .execute();
    console.log(`  handle: ${encAmount}`);
    console.log(`  proof:  ${String(proof).slice(0, 26)}...`);

    console.log(`\nrequestUnshield (this is the DECRYPT event)...`);
    const decTx = await vault.requestUnshield(encAmount, proof);
    console.log(`  decrypt tx: ${decTx.hash}`);
    const rcpt = await decTx.wait();
    if (rcpt.status !== 1) throw new Error("requestUnshield reverted");

    console.log(`\nDone. Decrypt event emitted.`);
    console.log(`  https://sepolia.arbiscan.io/tx/${decTx.hash}`);
  });
