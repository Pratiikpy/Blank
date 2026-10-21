import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { encodePacked, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { arbitrumSepolia, baseSepolia as viemBaseSepolia, sepolia as viemSepolia } from "viem/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia, baseSepolia, sepolia } from "@cofhe/sdk/chains";
import { ethersGateIO, settleFundingExpectFunded } from "./lib/funding-gate";

// Claim a v2 claim link (any mode) from a testnet EOA.
//
// The link secret derives a one-time claim key:
//   Bearer / AddressBound: priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(mode), secret))
//   EmailBound:            priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(1), secret, emailHash))
// The claimer signs ClaimLinks.claimDigest(linkId, claimer) with that key
// (EIP-191 over the raw 32 bytes) and calls claim(linkId, signature).
//
// The contract rejects a sender claiming their own link, so pass
// --claimerkey with a different funded key when the deployer created it.
// Legacy (pre-v2) Bearer/EmailBound links cannot be claimed; the task says so.
//
// On an upgraded ClaimLinks a new link is PendingFunding until someone confirms it.
// The app does that automatically, so a link made in the app is usually already
// Active. If this task finds it still pending it settles the funding check first
// (decrypt the funded bit, confirmFunding), then claims. A link that settled Void
// (the sender's balance was short) cannot be claimed and the task says so.
//
// Usage:
//   npx hardhat claim-claim-link --network eth-sepolia --linkid 0 --secret 0x... [--mode 0] [--email a@b.c] [--claimerkey 0x...]

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

task("claim-claim-link", "Claim a v2 claim link with its secret")
  .addParam("linkid", "On-chain linkId")
  .addParam("secret", "Hex secret (0x-prefixed, 32 bytes)")
  .addOptionalParam("mode", "0 Bearer, 1 EmailBound, 2 AddressBound", "0")
  .addOptionalParam("email", "Email for EmailBound links")
  .addOptionalParam("claimerkey", "Private key of the claimer (defaults to the hardhat signer)")
  .setAction(async ({ linkid, secret, mode, email, claimerkey }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" :
      networkName === "arb-sepolia" ? "arb-sepolia.json" : null;
    if (!deploymentFile) {
      throw new Error(`Unsupported network ${networkName}`);
    }
    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const claimLinksAddr = deployments.ClaimLinks;
    if (!claimLinksAddr) throw new Error(`Missing ClaimLinks in ${deploymentFile}`);

    const modeNum = Number(mode);
    if (![0, 1, 2].includes(modeNum)) throw new Error(`Bad --mode ${mode}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error("--secret must be 0x + 32 bytes hex");

    let priv: Hex;
    if (modeNum === 1) {
      if (!email) throw new Error("--email is required for EmailBound links");
      const emailHash = keccak256(new TextEncoder().encode(String(email).trim().toLowerCase().normalize("NFC")));
      priv = keccak256(encodePacked(["string", "uint8", "bytes32", "bytes32"], ["BLANK_CLAIM_KEY_v2", 1, secret as Hex, emailHash]));
    } else {
      priv = keccak256(encodePacked(["string", "uint8", "bytes32"], ["BLANK_CLAIM_KEY_v2", modeNum, secret as Hex]));
    }
    const n = BigInt(priv);
    if (n === 0n || n >= SECP256K1_N) throw new Error("Secret derives an invalid claim key");
    const claimKeyAccount = privateKeyToAccount(priv);

    const signer = claimerkey
      ? new hre.ethers.Wallet(String(claimerkey), hre.ethers.provider)
      : (await hre.ethers.getSigners())[0];
    const claimerAddress = await signer.getAddress();

    const claimLinks = new hre.ethers.Contract(
      claimLinksAddr,
      [
        "function claim(uint256 linkId, bytes signature)",
        "function claimDigest(uint256 linkId, address claimer) view returns (bytes32)",
        "function claimKeyOf(uint256 linkId) view returns (address)",
        "event LinkClaimed(uint256 indexed linkId, address indexed claimer, uint256 timestamp)",
      ],
      signer,
    );

    console.log(`Network:    ${networkName}`);
    console.log(`Claimer:    ${claimerAddress}`);
    console.log(`linkId:     ${linkid}`);
    console.log(`mode:       ${modeNum}`);
    console.log(`ClaimLinks: ${claimLinksAddr}`);

    const registered = (await claimLinks.claimKeyOf(BigInt(linkid))) as string;
    if (BigInt(registered) === 0n) {
      throw new Error("Legacy link (no claim key). Bearer/EmailBound legacy links are refund-only after expiry.");
    }
    if (registered.toLowerCase() !== claimKeyAccount.address.toLowerCase()) {
      throw new Error(`Secret/email do not match this link (expected key ${registered}, derived ${claimKeyAccount.address})`);
    }

    const gateIO = ethersGateIO("claimLink", [BigInt(linkid)], claimLinksAddr, signer);
    if (await gateIO.supported()) {
      const status = Number(
        await new hre.ethers.Contract(
          claimLinksAddr,
          ["function fundingStatus(uint256) view returns (uint8)"],
          signer,
        ).fundingStatus(BigInt(linkid)),
      );
      if (status === 2) throw new Error("Link settled Void: the sender's balance was short, nothing was locked");
      if (status === 1) {
        console.log("Link is PendingFunding: settling the funding check first...");
        const chainCfg =
          networkName === "base-sepolia" ? { cofhe: baseSepolia, viem: viemBaseSepolia, rpc: "BASE_SEPOLIA_RPC_URL" } :
          networkName === "arb-sepolia" ? { cofhe: arbSepolia, viem: arbitrumSepolia, rpc: "ARBITRUM_SEPOLIA_RPC_URL" } :
          { cofhe: sepolia, viem: viemSepolia, rpc: "SEPOLIA_RPC_URL" };
        const rpcUrl = process.env[chainCfg.rpc] || (hre.network.config as { url: string }).url;
        const pk = claimerkey ?? process.env.PRIVATE_KEY;
        if (!pk) throw new Error("PRIVATE_KEY env (or --claimerkey) needed to decrypt the funding check");
        const account = privateKeyToAccount((String(pk).startsWith("0x") ? String(pk) : `0x${pk}`) as Hex);
        const cofhe = createCofheClient(createCofheConfig({ supportedChains: [chainCfg.cofhe] }));
        await cofhe.connect(
          createPublicClient({ chain: chainCfg.viem, transport: http(rpcUrl) }) as never,
          createWalletClient({ account, chain: chainCfg.viem, transport: http(rpcUrl) }) as never,
        );
        await settleFundingExpectFunded(gateIO, cofhe, { label: `link #${linkid}` });
      }
    }

    const digest = (await claimLinks.claimDigest(BigInt(linkid), claimerAddress)) as Hex;
    const signature = await claimKeyAccount.signMessage({ message: { raw: digest } });

    console.log("");
    console.log("Claiming...");
    const tx = await claimLinks.claim(BigInt(linkid), signature, { gasLimit: 5_000_000 });
    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait(2);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`claim reverted: status=${receipt?.status}`);
    }

    const iface = claimLinks.interface;
    let claimer: string | null = null;
    let timestamp: bigint | null = null;
    for (const log of receipt.logs ?? []) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "LinkClaimed") {
          claimer = parsed.args.claimer as string;
          timestamp = parsed.args.timestamp as bigint;
          break;
        }
      } catch {
        continue;
      }
    }

    console.log("");
    console.log("Claimed");
    if (claimer) console.log(`  claimer:   ${claimer}`);
    if (timestamp) console.log(`  timestamp: ${new Date(Number(timestamp) * 1000).toISOString()}`);
  });
