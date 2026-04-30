// Probe the canonical ERC-6538 singleton on the active network. If it has
// code, no deploy needed — the entire ecosystem (Umbra, Fluidkey, Labrys)
// hardcodes this address and we just record it. If empty, we need to
// deploy our own copy.
import hre from "hardhat";

const CANONICAL = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

async function main() {
  const code = await hre.ethers.provider.getCode(CANONICAL);
  const present = code && code !== "0x";
  console.log(`Network:    ${hre.network.name}`);
  console.log(`Address:    ${CANONICAL}`);
  console.log(`Code size:  ${present ? (code.length - 2) / 2 : 0} bytes`);
  console.log(`Present:    ${present ? "YES" : "NO"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
