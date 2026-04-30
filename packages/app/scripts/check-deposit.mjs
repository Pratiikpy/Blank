import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const dep = await c.readContract({
  address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
  functionName: "balanceOf",
  args: ["0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de"],
});
console.log("Paymaster deposit:", Number(dep) / 1e18, "ETH");
const eth = await c.getBalance({ address: "0xb860513A3C5348C46cF52a573Fd743bA03c2c53F" });
console.log("Deployer EOA balance:", Number(eth) / 1e18, "ETH");
