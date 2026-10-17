// Proves the Safe controls a contract: executes an owner-only call through
// Safe.execTransaction with two of the three signer keys.
//
//   SAFE_ENV=<path to signer env> npx hardhat run scripts/safe-owner-call.ts --network arb-sepolia
//
// Calls EncryptedFlags.setFeeRates(100, 5000), the value the security upgrade
// already set, so state does not change; only the owner can make the call.
import hre from "hardhat";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function main() {
  const env = loadEnv(process.env.SAFE_ENV!);
  const d = JSON.parse(readFileSync(resolve(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const safeAddr = hre.ethers.getAddress(env.SAFE_ADDRESS.toLowerCase());
  const flags = await hre.ethers.getContractAt("EncryptedFlags", d.EncryptedFlags);
  if ((await flags.owner()).toLowerCase() !== safeAddr.toLowerCase()) throw new Error("EncryptedFlags is not Safe-owned");

  const safe = new hre.ethers.Contract(safeAddr, [
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
    "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
    "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  ], (await hre.ethers.getSigners())[0]);

  const Z = hre.ethers.ZeroAddress;
  const signers = [env.SAFE_SIGNER_1_PK, env.SAFE_SIGNER_2_PK].map((k) => new hre.ethers.Wallet(k));
  signers.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const exec = async (to: string, data: string, label: string) => {
    const nonce = await safe.nonce();
    const txHash: string = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, Z, Z, nonce);
    // Two of three owners sign the raw Safe tx hash, sorted by owner address.
    const sigs = hre.ethers.concat(signers.map((w) => w.signingKey.sign(txHash).serialized));
    const tx = await safe.execTransaction(to, 0, data, 0, 0, 0, 0, Z, Z, sigs);
    const rcpt = await tx.wait(2);
    const topic = safe.interface.getEvent("ExecutionSuccess")!.topicHash;
    const ok = rcpt!.logs.some((l: { topics: string[] }) => l.topics[0] === topic);
    console.log(`Safe 2-of-3 -> ${label}: ${ok ? "ExecutionSuccess" : "FAILED"} tx=${tx.hash}`);
    if (!ok) process.exit(1);
  };

  // 1. Accept the paymaster (Ownable2Step) if the Safe is its pending owner.
  const pm = new hre.ethers.Contract(d.BlankPaymaster, [
    "function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()",
  ], hre.ethers.provider);
  if ((await pm.pendingOwner()).toLowerCase() === safeAddr.toLowerCase()) {
    await exec(d.BlankPaymaster, pm.interface.encodeFunctionData("acceptOwnership"), "BlankPaymaster.acceptOwnership");
  }
  console.log(`BlankPaymaster owner: ${await pm.owner()}`);

  // 2. An owner-only call the deployer can no longer make.
  const direct = await flags.setFeeRates.staticCall(100, 5000).then(() => "ALLOWED (unexpected)").catch(() => "refused (expected)");
  console.log(`deployer calling EncryptedFlags.setFeeRates directly: ${direct}`);
  await exec(d.EncryptedFlags, flags.interface.encodeFunctionData("setFeeRates", [100, 5000]), "EncryptedFlags.setFeeRates");
}

main().catch((e) => { console.error(e); process.exit(1); });
