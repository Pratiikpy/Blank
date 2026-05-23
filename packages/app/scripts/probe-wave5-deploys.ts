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

type Cfg = typeof ETH;

async function probeBytecode(label: string, cfg: Cfg) {
  const c = createPublicClient({ transport: http(cfg.rpc) });
  console.log(`\n== ${label} (bytecode) ==`);
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

const addressOutAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }],
}] as const;

const uintOutAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint256" }],
}] as const;

const uint32OutAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint32" }],
}] as const;

async function readContractCall<T>(
  rpc: string,
  addr: string,
  label: string,
  fn: string,
  abiBuilder: (name: string) => readonly unknown[],
): Promise<{ ok: boolean; value: T | null }> {
  const c = createPublicClient({ transport: http(rpc) });
  try {
    const value = (await c.readContract({
      address: addr as `0x${string}`,
      abi: abiBuilder(fn) as never,
      functionName: fn,
    })) as T;
    console.log(`  ${label.padEnd(45)} → ${String(value)}`);
    return { ok: true, value };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${label.padEnd(45)} READ FAIL: ${msg.slice(0, 80)}`);
    return { ok: false, value: null };
  }
}

async function probeReads(label: string, cfg: Cfg): Promise<boolean> {
  console.log(`\n== ${label} (proxy → impl reads) ==`);
  const r1 = await readContractCall<string>(cfg.rpc, cfg.P2POfframp, "P2POfframp.arbiter()", "arbiter", addressOutAbi);
  const r2 = await readContractCall<string>(cfg.rpc, cfg.P2POfframp, "P2POfframp.reclaimAdapter()", "reclaimAdapter", addressOutAbi);
  const r3 = await readContractCall<bigint>(cfg.rpc, cfg.GuardianModule, "GuardianModule.RECOVERY_WINDOW_SECONDS()", "RECOVERY_WINDOW_SECONDS", uintOutAbi);
  const r4 = await readContractCall<number>(cfg.rpc, cfg.BlankHandles, "BlankHandles.MIN_HANDLE_LEN()", "MIN_HANDLE_LEN", uint32OutAbi);
  const r5 = await readContractCall<number>(cfg.rpc, cfg.BlankHandles, "BlankHandles.MAX_HANDLE_LEN()", "MAX_HANDLE_LEN", uint32OutAbi);
  const r6 = await readContractCall<string>(cfg.rpc, cfg.MockReclaimVerifier, "MockReclaimVerifier.operator()", "operator", addressOutAbi);

  const consistencyOk = r2.value?.toLowerCase() === cfg.ReclaimAdapter.toLowerCase();
  console.log(`  reclaimAdapter() matches pinned ReclaimAdapter address:    ${consistencyOk ? "YES" : "NO!"}`);

  return r1.ok && r2.ok && r3.ok && r4.ok && r5.ok && r6.ok && consistencyOk;
}

const ethBytecode = await probeBytecode("Eth Sepolia (11155111)", ETH);
const baseBytecode = await probeBytecode("Base Sepolia (84532)", BASE);
const ethReads = await probeReads("Eth Sepolia", ETH);
const baseReads = await probeReads("Base Sepolia", BASE);

const allOk = ethBytecode && baseBytecode && ethReads && baseReads;
console.log(`\nresult=${allOk ? "ALL_LIVE_AND_READABLE" : "MISSING"}`);
process.exit(allOk ? 0 : 1);
