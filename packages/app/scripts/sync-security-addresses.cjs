#!/usr/bin/env node
// Copies the addresses that changed in the security-v1 rollout from
// packages/contracts/deployments/<chain>.json into src/lib/constants.ts and
// api/_lib/addresses.ts. Only rewrites a key inside its own chain block, and
// fails loudly if a key is not found exactly once there.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const deployments = path.join(root, "..", "contracts", "deployments");
const CHAINS = [
  { id: "ETH_SEPOLIA_ID", file: "eth-sepolia.json" },
  { id: "BASE_SEPOLIA_ID", file: "base-sepolia.json" },
  { id: "ARB_SEPOLIA_ID", file: "arb-sepolia.json" },
];
const KEYS = {
  "src/lib/constants.ts": [
    "BlankPaymaster", "BurnerRegistry", "BlankAccount_Impl_security_v1",
    "SessionKeyValidator", "InvoiceApprovalResolver",
  ],
  "api/_lib/addresses.ts": ["BlankPaymaster"],
};
const ZERO = "0x0000000000000000000000000000000000000000";

for (const [rel, keys] of Object.entries(KEYS)) {
  const file = path.join(root, rel);
  let src = fs.readFileSync(file, "utf8");
  for (const c of CHAINS) {
    const d = JSON.parse(fs.readFileSync(path.join(deployments, c.file), "utf8"));
    // The last `[ID]: {` block in the file is the contract map (earlier ones
    // are RPC lists and chain metadata).
    const open = src.lastIndexOf(`[${c.id}]: {`);
    if (open < 0) throw new Error(`${rel}: no block for ${c.id}`);
    const close = src.indexOf("\n  },", open);
    let block = src.slice(open, close);
    for (const k of keys) {
      const want = d[k] || ZERO;
      const re = new RegExp(`(\\n\\s+${k}: )"0x[0-9a-fA-F]{40}"`, "g");
      const hits = block.match(re) || [];
      if (hits.length !== 1) throw new Error(`${rel} ${c.id}: ${k} found ${hits.length} times`);
      block = block.replace(re, `$1"${want}"`);
      console.log(`${rel} ${c.id} ${k} = ${want}`);
    }
    src = src.slice(0, open) + block + src.slice(close);
  }
  fs.writeFileSync(file, src);
}
