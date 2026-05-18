const { ethers } = require("ethers");
const RPC = process.argv[3] || "https://ethereum-sepolia.publicnode.com";
const TX = process.argv[2] || "0xcac54cc25950c072fa29ac81dfd2e1ce7910d3f427bb55fab66785559d46eff1";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const tx = await provider.getTransaction(TX);
  if (!tx) { console.log("tx not found"); return; }
  console.log("from:", tx.from);
  console.log("to:  ", tx.to);
  console.log("data:", tx.data.slice(0, 200) + "...");
  // Try to re-simulate via eth_call at the failing block to get revert reason.
  try {
    const result = await provider.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gasLimit: tx.gasLimit,
    }, tx.blockNumber - 1);
    console.log("eth_call result:", result);
  } catch (e) {
    console.log("eth_call revert reason:", e.message || e);
    if (e.data) console.log("revert data:", e.data);
  }
  // Also try to debug_traceTransaction if supported.
  try {
    const trace = await provider.send("debug_traceTransaction", [TX, { tracer: "callTracer" }]);
    console.log("trace:", JSON.stringify(trace, null, 2).slice(0, 800));
  } catch (e) {
    console.log("trace unsupported:", e.message?.slice(0, 100));
  }
}
main();
