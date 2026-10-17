#!/usr/bin/env node
// Reads every plain (non-mapping, non-array, single-slot) state variable of
// every deployed proxy straight from storage and checks the raw value has the
// shape its declared type allows. A slot shifted by a past bad upgrade shows
// up as e.g. a bool where a ciphertext handle should be.
//
//   node scripts/storage-sanity.cjs <eth-sepolia|base-sepolia|arb-sepolia> [--base main]
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const net = process.argv[2];
const baseRef = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "main";
const rpcVar = { "eth-sepolia": "SEPOLIA_RPC_URL", "base-sepolia": "BASE_SEPOLIA_RPC_URL", "arb-sepolia": "ARBITRUM_SEPOLIA_RPC_URL" }[net];
if (!rpcVar) throw new Error("usage: storage-sanity.cjs <network>");
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]),
);
const rpc = env[rpcVar];
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), "utf8"));

const PROXY_KEYS = {
  TokenRegistry: "TokenRegistry", FHERC20Vault_USDC: "FHERC20Vault", FHERC20Vault_USDT: "FHERC20Vault",
  PaymentReceipts: "PaymentReceipts", EventHub: "EventHub", EncryptedFlags: "EncryptedFlags", PaymentHub: "PaymentHub",
  EncryptedEscrow: "EncryptedEscrow", BusinessHub: "BusinessHub", GroupManager: "GroupManager", GiftMoney: "GiftMoney",
  ClaimLinks: "ClaimLinks", Storefront: "Storefront", EncryptedCrowdfund: "EncryptedCrowdfund", CreatorHub: "CreatorHub",
  PrivacyRouter: "PrivacyRouter", StealthPayments: "StealthPayments", InheritanceManager: "InheritanceManager",
  P2PExchange: "P2PExchange", ProofOfBalance: "ProofOfBalance", MockReclaimVerifier: "MockReclaimVerifier",
  ReclaimAdapter: "ReclaimAdapter", P2POfframp: "P2POfframp", GuardianModule: "GuardianModule", BlankHandles: "BlankHandles",
};

async function storageAt(addr, slot) {
  const res = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [addr, "0x" + slot.toString(16), "latest"] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return BigInt(j.result);
}

function classify(type, label) {
  if (/^t_mapping|^t_array|^t_struct|^t_string|^t_bytes_storage/.test(type) || label === "__gap") return null;
  if (/^t_bool/.test(type)) return "bool";
  if (/^t_address|^t_contract/.test(type)) return "address";
  if (/^t_userDefinedValueType\(e(uint|bool|address)/.test(type)) return "handle";
  if (/^t_uint|^t_int|^t_enum|^t_bytes/.test(type)) return "number";
  return null;
}

(async () => {
  let bad = 0;
  for (const [key, contract] of Object.entries(PROXY_KEYS)) {
    if (!d[key]) continue;
    let layout;
    try {
      layout = JSON.parse(execSync(`git show ${baseRef}:"packages/contracts/storage-layouts/${contract}.json"`, { stdio: ["ignore", "pipe", "ignore"] }).toString());
    } catch { console.log(`[skip] ${key}: no snapshot at ${baseRef}`); continue; }
    const issues = [];
    const bySlot = {};
    for (const s of layout.storage) (bySlot[s.slot] ||= []).push(s);
    for (const [slot, vars] of Object.entries(bySlot)) {
      const kinds = vars.map((v) => classify(v.type, v.label));
      if (kinds.some((k) => k === null)) continue;
      const raw = await storageAt(d[key], BigInt(slot));
      if (vars.length === 1) {
        const k = kinds[0], v = vars[0];
        const bits = raw === 0n ? 0 : raw.toString(2).length;
        if (k === "bool" && raw > 1n) issues.push(`${v.label}@${slot} bool holds 0x${raw.toString(16)}`);
        if (k === "address" && bits > 160) issues.push(`${v.label}@${slot} address holds 0x${raw.toString(16)}`);
        if (k === "handle" && raw !== 0n && bits < 128) issues.push(`${v.label}@${slot} ciphertext handle holds small value 0x${raw.toString(16)}`);
      } else if (kinds.every((k) => k === "bool" || k === "address" || k === "number")) {
        // packed slot: check each piece's bytes stay within its own width
        for (const v of vars) {
          const width = BigInt((layout.types[v.type] || {}).numberOfBytes || "32") * 8n;
          const piece = (raw >> (BigInt(v.offset) * 8n)) & ((1n << width) - 1n);
          if (classify(v.type, v.label) === "bool" && piece > 1n) issues.push(`${v.label}@${slot}+${v.offset} bool holds ${piece}`);
        }
      }
    }
    if (issues.length) { bad++; console.log(`[SUSPECT] ${key} (${d[key]})\n  ${issues.join("\n  ")}`); }
    else console.log(`[ok] ${key}`);
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
