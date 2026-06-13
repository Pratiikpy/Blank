import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia as viemArbSepolia } from "viem/chains";

// Real Arbitrum Sepolia end-to-end proof for the conditional invoice:
//   shield → createConditionalEscrow (real cofhe encrypt) → resolver.approve →
//   releaseIfConditionMet → assert Released. Prints Arbiscan tx links and the
//   escrowId so the public UI page can be opened against real state.
//
//   npx hardhat lifecycle-conditional-escrow --network arb-sepolia --amount 5

const MAX_U64 = (1n << 64n) - 1n;
const EXPLORER = "https://sepolia.arbiscan.io/tx/";

task("lifecycle-conditional-escrow", "Real Arb Sepolia: create conditional escrow → approve → release")
  .addOptionalParam("amount", "USDC amount (default 5)", "5")
  .addOptionalParam("beneficiary", "Recipient (vendor) address", "")
  .setAction(async ({ amount, beneficiary }, hre) => {
    if (hre.network.name !== "arb-sepolia") throw new Error("Use --network arb-sepolia");
    const d = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", "arb-sepolia.json"), "utf8"),
    ) as Record<string, string>;
    const vaultAddr = d.FHERC20Vault_USDC;
    const escrowAddr = d.EncryptedEscrow;
    const resolverAddr = d.InvoiceApprovalResolver;
    const usdcAddr = d.TestUSDC;
    if (!vaultAddr || !escrowAddr || !resolverAddr) throw new Error("Missing addresses in arb-sepolia.json");

    const [signer] = await hre.ethers.getSigners();
    const depositor = signer.address;
    const vendor =
      beneficiary && hre.ethers.isAddress(beneficiary)
        ? beneficiary
        : "0x000000000000000000000000000000000000bEEF";
    if (vendor.toLowerCase() === depositor.toLowerCase()) throw new Error("beneficiary must differ from deployer");
    const amountUnits = hre.ethers.parseUnits(amount, 6);

    console.log(`depositor (payer):    ${depositor}`);
    console.log(`beneficiary (vendor): ${vendor}`);
    console.log(`amount:               ${amount} USDC`);
    console.log(`escrow:               ${escrowAddr}`);
    console.log(`resolver:             ${resolverAddr}`);

    // ── Ensure shielded balance (TestUSDC is a faucet token) ──────────────
    const usdc = new hre.ethers.Contract(usdcAddr, [
      "function mint(address to, uint256 amount)",
      "function approve(address spender, uint256 amount) returns (bool)",
    ], signer);
    const vault = new hre.ethers.Contract(vaultAddr, [
      "function shield(uint256 amount)",
      "function approvePlaintext(address spender, uint64 amount)",
    ], signer);
    try {
      const m = await usdc.mint(depositor, amountUnits * 2n); await m.wait();
      const a = await usdc.approve(vaultAddr, amountUnits * 2n); await a.wait();
      const s = await vault.shield(amountUnits * 2n); await s.wait();
      console.log(`shielded ${Number(amount) * 2} USDC (tx ${s.hash})`);
    } catch (e) {
      console.log(`shield step skipped (may already hold balance): ${(e as Error).message}`);
    }
    const ap = await vault.approvePlaintext(escrowAddr, MAX_U64); await ap.wait();

    // ── cofhe encrypt against Arb Sepolia threshold network ───────────────
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
    console.log(`Encrypting ${amount} USDC...`);
    const [encAmount] = await client.encryptInputs([Encryptable.uint64(amountUnits)]).execute();
    console.log(`  handle: ${encAmount.ctHash}`);

    // ── createConditionalEscrow ───────────────────────────────────────────
    const deadline = Math.floor(Date.now() / 1000) + 2 * 86400;
    const resolverData = encodeAbiParameters(
      [{ type: "address" }, { type: "uint64" }],
      [depositor as `0x${string}`, BigInt(deadline)],
    );
    const escrow = new hre.ethers.Contract(escrowAddr, [
      "function createConditionalEscrow(address beneficiary, address vault, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encAmount, string description, address resolver, bytes resolverData, uint256 deadline) returns (uint256)",
      "function releaseIfConditionMet(uint256 escrowId)",
      "function getEscrow(uint256 escrowId) view returns (address,address,address,address,uint256,bool,bool,uint8,string,uint256)",
      "function nextEscrowId() view returns (uint256)",
      "event EscrowResolverSet(uint256 indexed escrowId, address indexed resolver)",
    ], signer);
    const resolver = new hre.ethers.Contract(resolverAddr, [
      "function approve(uint256 escrowId)",
      "function getCondition(uint256 escrowId) view returns (address,uint64,bool,bool,bool)",
    ], signer);

    console.log(`\ncreateConditionalEscrow...`);
    const createTx = await escrow.createConditionalEscrow(
      vendor, vaultAddr, encAmount, "Hackathon conditional invoice", resolverAddr, resolverData, deadline,
    );
    const createRcpt = await createTx.wait();
    let escrowId: bigint | null = null;
    for (const log of createRcpt.logs) {
      try {
        const parsed = escrow.interface.parseLog(log);
        if (parsed?.name === "EscrowResolverSet") { escrowId = parsed.args[0] as bigint; break; }
      } catch { /* not our event */ }
    }
    if (escrowId === null) escrowId = (await escrow.nextEscrowId()) - 1n;
    console.log(`  create tx: ${createTx.hash}`);
    console.log(`  escrowId:  ${escrowId}`);

    console.log(`\nresolver.approve (payer approves early release)...`);
    const approveTx = await resolver.approve(escrowId); await approveTx.wait();
    const cond = await resolver.getCondition(escrowId);
    console.log(`  approve tx: ${approveTx.hash}`);
    console.log(`  condition: approved=${cond[2]} deadlinePassed=${cond[3]}`);

    console.log(`\nreleaseIfConditionMet...`);
    const relTx = await escrow.releaseIfConditionMet(escrowId);
    const relRcpt = await relTx.wait();
    if (relRcpt.status !== 1) throw new Error("release reverted");
    console.log(`  release tx: ${relTx.hash}`);

    const e = await escrow.getEscrow(escrowId);
    const status = Number(e[7]);
    if (status !== 2) throw new Error(`expected Released(2), got ${status}`);

    console.log(`\n=== PROOF (Arbitrum Sepolia) ===`);
    console.log(`status:  Released`);
    console.log(`create:  ${EXPLORER}${createTx.hash}`);
    console.log(`approve: ${EXPLORER}${approveTx.hash}`);
    console.log(`release: ${EXPLORER}${relTx.hash}`);
    console.log(`escrowId ${escrowId} → public page /conditional-invoice/421614/${escrowId}`);
  });
