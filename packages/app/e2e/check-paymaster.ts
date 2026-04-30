import { createPublicClient, http, formatEther } from "viem";
import { baseSepolia } from "viem/chains";

const RPC = "https://base-sepolia.g.alchemy.com/v2/jmgwyYAyA7jdRMRZroyBj";
const ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const PAYMASTER = "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de";

const ENTRYPOINT_ABI = [
  {
    name: "getDepositInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        components: [
          { name: "deposit", type: "uint256" },
          { name: "staked", type: "bool" },
          { name: "stake", type: "uint112" },
          { name: "unstakeDelaySec", type: "uint32" },
          { name: "withdrawTime", type: "uint48" },
        ],
        type: "tuple",
      },
    ],
  },
] as const;

async function main() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const info = (await client.readContract({
    address: ENTRYPOINT as `0x${string}`,
    abi: ENTRYPOINT_ABI,
    functionName: "getDepositInfo",
    args: [PAYMASTER as `0x${string}`],
  })) as { deposit: bigint; staked: boolean; stake: bigint };
  console.log("Paymaster:    ", PAYMASTER);
  console.log("Deposit:      ", formatEther(info.deposit), "ETH");
  console.log("Stake:        ", formatEther(info.stake), "ETH");
  console.log("Staked:       ", info.staked);
  // Audit threshold check
  const FAIL_FLOOR = 5n * 10n ** 16n; // 0.05 ETH
  const status = info.deposit < FAIL_FLOOR ? "UNAVAILABLE" : "OK";
  console.log("Status:       ", status, "(fail floor 0.05 ETH)");
}

main().catch((e) => { console.error(e); process.exit(1); });
