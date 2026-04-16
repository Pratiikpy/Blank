/**
 * check-storage-layout — Snapshot & verify Solidity storage layouts.
 *
 * WHY:
 *   UUPS upgradeable contracts share storage with their new implementation.
 *   Re-ordering, removing, or changing the type of a state variable silently
 *   corrupts state after an upgrade. This task freezes the storage layout of
 *   every tracked contract to JSON so a reviewer (and CI) can diff against the
 *   blessed layout before a dangerous upgrade lands.
 *
 * FLAGS:
 *   --check   Compare compiled layouts against the JSON snapshots in
 *             packages/contracts/storage-layouts. Exits non-zero on any diff.
 *             This is the CI mode.
 *   --write   Overwrite the JSON snapshots with the current layouts. Run this
 *             *intentionally* after an approved struct / storage change, then
 *             commit the diff — it's the "bless a new layout" knob.
 *
 *   If neither flag is passed, --check is assumed (safer default).
 *
 * HOW IT WORKS:
 *   Hardhat's default solc output does NOT include storageLayout. We request
 *   it via a compile-settings override (see the `solcInputOverride` below). We
 *   then read the Build Info JSON that Hardhat writes for each compilation
 *   and pull `output.contracts[source][name].storageLayout` for every tracked
 *   UUPS contract.
 *
 *   We write one file per contract:
 *     packages/contracts/storage-layouts/<ContractName>.json
 *
 *   The JSON shape is solc's native storageLayout: `{ storage, types }`.
 *
 * NOTE:
 *   We intentionally don't use `@openzeppelin/hardhat-upgrades` here — the
 *   project isn't configured with it, and this task stays deliberately small
 *   and portable. Swap it in later if richer validation is desired.
 */

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// The list of UUPS upgradeable contracts we track. Keep this in sync when
// adding a new proxy-fronted contract.
const TRACKED_CONTRACTS: string[] = [
  "FHERC20Vault",
  "PaymentHub",
  "PaymentReceipts",
  "BusinessHub",
  "P2PExchange",
  "GroupManager",
  "GiftMoney",
  "StealthPayments",
  "InheritanceManager",
  "PrivacyRouter",
  "CreatorHub",
];

const SNAPSHOT_DIR = path.join(__dirname, "..", "storage-layouts");

type StorageLayout = {
  storage: unknown[];
  types: Record<string, unknown> | null;
};

/**
 * Re-compile with storageLayout requested, then walk the build-info files to
 * pluck each tracked contract's layout. We compile fresh to guarantee the
 * output is current even if the user ran `hardhat compile` without the
 * override earlier in the session.
 */
async function collectLayouts(
  hre: HardhatRuntimeEnvironment
): Promise<Map<string, StorageLayout>> {
  // Force solc to emit storageLayout for this run. This mutates the in-memory
  // config only — it does not touch hardhat.config.ts on disk.
  for (const compiler of hre.config.solidity.compilers) {
    const out = (compiler.settings.outputSelection ??= {});
    const star = (out["*"] ??= {});
    const contractLevel = (star["*"] ??= []);
    if (!contractLevel.includes("storageLayout")) {
      contractLevel.push("storageLayout");
    }
  }

  // Nuke any stale artifacts so solc actually re-runs with the new selection.
  await hre.run("clean");
  await hre.run("compile", { quiet: true });

  const layouts = new Map<string, StorageLayout>();
  const buildInfoPaths = await hre.artifacts.getBuildInfoPaths();

  for (const buildInfoPath of buildInfoPaths) {
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    const contracts = buildInfo?.output?.contracts ?? {};

    for (const sourceFile of Object.keys(contracts)) {
      const bySource = contracts[sourceFile] ?? {};
      for (const contractName of Object.keys(bySource)) {
        if (!TRACKED_CONTRACTS.includes(contractName)) continue;
        const layout = bySource[contractName]?.storageLayout;
        if (layout) {
          // First-seen wins — a contract should live in exactly one source.
          if (!layouts.has(contractName)) {
            layouts.set(contractName, {
              storage: layout.storage ?? [],
              types: layout.types ?? null,
            });
          }
        }
      }
    }
  }

  return layouts;
}

function layoutPath(contractName: string): string {
  return path.join(SNAPSHOT_DIR, `${contractName}.json`);
}

function readSnapshot(contractName: string): StorageLayout | null {
  const p = layoutPath(contractName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeSnapshot(contractName: string, layout: StorageLayout): void {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  fs.writeFileSync(
    layoutPath(contractName),
    JSON.stringify(layout, null, 2) + "\n",
    "utf8"
  );
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as object).sort(), 2);
}

function layoutsEqual(a: StorageLayout, b: StorageLayout): boolean {
  // JSON round-trip with stable key ordering. Storage layouts are shallow
  // enough that this is fine in practice.
  return (
    JSON.stringify(a.storage) === JSON.stringify(b.storage) &&
    JSON.stringify(a.types) === JSON.stringify(b.types)
  );
}

task(
  "check-storage-layout",
  "Snapshot or verify UUPS storage layouts against storage-layouts/*.json"
)
  .addFlag("check", "Compare against existing snapshots (fails on diff)")
  .addFlag("write", "Overwrite snapshots with the current layouts")
  .setAction(async (args: { check: boolean; write: boolean }, hre) => {
    if (args.check && args.write) {
      throw new Error("--check and --write are mutually exclusive");
    }
    // Safer default: if the caller passed nothing, treat it as --check.
    const mode: "check" | "write" = args.write ? "write" : "check";

    console.log(`[storage-layout] mode=${mode}`);
    console.log("[storage-layout] compiling with storageLayout output...");
    const layouts = await collectLayouts(hre);

    const missing = TRACKED_CONTRACTS.filter((c) => !layouts.has(c));
    if (missing.length > 0) {
      console.warn(
        `[storage-layout] WARNING: no layout found for: ${missing.join(", ")}`
      );
    }

    if (mode === "write") {
      for (const [name, layout] of layouts) {
        writeSnapshot(name, layout);
        console.log(`[storage-layout] wrote ${layoutPath(name)}`);
      }
      console.log(`[storage-layout] ${layouts.size} snapshot(s) written.`);
      return;
    }

    // mode === "check"
    const diffs: string[] = [];
    const newContracts: string[] = [];
    for (const [name, current] of layouts) {
      const prior = readSnapshot(name);
      if (!prior) {
        newContracts.push(name);
        continue;
      }
      if (!layoutsEqual(prior, current)) {
        diffs.push(name);
        console.error(`[storage-layout] DIFF in ${name}`);
        console.error("  prior:", stableStringify(prior));
        console.error("  now:  ", stableStringify(current));
      }
    }

    if (newContracts.length > 0) {
      console.error(
        `[storage-layout] no snapshot on disk for: ${newContracts.join(", ")}`
      );
      console.error(
        "[storage-layout] run `pnpm run storage:write` to bless the initial layout."
      );
    }

    if (diffs.length > 0 || newContracts.length > 0) {
      throw new Error(
        `[storage-layout] check failed (${diffs.length} changed, ${newContracts.length} missing).`
      );
    }

    console.log(
      `[storage-layout] OK — ${layouts.size} contract(s) match their snapshots.`
    );
  });
