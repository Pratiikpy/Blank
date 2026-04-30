#!/usr/bin/env node
/**
 * Import boundary check.
 *
 * Enforces conventions that aren't easily expressed in TypeScript itself:
 *   1. `@cofhe/*` is only consumed via `lib/cofhe-shim.ts`. Anywhere else
 *      pinning to the SDK directly means a v0.6 breaking change is a
 *      multi-file refactor instead of one file.
 *   2. `viem/chains` chain objects are only imported in `lib/rpc.ts` (or
 *      `lib/viem-chains.ts` once it lands). Hooks and screens must reach
 *      a chain via `useChain()` so a runtime chain switch propagates.
 *   3. `useWriteContract` from wagmi is only consumed inside
 *      `hooks/useUnifiedWrite.ts` (and a small allowlist of EOA-only
 *      escape hatches). Direct usage breaks the passkey-AA path.
 *
 * Run via `pnpm check:imports`. CI also runs it via `pnpm ci`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(__dirname, "..", "src");

const RULES = [
  {
    name: "cofhe-import-boundary",
    pattern: /from\s+["']@cofhe\//,
    allow: [
      ["lib", "cofhe-shim.ts"].join(sep),
      // cofhe-config is the SDK init module — same boundary role as the
      // shim. It legitimately needs `@cofhe/sdk/chains` to register
      // supported networks at boot.
      ["lib", "cofhe-config.ts"].join(sep),
    ],
    description:
      "Direct @cofhe/* imports — route through lib/cofhe-shim.ts so a v0.6 SDK bump is one file, not 21.",
  },
  {
    name: "viem-chains-boundary",
    pattern: /from\s+["']viem\/chains["']/,
    allow: [
      ["lib", "rpc.ts"].join(sep),
      ["lib", "viem-chains.ts"].join(sep),
      // ENS resolution is mainnet-only by design — there's no equivalent
      // on Base Sepolia or Eth Sepolia for the ENS registry. Hardcoding
      // mainnet here is correct, not drift.
      ["lib", "ens-client.ts"].join(sep),
    ],
    description:
      "Direct `viem/chains` imports — chain objects must flow through useChain() so a runtime switch propagates.",
  },
  {
    name: "wagmi-write-boundary",
    pattern: /\buseWriteContract\b/,
    allow: [
      ["hooks", "useUnifiedWrite.ts"].join(sep),
      // EOA-only escape hatches. Each one is intentional:
      //   - useStealthSweep: sweeps from a freshly-derived stealth EOA;
      //     no AA path applies.
      //   - SmartWallet.handleFund: moves USDC EOA → smart account; the
      //     AA path would self-transfer (no-op). Documented inline.
      ["hooks", "useStealthSweep.ts"].join(sep),
      ["blank-ui", "screens", "SmartWallet.tsx"].join(sep),
    ],
    description:
      "Direct useWriteContract — passkey-AA path requires useUnifiedWrite. Add an entry to the allow list if EOA-only is intentional.",
  },
];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC, []);
let violations = 0;

for (const rule of RULES) {
  for (const file of files) {
    const rel = relative(SRC, file);
    if (rule.allow.some((a) => rel === a)) continue;
    const text = readFileSync(file, "utf8");
    if (rule.pattern.test(text)) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          console.error(
            `[${rule.name}] ${rel}:${i + 1}\n  ${lines[i].trim()}\n  ${rule.description}\n`,
          );
          violations++;
        }
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nImport boundary check failed: ${violations} violation(s).`);
  process.exit(1);
}
console.log("Import boundary check passed.");
