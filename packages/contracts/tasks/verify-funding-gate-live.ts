import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia, baseSepolia, sepolia } from "@cofhe/sdk/chains";
import type { Signer } from "ethers";
import type { EncryptedEscrow } from "../typechain-types";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, baseSepolia as viemBase, sepolia as viemSepolia } from "viem/chains";

// Proves the funding gate against the REAL CoFHE network without touching the live
// proxies: deploys a throwaway EncryptedEscrow proxy (owned by the deployer, not
// recorded in deployments), then runs
//   funded   : deployer with a vault balance -> Pending -> decryptForTx(true)  -> confirmFunding -> Active
//   unfunded : fresh wallet with no balance  -> Pending -> decryptForTx(false) -> confirmFunding -> Void
// and checks that a Void escrow cannot be released.
//
// Usage: npx hardhat verify-funding-gate-live --network <eth-sepolia|base-sepolia|arb-sepolia>
const CHAINS = {
  "eth-sepolia": { cofhe: sepolia, viem: viemSepolia, rpc: "SEPOLIA_RPC_URL", scan: "https://sepolia.etherscan.io" },
  "base-sepolia": { cofhe: baseSepolia, viem: viemBase, rpc: "BASE_SEPOLIA_RPC_URL", scan: "https://sepolia.basescan.org" },
  "arb-sepolia": { cofhe: arbSepolia, viem: arbitrumSepolia, rpc: "ARBITRUM_SEPOLIA_RPC_URL", scan: "https://sepolia.arbiscan.io" },
} as const;
const STATUS = { Active: 0n, PendingFunding: 4n, Void: 5n };

task("verify-funding-gate-live", "Funded and unfunded escrow through the real threshold network")
  .addFlag("useDeployed", "Use the deployed EncryptedEscrow proxy instead of a throwaway one")
  .setAction(async (args: { useDeployed: boolean }, hre) => {
    const cfg = CHAINS[hre.network.name as keyof typeof CHAINS];
    if (!cfg) throw new Error(`Unsupported network ${hre.network.name}`);
    const d = JSON.parse(readFileSync(resolve(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8")) as Record<string, string>;
    const [deployer] = await hre.ethers.getSigners();
    const rpcUrl = process.env[cfg.rpc] || (hre.network.config as { url: string }).url;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const retry = async <T>(label: string, f: () => Promise<T>, n = 8): Promise<T> => {
      let last: unknown;
      for (let i = 0; i < n; i++) {
        try { return await f(); } catch (e) { last = e; await sleep(3000); }
      }
      throw new Error(`${label} kept failing: ${(last as Error).message}`);
    };

    // 1. throwaway proxy (or the deployed one with --use-deployed)
    let escrowAddr: string;
    if (args.useDeployed) {
      escrowAddr = d.EncryptedEscrow;
    } else {
      const Factory = await hre.ethers.getContractFactory("EncryptedEscrow", deployer);
      const impl = await Factory.deploy();
      await impl.waitForDeployment();
      const Proxy = await hre.ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy", deployer);
      const proxy = await Proxy.deploy(await impl.getAddress(), Factory.interface.encodeFunctionData("initialize", [d.EventHub]));
      await proxy.waitForDeployment();
      escrowAddr = await proxy.getAddress();
      const fresh = (await hre.ethers.getContractAt("EncryptedEscrow", escrowAddr, deployer)) as unknown as EncryptedEscrow;
      await (await fresh.setTokenRegistry(d.TokenRegistry)).wait();
    }
    const escrow = (await hre.ethers.getContractAt("EncryptedEscrow", escrowAddr, deployer)) as unknown as EncryptedEscrow;
    console.log(`${args.useDeployed ? "deployed" : "throwaway"} EncryptedEscrow ${escrowAddr}
`);

    const vaultAddr = d.FHERC20Vault_USDC;
    const vaultAbi = ["function approvePlaintext(address,uint64)", "function shield(uint256)"];
    const MAX = 2n ** 64n - 1n;

    const sdkFor = async (pk: `0x${string}`) => {
      const account = privateKeyToAccount(pk);
      const publicClient = createPublicClient({ chain: cfg.viem, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: cfg.viem, transport: http(rpcUrl) });
      const client = createCofheClient(createCofheConfig({ supportedChains: [cfg.cofhe] }));
      await client.connect(publicClient as never, walletClient as never);
      return client;
    };

    const gate = async (label: string, signer: Signer, pk: `0x${string}`, amountUnits: bigint) => {
      const client = await sdkFor(pk);
      const vault = new hre.ethers.Contract(vaultAddr, vaultAbi, signer);
      await (await vault.approvePlaintext(escrowAddr, MAX)).wait();
      const [enc, proof] = await client
        .encryptInputs([Encryptable.uint64(amountUnits)])
        .setConsumingContract(escrowAddr as `0x${string}`)
        .execute();
      const beneficiary = hre.ethers.Wallet.createRandom().address;
      const e = escrow.connect(signer);
      const tx = await e.createEscrow(beneficiary, vaultAddr, enc, proof, label, hre.ethers.ZeroAddress, Math.floor(Date.now() / 1000) + 3 * 86400);
      const rc = await tx.wait();
      // Read the id from the receipt, not nextEscrowId: public RPCs can serve a stale counter.
      const created = rc!.logs
        .map((l: { topics: readonly string[]; data: string }) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
        .find((l: { name: string } | null) => l?.name === "EscrowCreated");
      if (!created) throw new Error(`${label}: no EscrowCreated in the receipt`);
      const id: bigint = created.args[0];
      console.log(`${label}: createEscrow ${cfg.scan}/tx/${tx.hash} (escrow #${id})`);
      const before = await retry("status after create", async () => {
        const st = (await escrow.getEscrow(id)).status as bigint;
        if (st === STATUS.Active) throw new Error("stale read");
        return st;
      });
      if (before !== STATUS.PendingFunding) throw new Error(`${label}: expected PendingFunding, got ${before}`);

      const handle: bigint = await retry("getFundingCheck", async () => {
        const h = BigInt(await escrow.getFundingCheck(id));
        if (h === 0n) throw new Error("handle not visible yet");
        return h;
      });
      const t0 = Date.now();
      const dec = await retry("decryptForTx", () => client.decryptForTx(handle).withoutACP().execute());
      console.log(`${label}: decryptForTx funded=${dec.decryptedValue} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      const ctx = await retry("confirmFunding", async () => {
        const t = await e.confirmFunding(id, Boolean(dec.decryptedValue), dec.signature);
        await t.wait();
        return t;
      });
      console.log(`${label}: confirmFunding ${cfg.scan}/tx/${ctx.hash}`);
      const after = await retry("status after confirm", async () => {
        const st = (await escrow.getEscrow(id)).status as bigint;
        if (st === STATUS.PendingFunding) throw new Error("stale read, still pending");
        return st;
      }, 15);
      return { id, funded: Boolean(dec.decryptedValue), status: after, rc, beneficiary };
    };

    // funded: the deployer must hold an encrypted balance
    await (await new hre.ethers.Contract(d.TestUSDC, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"], deployer).mint(deployer.address, 5_000_000n)).wait();
    await (await new hre.ethers.Contract(d.TestUSDC, ["function approve(address,uint256) returns (bool)"], deployer).approve(vaultAddr, 5_000_000n)).wait();
    await (await new hre.ethers.Contract(vaultAddr, vaultAbi, deployer).shield(5_000_000n)).wait();
    const pk = process.env.PRIVATE_KEY!;
    const fundedRun = await gate("funded", deployer, (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`, 100_000n);

    // unfunded: a fresh wallet with gas but no encrypted balance
    const poor = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
    await (await deployer.sendTransaction({ to: poor.address, value: hre.ethers.parseEther("0.003") })).wait();
    const poorRun = await gate("unfunded", poor, poor.privateKey as `0x${string}`, 5_000_000n);

    // a Void escrow must not release
    const poorEscrow = escrow.connect(poor);
    const releaseVoid = await poorEscrow.approveRelease.staticCall(poorRun.id).then(() => "ALLOWED").catch(() => "reverted");

    console.log("\nresults");
    console.log(`funded   : decrypted=${fundedRun.funded} status=${fundedRun.status} (expect true, ${STATUS.Active})`);
    console.log(`unfunded : decrypted=${poorRun.funded} status=${poorRun.status} (expect false, ${STATUS.Void})`);
    console.log(`release of the Void escrow: ${releaseVoid} (expect reverted)`);
    const ok =
      fundedRun.funded === true && fundedRun.status === STATUS.Active &&
      poorRun.funded === false && poorRun.status === STATUS.Void && releaseVoid === "reverted";
    console.log(ok ? "FUNDING GATE LIVE: PASS" : "FUNDING GATE LIVE: FAIL");
    if (!ok) throw new Error("funding gate live check failed");
  });
