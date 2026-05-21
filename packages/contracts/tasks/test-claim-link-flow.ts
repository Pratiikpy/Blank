import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { sepolia, baseSepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http, keccak256, encodePacked, toBytes, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia, baseSepolia as viemBaseSepolia } from "viem/chains";

// Wave 4 task #251 follow-up — drive a real createLink on testnet.
//
// Pre-reqs (all should already be in place after wire-claim-links):
//   - TestUSDC minted to deployer (call faucet() if not)
//   - Vault approved by deployer
//   - Deployer has shielded vault balance
//   - ClaimLinks deployed + EventHub-whitelisted
//
// Flow:
//   1. Approve ClaimLinks on vault (idempotent).
//   2. Encrypt amount via cofhe-sdk against threshold network.
//   3. Generate 32-byte secret + compute bearer secretHash (DOMAIN ‖ 0x00 ‖ secret).
//   4. createLink(vault, encAmount, secretHash, BEARER, 0x0, 0, note).
//   5. Wait for receipt, extract linkId from LinkCreated event.
//   6. Print the shareable URL.
//
// Usage:
//   npx hardhat test-claim-link-flow --network eth-sepolia --amount 0.5
//   npx hardhat test-claim-link-flow --network base-sepolia --amount 0.5

task("test-claim-link-flow", "Create a real bearer claim-link from the deployer on testnet")
  .addOptionalParam("amount", "USDC amount (human units, default 0.5)", "0.5")
  .addOptionalParam("note", "Public note", "wave4 e2e probe")
  .setAction(async ({ amount, note }, hre) => {
    const networkName = hre.network.name;
    const isBase = networkName === "base-sepolia";
    const deploymentFile = isBase
      ? "base-sepolia.json"
      : networkName === "eth-sepolia"
        ? "eth-sepolia.json"
        : null;
    if (!deploymentFile) {
      throw new Error(`Unsupported network ${networkName} — eth-sepolia | base-sepolia`);
    }

    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const vaultAddr = deployments.FHERC20Vault_USDC;
    const claimLinksAddr = deployments.ClaimLinks;
    if (!vaultAddr || !claimLinksAddr) {
      throw new Error(`Missing FHERC20Vault_USDC or ClaimLinks in ${deploymentFile}`);
    }

    const [signer] = await hre.ethers.getSigners();
    const amountUnits = hre.ethers.parseUnits(amount, 6);
    const MAX_U64 = (1n << 64n) - 1n;
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    console.log("═══════════════════════════════════════════");
    console.log("  test-claim-link-flow");
    console.log("═══════════════════════════════════════════");
    console.log(`  Network:    ${networkName}`);
    console.log(`  Sender:     ${signer.address}`);
    console.log(`  Amount:     ${amount} USDC (${amountUnits.toString()} units)`);
    console.log(`  Vault:      ${vaultAddr}`);
    console.log(`  ClaimLinks: ${claimLinksAddr}`);
    console.log("═══════════════════════════════════════════\n");

    // ── 1. Approve ClaimLinks on vault (idempotent) ────────────────────
    const vault = new hre.ethers.Contract(
      vaultAddr,
      [
        "function approvePlaintext(address spender, uint64 amount)",
        "function balanceOf(address account) view returns (uint256)",
      ],
      signer,
    );

    console.log("[1/5] Approving ClaimLinks on vault...");
    const apTx = await vault.approvePlaintext(claimLinksAddr, MAX_U64);
    console.log(`      tx: ${apTx.hash}`);
    await apTx.wait(2);

    // ── 2. Encrypt amount via cofhe-sdk node client ────────────────────
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY env missing");
    const pkHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;

    const rpcUrl = isBase
      ? (process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com")
      : (process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com");

    const account = privateKeyToAccount(pkHex);
    const publicClient = createPublicClient({
      chain: isBase ? viemBaseSepolia : viemSepolia,
      transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain: isBase ? viemBaseSepolia : viemSepolia,
      transport: http(rpcUrl),
    });

    console.log("\n[2/5] Connecting CoFHE client to threshold network...");
    const cofheConfig = createCofheConfig({ supportedChains: [isBase ? baseSepolia : sepolia] });
    const client = createCofheClient(cofheConfig);
    await client.connect(publicClient as any, walletClient as any);

    console.log(`      Encrypting ${amount} USDC...`);
    const [encAmount] = await client.encryptInputs([Encryptable.uint64(amountUnits)]).execute();
    console.log(`      ctHash: ${encAmount.ctHash}`);

    // ── 3. Generate secret + bearer hash ───────────────────────────────
    // DOMAIN = keccak256("BLANK_CLAIM_v1")
    // Bearer hash = keccak256(abi.encodePacked(DOMAIN, uint8(0), secret))
    const DOMAIN = keccak256(toBytes("BLANK_CLAIM_v1"));
    const secretBytes = new Uint8Array(32);
    crypto.getRandomValues(secretBytes);
    const secretHex = ("0x" + Array.from(secretBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const secretHash = keccak256(encodePacked(["bytes32", "uint8", "bytes32"], [DOMAIN, 0, secretHex]));

    console.log("\n[3/5] Generated secret + bearer hash");
    console.log(`      secret:     ${secretHex}`);
    console.log(`      secretHash: ${secretHash}`);

    // ── 4. Call createLink ─────────────────────────────────────────────
    const claimLinks = new hre.ethers.Contract(
      claimLinksAddr,
      [
        "function createLink(address vault, (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature) encAmount, bytes32 secretHash, uint8 mode, address boundAddress, uint256 expirySeconds, string note) returns (uint256)",
        "event LinkCreated(uint256 indexed linkId, address indexed sender, address vault, uint8 mode, address indexed boundAddress, uint256 expiryTimestamp, string note)",
      ],
      signer,
    );

    console.log("\n[4/5] Calling createLink...");
    const createTx = await claimLinks.createLink(
      vaultAddr,
      encAmount,
      secretHash,
      0, // BEARER
      ZERO_ADDRESS,
      0, // expiry 0 = use contract default (7 days)
      note,
      { gasLimit: 5_000_000 },
    );
    console.log(`      tx: ${createTx.hash}`);
    const receipt = await createTx.wait(2);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`createLink reverted: status=${receipt?.status}`);
    }

    // ── 5. Extract linkId from LinkCreated event ───────────────────────
    const iface = claimLinks.interface;
    let linkId: bigint | null = null;
    for (const log of receipt.logs ?? []) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "LinkCreated") {
          linkId = parsed.args.linkId as bigint;
          break;
        }
      } catch {
        continue;
      }
    }
    if (linkId === null) {
      throw new Error("LinkCreated event not found in receipt logs");
    }

    // base64url-encode the secret
    const b64 = Buffer.from(hexToBytes(secretHex)).toString("base64");
    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const chainId = isBase ? 84532 : 11155111;
    const localUrl = `http://localhost:3000/claim/${chainId}/${linkId.toString()}#b.${b64url}`;
    const prodUrl = `https://www.myblank.app/claim/${chainId}/${linkId.toString()}#b.${b64url}`;

    console.log("\n═══════════════════════════════════════════");
    console.log("  ✓ Link created");
    console.log("═══════════════════════════════════════════");
    console.log(`  linkId:     ${linkId.toString()}`);
    console.log(`  txHash:     ${createTx.hash}`);
    console.log(`  amount:     ${amount} USDC (encrypted)`);
    console.log(`  expiry:     7 days`);
    console.log("");
    console.log(`  LOCAL URL:  ${localUrl}`);
    console.log(`  PROD URL:   ${prodUrl}`);
    console.log("");
    console.log(`  Recipient: open the URL, sign in or create a passkey, click Claim.`);
    console.log("═══════════════════════════════════════════");

    // Emit a machine-readable line so Playwright can grep for it.
    console.log(`\n__CLAIM_LINK_URL__=${localUrl}`);
  });
