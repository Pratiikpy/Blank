// Resolve each persona's Base Sepolia AA address by deriving the P-256
// pubkey from their privKey then calling BlankAccountFactory.getAddress,
// then mint 500 TestUSDC to each. Fully autonomous — no screenshots
// needed.
const { ethers } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envText = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const DEPLOYMENTS = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "..", "..", "contracts", "deployments", "base-sepolia.json"),
    "utf8",
  ),
);

const FACTORY = DEPLOYMENTS.BlankAccountFactory;
const TEST_USDC = DEPLOYMENTS.TestUSDC;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const PERSONA_PRIVKEYS = {
  Alice: "7761766534616c6963655f70617373305f73656564000000000000000000a01a",
  Bob:   "77617665345f626f625f70617373305f73656564000000000000000000b0b1b2",
  Carol: "7761766534636361726f6c5f70617373305f73656564000000000000000000c0",
  Dave:  "7761766534646176655f6d6d5f656f615f7365656400000000000000000000d0",
};

const MINT_AMOUNT = ethers.parseUnits("500", 6);

// @noble/curves v2 is ESM-only and exports p256 from `nist.js`.
// Dynamic import from CJS works.
let p256;
async function loadNoble() {
  if (p256) return;
  const NIST_URL = require("url").pathToFileURL(
    path.resolve(__dirname, "..", "node_modules", "@noble", "curves", "nist.js"),
  ).href;
  const mod = await import(NIST_URL);
  p256 = mod.p256;
}

function privToPubXY(privHex) {
  const privBuf = Buffer.from(privHex, "hex");
  const pub = Buffer.from(p256.getPublicKey(privBuf, false)); // 65 bytes
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("bad pubkey shape");
  return {
    pubX: "0x" + pub.slice(1, 33).toString("hex"),
    pubY: "0x" + pub.slice(33, 65).toString("hex"),
  };
}

async function main() {
  await loadNoble();
  console.log(`Factory:  ${FACTORY}`);
  console.log(`TestUSDC: ${TEST_USDC}`);
  const provider = new ethers.JsonRpcProvider(RPC);
  const pkey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const wallet = new ethers.Wallet(pkey.startsWith("0x") ? pkey : `0x${pkey}`, provider);
  console.log(`Signer:   ${wallet.address}`);

  // Avoid ethers' .getAddress() shadow by using callStatic via interface
  const factoryAbi = ["function getAddress(uint256 pubX, uint256 pubY, address creator, uint256 salt) view returns (address)"];
  const factory = new ethers.Contract(FACTORY, factoryAbi, provider);
  const usdc = new ethers.Contract(
    TEST_USDC,
    ["function mint(address to, uint256 amount) external", "function balanceOf(address) view returns (uint256)"],
    wallet,
  );

  for (const [name, privHex] of Object.entries(PERSONA_PRIVKEYS)) {
    const { pubX, pubY } = privToPubXY(privHex);
    console.log(`${name.padEnd(6)} pubX=${pubX.slice(0,18)}... pubY=${pubY.slice(0,18)}...`);
    // Use raw call to bypass ethers Contract's getAddress() shadow.
    const data = factory.interface.encodeFunctionData("getAddress", [
      BigInt(pubX),
      BigInt(pubY),
      ZERO_ADDRESS,
      0n,
    ]);
    const result = await provider.call({ to: FACTORY, data });
    const [aaAddr] = factory.interface.decodeFunctionResult("getAddress", result);
    const bal = await usdc.balanceOf(aaAddr);
    console.log(`${name.padEnd(6)} ${aaAddr}  ${ethers.formatUnits(bal, 6)} USDC`);
    if (bal >= MINT_AMOUNT) continue;
    try {
      const tx = await usdc.mint(aaAddr, MINT_AMOUNT);
      await tx.wait();
      const after = await usdc.balanceOf(aaAddr);
      console.log(`  ↳ minted: ${tx.hash}  new bal ${ethers.formatUnits(after, 6)} USDC`);
    } catch (e) {
      console.error(`  ↳ mint failed: ${e.shortMessage || e.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
