import { createPublicClient, http } from "viem";

const ETH = {
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  P2POfframp:          "0x5981C437032Da38844AE9a3aa382F993b1B8444a",
  ReclaimAdapter:      "0xf866EA7630eE91cCcd0Df638679865BCD909cce6",
  MockReclaimVerifier: "0xdfc2606B1Ba148CC35b93849ac888BD7DfFD28a8",
  BlankHandles:        "0xb6F5d0a407B459D7Ab64Ae13dee0f6b371e8eA06",
  GuardianModule:      "0xdBE8252D1e089759b56E742843303f0b18700c3E",
  ProofOfBalance:      "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856",
} as const;

const BASE = {
  rpc: "https://base-sepolia-rpc.publicnode.com",
  P2POfframp:          "0xd717E7AFE5eB627c9913bc682003d6E83b9032f9",
  ReclaimAdapter:      "0x2F7B59A920B76d5fD0e3c010b6a7D5E14eF83486",
  MockReclaimVerifier: "0xB36441E8c4155709E350f7c66B16c2B8174c0e75",
  BlankHandles:        "0x346077e5DA2a552f0353f3430F8baE6D7049DEF9",
  GuardianModule:      "0x4fa2152A940651404F2722c0192624d0662e5B46",
  ProofOfBalance:      "0x25e7383Bd5602a07928629e9Ec6eaec9535536Ff",
} as const;

async function probe(label: string, cfg: Record<string, string>) {
  const c = createPublicClient({ transport: http(cfg.rpc) });
  console.log(`\n== ${label} ==`);
  let allOk = true;
  for (const [name, addr] of Object.entries(cfg).filter(([k]) => k !== "rpc")) {
    try {
      const code = await c.getBytecode({ address: addr as `0x${string}` });
      const size = code ? (code.length - 2) / 2 : 0;
      const verdict = size > 0 ? "OK" : "EMPTY!";
      if (size === 0) allOk = false;
      console.log(`  ${name.padEnd(22)} ${addr}  ${String(size).padStart(5)}B  ${verdict}`);
    } catch (e: unknown) {
      allOk = false;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${name.padEnd(22)} ${addr}  ERR ${msg}`);
    }
  }
  return allOk;
}

const a = await probe("Eth Sepolia (11155111)", ETH);
const b = await probe("Base Sepolia (84532)", BASE);

console.log(`\n== Proxy → impl read-through (P2POfframp.arbiter) ==`);
const readArbiter = async (label: string, rpc: string, addr: string) => {
  const c = createPublicClient({ transport: http(rpc) });
  const abi = [{
    type: "function",
    name: "arbiter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  }] as const;
  try {
    const result = await c.readContract({
      address: addr as `0x${string}`,
      abi,
      functionName: "arbiter",
    });
    console.log(`  ${label.padEnd(22)} arbiter=${result}`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${label.padEnd(22)} READ FAIL: ${msg.slice(0, 80)}`);
    return false;
  }
};
const ra = await readArbiter("Eth Sepolia", ETH.rpc, ETH.P2POfframp);
const rb = await readArbiter("Base Sepolia", BASE.rpc, BASE.P2POfframp);
console.log(`\nresult=${a && b && ra && rb ? "ALL_LIVE_AND_READABLE" : "MISSING"}`);
process.exit(a && b && ra && rb ? 0 : 1);
