#!/usr/bin/env tsx
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { readEntries } from "../helpers/testing-todo";

// ──────────────────────────────────────────────────────────────────
//  Phase 14 — Wave 4 E2E summary.
//
//  Runs after `pnpm e2e:wave4` + `pnpm e2e:audit` succeed. Prints
//  the final replayable proof report a judge can copy/paste into a
//  submission:
//
//    • # tx hashes captured (split by chain)
//    • # screenshots captured (counted from the test-results dir)
//    • # URL artifacts captured (split by surface type)
//    • Where the artifacts live on disk
//
//  Why a separate command + not just stderr in the runner: judges
//  often pipe `pnpm e2e` into a file. A clean summary section at
//  the END of stdout is what they paste; intermediate playwright
//  noise is grep-able but ugly.
// ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const TEST_RESULTS = path.resolve(__dirname, "../../../test-results");

function countFiles(root: string, predicate: (p: string) => boolean): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true }) as fs.Dirent[]) {
    const full = path.join(entry.parentPath ?? entry.path ?? root, entry.name);
    if (entry.isFile() && predicate(full)) count++;
  }
  return count;
}

function main(): void {
  const entries = readEntries();
  const byChain = new Map<number, number>();
  const urlArtifactsByKind = new Map<string, number>();
  let realTxCount = 0;
  let syntheticTxCount = 0;
  const ZERO_HASH = `0x${"0".repeat(64)}`;

  for (const e of entries) {
    byChain.set(e.chainId, (byChain.get(e.chainId) ?? 0) + 1);
    if (e.txHash === ZERO_HASH) syntheticTxCount++;
    else realTxCount++;
    if (e.urlArtifact) {
      const url = e.urlArtifact.toLowerCase();
      const kind = url.includes("/v/") || url.includes("/verify")
        ? "verify"
        : url.includes("/claim")
          ? "claim"
          : url.includes("/shop")
            ? "shop"
            : url.includes("/fund")
              ? "fund"
              : url.includes("/i/")
                ? "invoice"
                : "other";
      urlArtifactsByKind.set(kind, (urlArtifactsByKind.get(kind) ?? 0) + 1);
    }
  }

  const screenshots = countFiles(TEST_RESULTS, (p) => p.endsWith(".png"));
  const videos = countFiles(TEST_RESULTS, (p) => p.endsWith(".webm"));
  const totalUrlArtifacts = Array.from(urlArtifactsByKind.values()).reduce((a, b) => a + b, 0);

  console.log("");
  console.log("══════ Wave 4 E2E — final report ══════");
  console.log("");
  console.log(`Proof entries:           ${entries.length}`);
  console.log(`  real on-chain hashes:  ${realTxCount}`);
  console.log(`  synthetic (UI-gated):  ${syntheticTxCount}`);
  console.log("");
  console.log("Tx hashes by chain:");
  for (const [chainId, count] of [...byChain.entries()].sort()) {
    const name =
      chainId === 11155111
        ? "Ethereum Sepolia"
        : chainId === 84532
          ? "Base Sepolia"
          : chainId === 421614
            ? "Arbitrum Sepolia"
            : `chain ${chainId}`;
    console.log(`  ${chainId.toString().padEnd(10)} ${name.padEnd(20)} ${count} entr${count === 1 ? "y" : "ies"}`);
  }
  console.log("");
  console.log(`URL artifacts (${totalUrlArtifacts} total):`);
  for (const [kind, count] of [...urlArtifactsByKind.entries()].sort()) {
    console.log(`  ${kind.padEnd(10)} ${count}`);
  }
  console.log("");
  console.log(`Screenshots:             ${screenshots} (.png in test-results/)`);
  console.log(`Videos:                  ${videos} (.webm in test-results/)`);
  console.log("");
  console.log("Artifacts on disk:");
  console.log(`  proof block:           ${path.join(REPO_ROOT, "WAVE4_TESTING_TODO.md")}`);
  console.log(`  screenshots + videos:  ${TEST_RESULTS}`);
  console.log(`  HTML report:           ${path.join(TEST_RESULTS, "wave4-html/index.html")}`);
  console.log(`  JSON report:           ${path.join(TEST_RESULTS, "wave4-results.json")}`);
  console.log("");
  console.log("═══════════════════════════════════════");
}

main();
