import { createPublicClient, http, getAddress } from "viem";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// EIP-1967 implementation address slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const WAVE5_CONTRACT_NAMES = [
  "P2POfframp",
  "ReclaimAdapter",
  "MockReclaimVerifier",
  "BlankHandles",
  "GuardianModule",
  "ProofOfBalance",
] as const;

type Wave5Name = (typeof WAVE5_CONTRACT_NAMES)[number];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function loadDeploymentJson(file: string): Record<string, string> {
  const path = resolve(REPO_ROOT, "packages", "contracts", "deployments", file);
  return JSON.parse(readFileSync(path, "utf8"));
}

function extractWave5(deployment: Record<string, string>): Record<Wave5Name, string> {
  const out = {} as Record<Wave5Name, string>;
  for (const name of WAVE5_CONTRACT_NAMES) {
    if (!deployment[name]) throw new Error(`Missing ${name} in deployment JSON`);
    out[name] = deployment[name];
  }
  return out;
}

const ETH_DEPLOYMENT = extractWave5(loadDeploymentJson("eth-sepolia.json"));
const BASE_DEPLOYMENT = extractWave5(loadDeploymentJson("base-sepolia.json"));

const ETH = {
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  ...ETH_DEPLOYMENT,
};
const BASE = {
  rpc: "https://base-sepolia-rpc.publicnode.com",
  ...BASE_DEPLOYMENT,
};
type Cfg = typeof ETH;

// Drift check: parse constants.ts as text and confirm the Wave 5 addresses
// in CONTRACTS_BY_CHAIN match the deployment JSON. Catches the case where
// a deploy updates the JSON but constants.ts wasn't repinned (or vice versa).
function checkConstantsTsDrift(): boolean {
  const constantsPath = resolve(REPO_ROOT, "packages", "app", "src", "lib", "constants.ts");
  const src = readFileSync(constantsPath, "utf8");
  console.log("\n== Drift check: constants.ts vs deployment JSON ==");
  let allOk = true;
  for (const [chainLabel, deployment] of [
    ["Eth Sepolia", ETH_DEPLOYMENT],
    ["Base Sepolia", BASE_DEPLOYMENT],
  ] as const) {
    for (const name of WAVE5_CONTRACT_NAMES) {
      const target = deployment[name].toLowerCase();
      const found = src.toLowerCase().includes(target);
      const verdict = found ? "OK" : "MISSING!";
      if (!found) allOk = false;
      console.log(`  ${chainLabel.padEnd(14)} ${name.padEnd(22)} ${verdict}`);
    }
  }
  return allOk;
}

async function probeBytecode(label: string, cfg: Cfg) {
  const c = createPublicClient({ transport: http(cfg.rpc) });
  console.log(`\n== ${label} (proxy + impl bytecode) ==`);
  let allOk = true;
  for (const name of WAVE5_CONTRACT_NAMES) {
    const addr = cfg[name];
    try {
      const proxyCode = await c.getBytecode({ address: addr as `0x${string}` });
      const proxySize = proxyCode ? (proxyCode.length - 2) / 2 : 0;
      const proxyVerdict = proxySize > 0 ? "OK" : "EMPTY!";

      const implSlotRaw = await c.getStorageAt({
        address: addr as `0x${string}`,
        slot: EIP1967_IMPL_SLOT,
      });
      const implAddr = implSlotRaw
        ? getAddress("0x" + implSlotRaw.slice(-40))
        : null;

      let implSize = 0;
      let implVerdict = "MISSING_SLOT";
      if (implAddr && implAddr !== "0x0000000000000000000000000000000000000000") {
        const implCode = await c.getBytecode({ address: implAddr });
        implSize = implCode ? (implCode.length - 2) / 2 : 0;
        implVerdict = implSize > 0 ? "OK" : "EMPTY_IMPL!";
      }

      if (proxySize === 0 || implSize === 0) allOk = false;
      console.log(
        `  ${name.padEnd(22)} proxy=${String(proxySize).padStart(5)}B ${proxyVerdict.padEnd(8)} ` +
          `impl=${implAddr ?? "?"} ${String(implSize).padStart(6)}B ${implVerdict}`,
      );
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

const uint32OutAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint32" }],
}] as const;

const uintOutAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint256" }],
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

const driftOk = checkConstantsTsDrift();
const ethBytecode = await probeBytecode("Eth Sepolia (11155111)", ETH);
const baseBytecode = await probeBytecode("Base Sepolia (84532)", BASE);
const ethReads = await probeReads("Eth Sepolia", ETH);
const baseReads = await probeReads("Base Sepolia", BASE);

const allOk = driftOk && ethBytecode && baseBytecode && ethReads && baseReads;
console.log(`\nresult=${allOk ? "ALL_LIVE_AND_READABLE" : "MISSING"}`);
process.exit(allOk ? 0 : 1);
