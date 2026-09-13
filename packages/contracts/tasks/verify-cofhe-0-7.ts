import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import * as cofheChains from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

/**
 * verify-cofhe-0-7 — prove the 0.7 encrypted-input path end to end on a live
 * chain, on whatever network hardhat is pointed at.
 *
 * This is the check a passing test suite cannot give you. The failure mode
 * this migration is about — a batch signature bound to the wrong contract, or
 * an ABI still expecting the deleted InEuintXX struct — compiles, type-checks,
 * passes mocks, and only fails against the real verifier and the real ACL.
 *
 * What it exercises:
 *   1. shield (plaintext in, contract encrypts) — proves FHE ops still run;
 *   2. client-side encrypt bound to the vault as the consuming contract —
 *      proves the ZK verifier accepts our batch;
 *   3. requestUnshield(externalEuint64, bytes) — proves the deployed ABI and
 *      the on-chain batchVerifyInputs agree with what the client produced.
 *
 * Exits non-zero on any revert, so it is safe to chain in a release script.
 */

const CHAINS: Record<string, { cofhe: unknown; viem: unknown; rpcEnv: string; file: string; explorer: string }> = {
  "arb-sepolia": {
    cofhe: cofheChains.arbSepolia, viem: viemChains.arbitrumSepolia,
    rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL", file: "arb-sepolia.json",
    explorer: "https://sepolia.arbiscan.io/tx/",
  },
  "eth-sepolia": {
    cofhe: cofheChains.sepolia, viem: viemChains.sepolia,
    rpcEnv: "SEPOLIA_RPC_URL", file: "eth-sepolia.json",
    explorer: "https://sepolia.etherscan.io/tx/",
  },
  "base-sepolia": {
    cofhe: cofheChains.baseSepolia, viem: viemChains.baseSepolia,
    rpcEnv: "BASE_SEPOLIA_RPC_URL", file: "base-sepolia.json",
    explorer: "https://sepolia.basescan.org/tx/",
  },
};

task("verify-cofhe-0-7", "Prove the 0.7 encrypted-input path on a live chain")
  .addOptionalParam("amount", "USDC to shield (human units)", "1")
  .addOptionalParam("unshield", "USDC to unshield (human units)", "0.5")
  .setAction(async ({ amount, unshield }: { amount: string; unshield: string }, hre: HardhatRuntimeEnvironment) => {
    const net = CHAINS[hre.network.name];
    if (!net) throw new Error(`verify-cofhe-0-7: unsupported network ${hre.network.name}`);

    const deployments: Record<string, string> = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", net.file), "utf8"),
    );
    const usdcAddr = deployments.TestUSDC;
    const vaultAddr = deployments.FHERC20Vault_USDC;
    if (!usdcAddr || !vaultAddr) throw new Error("verify-cofhe-0-7: TestUSDC / FHERC20Vault_USDC missing");

    const [signer] = await hre.ethers.getSigners();
    if (!signer) throw new Error("verify-cofhe-0-7: no signer — set PRIVATE_KEY");
    console.log(`network=${hre.network.name}`);
    console.log(`signer=${signer.address}`);
    console.log(`vault=${vaultAddr}`);

    const usdc = new hre.ethers.Contract(usdcAddr, [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function mint(address,uint256)",
    ], signer);
    const vault = new hre.ethers.Contract(vaultAddr, [
      "function shield(uint256)",
      "function requestUnshield(bytes32 encAmount, bytes proof) returns (uint256)",
    ], signer);

    // ─── 1. shield: plaintext in, the contract encrypts ────────────────
    const shieldUnits = hre.ethers.parseUnits(amount, 6);
    const unshieldUnits = hre.ethers.parseUnits(unshield, 6);
    const bal: bigint = await usdc.balanceOf(signer.address);
    if (bal < shieldUnits) {
      await (await usdc.mint(signer.address, shieldUnits - bal)).wait();
    }
    await (await usdc.approve(vaultAddr, shieldUnits)).wait();
    const shieldTx = await vault.shield(shieldUnits);
    const shieldRcpt = await shieldTx.wait();
    if (shieldRcpt?.status !== 1) throw new Error("shield reverted");
    console.log(`\n[1/3] shield OK      ${net.explorer}${shieldTx.hash}`);

    // ─── 2. client-side encrypt, bound to the consuming contract ───────
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("verify-cofhe-0-7: PRIVATE_KEY missing");
    const pkHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    const rpcUrl = process.env[net.rpcEnv];
    if (!rpcUrl) throw new Error(`verify-cofhe-0-7: ${net.rpcEnv} missing`);

    const account = privateKeyToAccount(pkHex);
    const publicClient = createPublicClient({ chain: net.viem as never, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: net.viem as never, transport: http(rpcUrl) });
    const client = createCofheClient(createCofheConfig({ supportedChains: [net.cofhe as never] }));
    await client.connect(publicClient as never, walletClient as never);

    const parts = await client
      .encryptInputs([Encryptable.uint64(unshieldUnits)])
      .setConsumingContract(vaultAddr as `0x${string}`)
      .execute();
    if (parts.length !== 2) throw new Error(`expected [handle, proof], got ${parts.length} parts`);
    const [handle, proof] = parts as [`0x${string}`, `0x${string}`];
    console.log(`[2/3] encrypt OK     handle=${handle.slice(0, 20)}… proof=${proof.length - 2} hex chars`);

    // ─── 3. spend it against the deployed ABI ──────────────────────────
    const decTx = await vault.requestUnshield(handle, proof);
    const rcpt = await decTx.wait();
    if (rcpt?.status !== 1) throw new Error("requestUnshield reverted");
    console.log(`[3/3] requestUnshield OK  gas=${rcpt.gasUsed}  ${net.explorer}${decTx.hash}`);

    console.log(`\nPASS — ${hre.network.name}: encrypted input verified on chain against the 0.7 ACL.`);
  });
