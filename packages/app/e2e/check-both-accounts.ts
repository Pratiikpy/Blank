import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem";
import { sepolia, baseSepolia } from "viem/chains";

const ACCOUNTS = {
  A: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
  B: "0x135694d9578e6f355B80C3D259e4F7D5e2c76DE3",
};

const CHAINS = [
  {
    name: "ETH Sepolia",
    chain: sepolia,
    rpc: process.env.SEPOLIA_RPC_URL ?? "https://eth-sepolia.g.alchemy.com/v2/TyCbYb1lvu4L9oEPnE6ah",
    deployments: "../../contracts/deployments/eth-sepolia.json",
  },
  {
    name: "Base Sepolia",
    chain: baseSepolia,
    rpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/jmgwyYAyA7jdRMRZroyBj",
    deployments: "../../contracts/deployments/base-sepolia.json",
  },
];

async function main() {
  for (const c of CHAINS) {
    console.log(`\n=== ${c.name} ===`);
    const client = createPublicClient({ chain: c.chain, transport: http(c.rpc) });
    const deployments = (await import(c.deployments, { assert: { type: "json" } })) as {
      default: Record<string, string>;
    };
    const usdc = deployments.default.TestUSDC;
    for (const [label, addr] of Object.entries(ACCOUNTS)) {
      try {
        const eth = await client.getBalance({ address: addr as `0x${string}` });
        const code = await client.getCode({ address: addr as `0x${string}` });
        let usdcBal = 0n;
        if (usdc) {
          try {
            usdcBal = (await client.readContract({
              address: usdc as `0x${string}`,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [addr as `0x${string}`],
            })) as bigint;
          } catch {/* ignore */}
        }
        console.log(
          `  ${label} ${addr}  ETH=${formatEther(eth)}  USDC=${formatUnits(usdcBal, 6)}  deployed=${code && code !== "0x" ? "Y" : "N"}`,
        );
      } catch (e) {
        console.log(`  ${label} ${addr}  RPC error:`, e instanceof Error ? e.message.slice(0, 100) : e);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
