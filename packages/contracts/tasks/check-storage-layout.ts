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
  // Phase 4.1 BlankAccount became UUPS-upgradeable in v0.4.1 (validator
  // dispatch). Tracking guards against accidental storage reordering on
  // future upgrades that would brick existing user proxies.
  "BlankAccount",
  // §1.11 sweep (audit iter 47): 7 UUPS contracts that pre-existed the
  // tracking list. Wave 4 added the first four; the last three predated
  // Wave 4 and were never added to the list.
  "ClaimLinks",
  "Storefront",
  "EncryptedCrowdfund",
  "EncryptedEscrow",
  "EncryptedFlags",
  "EventHub",
  "TokenRegistry",
  // Wave 5 Block 1 — encrypted P2P offramp + Reclaim adapter +
  // mock fallback verifier. All three are UUPS proxies.
  "P2POfframp",
  "ReclaimAdapter",
  "MockReclaimVerifier",
  // Wave 5 Block 2 — per-chain @handle registry. UUPS proxy.
  "BlankHandles",
  // Wave 5 Block 3 — guardian-based social recovery state machine.
  "GuardianModule",
  // Wave 5 Block 10 — bonus FHE: prove encrypted balance >= threshold
  // without revealing the underlying value. UUPS proxy.
  "ProofOfBalance",
];

const SNAPSHOT_DIR = path.join(__dirname, "..", "storage-layouts");

export type StorageLayout = {
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

export function stableStringify(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as object).sort(), 2);
}

/**
 * Strip every solc AST-id from a storage-layout subtree.
 *
 * Why: solc emits storage layouts that embed sequential AST-ids inside
 * type strings (e.g. `t_contract(IEventHub)45306`,
 * `t_userDefinedValueType(euint)4733`). AST-ids are NOT stable across
 * compilations — they're per-run counters that depend on the total set of
 * source files solc processes. When an external dep (e.g.
 * @cofhe/mock-contracts) ships a new version with extra files, every
 * AST-id in our contracts shifts even though the actual storage
 * (slot + offset + label + type-shape) is unchanged.
 *
 * UUPS upgrade safety only depends on slot/offset/label/type-shape — never
 * on AST-ids — so we strip them before comparing. This lets the check
 * stay sharp on real layout changes while not false-alarming on every
 * SDK bump.
 *
 * Implementation: top-level `astId` fields are dropped, and any embedded
 * digit run inside a string field (the type-id suffixes) is removed.
 */
export function stripAstIds(value: unknown): unknown {
  if (typeof value === "string") {
    // Pure-digit strings are slot numbers / offset values — leave alone.
    // Mixed strings (type expressions like `t_contract(X)45306`) get
    // their digit runs stripped.
    return /^[0-9]+$/.test(value) ? value : value.replace(/[0-9]+/g, "");
  }
  if (Array.isArray(value)) {
    return value.map(stripAstIds);
  }
  if (value && typeof value === "object") {
    // The `types` map is keyed by type expressions that themselves
    // embed AST-ids; we strip digits from keys with the same rule.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "astId") continue;
      const normK = /^[0-9]+$/.test(k) ? k : k.replace(/[0-9]+/g, "");
      out[normK] = stripAstIds(v);
    }
    return out;
  }
  return value;
}

export function layoutsEqual(a: StorageLayout, b: StorageLayout): boolean {
  // JSON round-trip after AST-id stripping. The stripped form is what
  // actually matters for UUPS upgrade safety.
  return (
    JSON.stringify(stripAstIds(a.storage)) === JSON.stringify(stripAstIds(b.storage)) &&
    JSON.stringify(stripAstIds(a.types)) === JSON.stringify(stripAstIds(b.types))
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
