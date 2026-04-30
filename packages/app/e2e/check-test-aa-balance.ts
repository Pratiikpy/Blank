import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/jmgwyYAyA7jdRMRZroyBj";
const TEST_AA = "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f";

async function main() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

  const eth = await client.getBalance({ address: TEST_AA as `0x${string}` });
  const code = await client.getCode({ address: TEST_AA as `0x${string}` });
  console.log("AA address:    ", TEST_AA);
  console.log("AA ETH balance:", formatEther(eth));
  console.log("AA deployed:   ", code && code !== "0x" ? "yes" : "no (counterfactual)");

  // Read deployed contract addresses
  const deployments = (await import("../../contracts/deployments/base-sepolia.json", { assert: { type: "json" } })) as {
    default: Record<string, string>;
  };
  const TEST_USDC = deployments.default.TestUSDC;
  console.log("TestUSDC addr: ", TEST_USDC);

  try {
    const usdc = (await client.readContract({
      address: TEST_USDC as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [TEST_AA as `0x${string}`],
    })) as bigint;
    console.log("AA TestUSDC:   ", formatUnits(usdc, 6));
  } catch (e) {
    console.log("AA TestUSDC read failed:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
