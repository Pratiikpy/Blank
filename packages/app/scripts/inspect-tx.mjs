import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

const PAYMASTER = "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de";
const ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

// Check paymaster deposit
const dep = await client.readContract({
  address: ENTRYPOINT,
  abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
  functionName: "balanceOf",
  args: [PAYMASTER],
});
console.log("Paymaster EntryPoint deposit:", Number(dep) / 1e18, "ETH");

// Inspect last failed tx
const txHash = "0x814cbfa4dc67a7046a4ceeb6619435c929444f10069413a146a37ba9cf947b23";
console.log("\nFetching tx", txHash);
try {
  const tx = await client.getTransaction({ hash: txHash });
  console.log("  from:", tx.from);
  console.log("  to:", tx.to);
  console.log("  value:", tx.value);
  console.log("  gas:", tx.gas);
  console.log("  maxFeePerGas:", tx.maxFeePerGas, "(", Number(tx.maxFeePerGas) / 1e9, "gwei )");
  // decode the call to handleOps to see what UserOp was sent
  const inputData = tx.input;
  console.log("  input prefix:", inputData.slice(0, 10));

  // Try to simulate to get revert reason
  console.log("\nSimulating call to get revert reason...");
  await client.call({
    to: tx.to,
    data: tx.input,
    from: tx.from,
    blockNumber: 40206428n - 1n, // simulate at block before the failure
  });
  console.log("  no revert?!");
} catch (err) {
  console.log("  simulate revert:", err?.message?.split("\n").slice(0, 5).join("\n"));
}
