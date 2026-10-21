import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia, baseSepolia, sepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arbitrumSepolia as viemArbSepolia,
  baseSepolia as viemBaseSepolia,
  sepolia as viemSepolia,
} from "viem/chains";

// Full CoFHE round trip on a live testnet with the installed @cofhe/sdk:
// shield -> encrypt input -> requestUnshield (store + allowPublic) ->
// decryptForTx off-chain -> claimUnshield (publishDecryptResult on-chain) ->
// confirm the plaintext token balance moved by exactly the decrypted amount.
//
// Usage: npx hardhat roundtrip-sdk --network <eth-sepolia|base-sepolia|arb-sepolia>
const CHAINS = {
  "eth-sepolia": { cofhe: sepolia, viem: viemSepolia, rpc: "SEPOLIA_RPC_URL", scan: "https://sepolia.etherscan.io" },
  "base-sepolia": { cofhe: baseSepolia, viem: viemBaseSepolia, rpc: "BASE_SEPOLIA_RPC_URL", scan: "https://sepolia.basescan.org" },
  "arb-sepolia": { cofhe: arbSepolia, viem: viemArbSepolia, rpc: "ARBITRUM_SEPOLIA_RPC_URL", scan: "https://sepolia.arbiscan.io" },
} as const;

task("roundtrip-sdk", "Encrypt -> store -> decrypt -> claim round trip on a live testnet")
  .addOptionalParam("amount", "USDC to shield (human units)", "2")
  .addOptionalParam("unshield", "USDC to unshield (human units)", "1")
  .setAction(async ({ amount, unshield }, hre) => {
    const cfg = CHAINS[hre.network.name as keyof typeof CHAINS];
    if (!cfg) throw new Error(`Unsupported network "${hre.network.name}"`);
    const d = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"),
    ) as Record<string, string>;
    const usdcAddr = d.TestUSDC;
    const vaultAddr = d.FHERC20Vault_USDC;
    if (!usdcAddr || !vaultAddr) throw new Error("Missing TestUSDC / FHERC20Vault_USDC in deployments");

    const [signer] = await hre.ethers.getSigners();
    const shieldUnits = hre.ethers.parseUnits(amount, 6);
    const unshieldUnits = hre.ethers.parseUnits(unshield, 6);
    console.log(`Network ${hre.network.name} | signer ${signer.address} | vault ${vaultAddr}`);

    const usdc = new hre.ethers.Contract(usdcAddr, [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function mint(address,uint256)",
    ], signer);
    const vault = new hre.ethers.Contract(vaultAddr, [
      "function shield(uint256)",
      "function requestUnshield(bytes32 encAmount, bytes proof) returns (uint256)",
      "function claimUnshield(uint64 plaintext, bytes signature)",
      "function pendingUnshield(address) view returns (uint256)",
    ], signer);

    // 1. shield (plaintext in, encrypted balance out)
    const bal0: bigint = await usdc.balanceOf(signer.address);
    if (bal0 < shieldUnits) await (await usdc.mint(signer.address, shieldUnits - bal0)).wait();
    await (await usdc.approve(vaultAddr, shieldUnits)).wait();
    const shieldTx = await vault.shield(shieldUnits);
    await shieldTx.wait();
    console.log(`1. shield           ${cfg.scan}/tx/${shieldTx.hash}`);

    // 2. encrypt with the SDK, consuming contract bound into the batch signature
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY env missing");
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
    const rpcUrl = process.env[cfg.rpc] || (hre.network.config as { url: string }).url;
    const publicClient = createPublicClient({ chain: cfg.viem, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: cfg.viem, transport: http(rpcUrl) });
    const client = createCofheClient(createCofheConfig({ supportedChains: [cfg.cofhe] }));
    await client.connect(publicClient as never, walletClient as never);
    const [encAmount, proof] = await client
      .encryptInputs([Encryptable.uint64(unshieldUnits)])
      .setConsumingContract(vaultAddr as `0x${string}`)
      .execute();
    console.log(`2. encrypted input  handle ${String(encAmount).slice(0, 18)}...`);

    // 3. store: vault subtracts under FHE.select and parks the amount as pending + allowPublic
    const reqTx = await vault.requestUnshield(encAmount, proof);
    const reqRc = await reqTx.wait();
    if (reqRc.status !== 1) throw new Error("requestUnshield reverted");
    console.log(`3. requestUnshield  ${cfg.scan}/tx/${reqTx.hash}`);

    // 4. decrypt off-chain through the threshold network (global allowance, no ACP)
    const pending: bigint = await vault.pendingUnshield(signer.address);
    const t0 = Date.now();
    const dec = await client.decryptForTx(pending).withoutACP().execute();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`4. decryptForTx     plaintext ${dec.decryptedValue} in ${secs}s`);

    // 5. claim: publishDecryptResult verifies the signature on-chain, then tokens move
    // Public RPCs can lag the coprocessor: the signature is ready before the
    // node serving the call has the handle. Simulate until it clears and report
    // how long that took, so the app's claim path can budget for it.
    let waited = 0;
    for (;;) {
      try {
        await vault.claimUnshield.staticCall(dec.decryptedValue, dec.signature);
        break;
      } catch (e) {
        if (waited >= 90) throw e;
        await new Promise((r) => setTimeout(r, 3000));
        waited += 3;
      }
    }
    if (waited > 0) console.log(`   claim simulation reverted for ${waited}s before clearing`);
    const before: bigint = await usdc.balanceOf(signer.address);
    const claimTx = await vault.claimUnshield(dec.decryptedValue, dec.signature);
    const claimRc = await claimTx.wait();
    console.log(`5. claimUnshield    ${cfg.scan}/tx/${claimTx.hash}`);

    // Source of truth is the receipt: an ERC20 Transfer vault -> signer for the
    // decrypted amount. A public RPC can serve balanceOf from a lagging node
    // right after wait(), so the balance is polled only as a secondary check.
    const transferTopic = hre.ethers.id("Transfer(address,address,uint256)");
    const toTopic = hre.ethers.zeroPadValue(signer.address, 32);
    const log = claimRc.logs.find(
      (l: { address: string; topics: string[] }) =>
        l.address.toLowerCase() === usdcAddr.toLowerCase() &&
        l.topics[0] === transferTopic &&
        l.topics[2]?.toLowerCase() === toTopic.toLowerCase(),
    );
    const transferred: bigint = log ? BigInt(log.data) : 0n;
    let moved = 0n;
    for (let i = 0; i < 10 && moved !== dec.decryptedValue; i++) {
      moved = (await usdc.balanceOf(signer.address)) - before;
      if (moved !== dec.decryptedValue) await new Promise((r) => setTimeout(r, 3000));
    }
    const ok = transferred === dec.decryptedValue && dec.decryptedValue > 0n && moved === dec.decryptedValue;
    console.log(`
receipt Transfer ${transferred} | balance delta ${moved} | decrypted ${dec.decryptedValue} -> ${ok ? "ROUND TRIP PASS" : "ROUND TRIP FAIL"}`);
    if (!ok) throw new Error("round trip mismatch");
  });
