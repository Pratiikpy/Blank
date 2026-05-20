import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";

// Wave 4 task #251 — claim a bearer link from the deployer EOA.
//
// In bearer mode, anyone with the secret can claim. We use the deployer
// (same EOA that created the link) as the claimer for testing. After
// this runs, the link is permanently consumed and revisiting the URL
// should show "Already claimed".
//
// Usage:
//   npx hardhat claim-claim-link --network eth-sepolia --linkid 0 --secret 0x...
//   npx hardhat claim-claim-link --network base-sepolia --linkid 0 --secret 0x...

task("claim-claim-link", "Claim a bearer link from the deployer EOA")
  .addParam("linkid", "On-chain linkId")
  .addParam("secret", "Hex secret (0x-prefixed, 32 bytes)")
  .setAction(async ({ linkid, secret }, hre) => {
    const networkName = hre.network.name;
    const deploymentFile =
      networkName === "base-sepolia" ? "base-sepolia.json" :
      networkName === "eth-sepolia" ? "eth-sepolia.json" : null;
    if (!deploymentFile) {
      throw new Error(`Unsupported network ${networkName}`);
    }
    const deployments = JSON.parse(
      readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
    ) as Record<string, string>;

    const claimLinksAddr = deployments.ClaimLinks;
    if (!claimLinksAddr) throw new Error(`Missing ClaimLinks in ${deploymentFile}`);

    const [signer] = await hre.ethers.getSigners();
    const claimLinks = new hre.ethers.Contract(
      claimLinksAddr,
      [
        "function claimBearer(uint256 linkId, bytes32 secret)",
        "event LinkClaimed(uint256 indexed linkId, address indexed claimer, uint256 timestamp)",
      ],
      signer,
    );

    console.log(`Network:    ${networkName}`);
    console.log(`Claimer:    ${signer.address}`);
    console.log(`linkId:     ${linkid}`);
    console.log(`secret:     ${secret}`);
    console.log(`ClaimLinks: ${claimLinksAddr}`);
    console.log("");
    console.log("Claiming...");

    const tx = await claimLinks.claimBearer(BigInt(linkid), secret, { gasLimit: 5_000_000 });
    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait(2);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`claimBearer reverted: status=${receipt?.status}`);
    }

    // Find LinkClaimed
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
    console.log("✓ Claimed");
    if (claimer) console.log(`  claimer:   ${claimer}`);
    if (timestamp) console.log(`  timestamp: ${new Date(Number(timestamp) * 1000).toISOString()}`);
  });
