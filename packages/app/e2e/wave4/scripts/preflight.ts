#!/usr/bin/env tsx
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ──────────────────────────────────────────────────────────────────
//  Phase 14 — Wave 4 E2E preflight.
//
//  Runs before `pnpm e2e:wave4` to fail fast with a clear message
//  when the environment isn't ready. Better than letting playwright
//  spin up + fail mid-test when a missing RPC URL surfaces 90s into
//  a faucet call.
//
//  Checks (in order):
//   1. Node version >= 20 (matches package.json engines).
//   2. Sepolia RPC reachable + returns chainId 11155111.
//   3. Base Sepolia RPC reachable + returns chainId 84532.
//   4. Deployments JSON exists + has the Wave 4 contract addresses
//      (Phase 5/6 deep-link contracts: ClaimLinks, Storefront,
//      EncryptedCrowdfund, EncryptedEscrow).
//   5. Vite dev server port 5173 — informational only. Playwright's
//      webServer block reuses an existing server or starts one.
//
//  Phase-9 specific (PRIVATE_KEY + TEST_METAMASK) is NOT checked —
//  those are opt-in and the specs skip gracefully when absent.
// ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

interface Check {
  name: string;
  required: boolean;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function pushCheck(c: Check): void {
  checks.push(c);
}

// ─── Node version ─────────────────────────────────────────────────
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  pushCheck({
    name: "Node >= 20",
    required: true,
    ok: major >= 20,
    detail: `node ${process.versions.node}`,
  });
}

// ─── RPC reachability ─────────────────────────────────────────────
const RPC_TARGETS: { chainId: number; envVar: string; fallback: string }[] = [
  {
    chainId: 11155111,
    envVar: "SEPOLIA_RPC_URL",
    fallback: "https://ethereum-sepolia.publicnode.com",
  },
  {
    chainId: 84532,
    envVar: "BASE_SEPOLIA_RPC_URL",
    fallback: "https://sepolia.base.org",
  },
];

async function checkRpc(chainId: number, envVar: string, fallback: string): Promise<void> {
  const url = process.env[envVar] ?? fallback;
  const source = process.env[envVar] ? envVar : `default (${fallback})`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      pushCheck({
        name: `RPC chainId=${chainId}`,
        required: true,
        ok: false,
        detail: `HTTP ${res.status} from ${source}`,
      });
      return;
    }
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) {
      pushCheck({
        name: `RPC chainId=${chainId}`,
        required: true,
        ok: false,
        detail: `RPC error: ${body.error.message}`,
      });
      return;
    }
    const reportedChainId = parseInt(body.result ?? "0x0", 16);
    pushCheck({
      name: `RPC chainId=${chainId}`,
      required: true,
      ok: reportedChainId === chainId,
      detail:
        reportedChainId === chainId
          ? `${source} → ${reportedChainId} OK`
          : `${source} reported ${reportedChainId}, expected ${chainId}`,
    });
  } catch (e) {
    pushCheck({
      name: `RPC chainId=${chainId}`,
      required: true,
      ok: false,
      detail: `fetch failed: ${(e as Error).message}`,
    });
  }
}

// ─── Deployments JSON ─────────────────────────────────────────────
const WAVE4_REQUIRED_KEYS = [
  "TestUSDC",
  "FHERC20Vault_USDC",
  "PaymentHub",
  "BusinessHub",
  "ClaimLinks",
  "Storefront",
  "EncryptedEscrow",
  "EncryptedCrowdfund",
  "StealthPayments",
];

function checkDeployments(chainName: string, jsonFile: string): void {
  const filepath = path.join(REPO_ROOT, "packages/contracts/deployments", jsonFile);
  if (!fs.existsSync(filepath)) {
    pushCheck({
      name: `Deployments ${chainName}`,
      required: true,
      ok: false,
      detail: `Missing file: ${filepath}`,
    });
    return;
  }
  const json = JSON.parse(fs.readFileSync(filepath, "utf8")) as Record<string, string>;
  const missing = WAVE4_REQUIRED_KEYS.filter((k) => !json[k]);
  pushCheck({
    name: `Deployments ${chainName}`,
    required: true,
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${WAVE4_REQUIRED_KEYS.length} required addresses present`
        : `missing keys: ${missing.join(", ")}`,
  });
}

// ─── Run ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("─── Wave 4 E2E preflight ───");

  await Promise.all(RPC_TARGETS.map((t) => checkRpc(t.chainId, t.envVar, t.fallback)));
  checkDeployments("Eth Sepolia", "eth-sepolia.json");
  checkDeployments("Base Sepolia", "base-sepolia.json");

  // ─── Informational: Vite dev server reachability ────────────────
  try {
    const res = await fetch("http://localhost:3000", { signal: AbortSignal.timeout(2_000) });
    pushCheck({
      name: "Vite dev server (informational)",
      required: false,
      ok: res.ok,
      detail: `reachable (HTTP ${res.status})`,
    });
  } catch {
    pushCheck({
      name: "Vite dev server (informational)",
      required: false,
      ok: false,
      detail: "not running — playwright will start one via webServer config",
    });
  }

  // ─── Render report ──────────────────────────────────────────────
  const blockedBy = checks.filter((c) => c.required && !c.ok);
  for (const c of checks) {
    const tag = c.ok ? "OK  " : c.required ? "FAIL" : "WARN";
    console.log(`  [${tag}] ${c.name.padEnd(34)} ${c.detail}`);
  }
  console.log("");
  if (blockedBy.length > 0) {
    console.log(`FAIL — ${blockedBy.length} required check${blockedBy.length === 1 ? "" : "s"} blocked.`);
    console.log("Fix the listed items and re-run `pnpm e2e`.");
    process.exit(1);
  }
  console.log("PASS — preflight clear.");
}

void main();
