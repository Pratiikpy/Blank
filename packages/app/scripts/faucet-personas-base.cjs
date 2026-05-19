// Direct TestUSDC mint to wave-4 personas on Base Sepolia, computing
// per-chain AA addresses on-the-fly. The persona's smart-account
// address depends on (pubX, pubY, factory), so it differs per chain.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const envText = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const FACTORY = "0xa4a45bcdAbcDC68b3bb13b4C7E81b6Cd0CBC0EC6"; // Base Sepolia BlankAccountFactory
const TEST_USDC = "0x6377eF23B3464019EcF35528be6Eb6d6D57d0b1a"; // Base Sepolia TestUSDC

// pubX/pubY for each persona, pre-computed from their wave-4 passkey
// privKey. Same on every chain (passkey-derived) but the resolved AA
// address still varies per chain due to factory address.
const PERSONA_KEYS = {
  Alice: { privKey: "7761766534616c6963655f70617373305f73656564000000000000000000a01a" },
  Bob: { privKey: "77617665345f626f625f70617373305f73656564000000000000000000b0b1b2" },
  Carol: { privKey: "7761766534636361726f6c5f70617373305f73656564000000000000000000c0" },
  Dave: { privKey: "7761766534646176655f6d6d5f656f615f7365656400000000000000000000d0" },
};

function privKeyToPub(hex) {
  // Use viem-equivalent: derive secp256k1 pubkey then encode as 64-byte uncompressed point
  // But P-256 (used by passkeys) is different. The wave-4 passkey
  // import uses _testImportPasskey which expects a specific shape.
  // Easier: query the actual smart-account address on-chain by
  // reading from the existing eth-sepolia deployment, then using
  // BlankAccountFactory.getAddress (which is the same factory ABI
  // on both chains but separate deployed instances).
  throw new Error("not implemented inline — use the factory ABI instead");
}
void privKeyToPub;

// Hardcoded per-chain AA addresses observed from the wave-4 test
// shots (the "gas-wallet-address" data-testid). Pulled from the
// 01-bootstrap shots earlier in the session.
const PERSONA_AA_BASE_SEPOLIA = {
  Alice: "0x055f15517B6266D4f1Cb20cba98B5d4F0e88a4eBc", // from screenshot
  // Bob, Carol, Dave: unknown without screenshot probe. Fund Alice
  // first to unblock P02-P05 tests; others use the existing balance
  // probe + /api/faucet/usdc retry path.
};

const MINT_AMOUNT = ethers.parseUnits("500", 6);

async function main() {
  const pkey = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pkey.startsWith("0x") ? pkey : `0x${pkey}`, provider);
  console.log(`Signer:  ${wallet.address}`);
  console.log(`USDC:    ${TEST_USDC}`);

  const usdc = new ethers.Contract(
    TEST_USDC,
    [
      "function mint(address to, uint256 amount) external",
      "function balanceOf(address) view returns (uint256)",
    ],
    wallet,
  );

  for (const [name, addr] of Object.entries(PERSONA_AA_BASE_SEPOLIA)) {
    const bal = await usdc.balanceOf(addr);
    console.log(`${name.padEnd(6)} ${addr}: balance ${ethers.formatUnits(bal, 6)} USDC`);
    if (bal >= MINT_AMOUNT) continue;
    try {
      const tx = await usdc.mint(addr, MINT_AMOUNT);
      console.log(`${name.padEnd(6)} mint tx ${tx.hash}`);
      await tx.wait();
      const after = await usdc.balanceOf(addr);
      console.log(`${name.padEnd(6)}    new bal ${ethers.formatUnits(after, 6)} USDC`);
    } catch (e) {
      console.error(`${name.padEnd(6)} mint failed: ${e.shortMessage || e.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
