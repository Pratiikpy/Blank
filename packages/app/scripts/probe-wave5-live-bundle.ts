/**
 * Fetches the live production bundle from https://www.myblank.app and
 * searches it for the 12 Wave 5 deployed contract addresses. The bundle
 * URL is content-hashed (`/assets/index-XXXXXX.js`), so we extract it from
 * the live HTML before fetching the bundle itself.
 *
 * Addresses are loaded from `packages/contracts/deployments/*.json` (the
 * hardhat deploy artifacts), so this script picks up new addresses
 * automatically when a redeploy writes them to the JSON. No drift.
 *
 * The only way to make this script pass is if `packages/app/src/lib/constants.ts`
 * was built into the served bundle with all 12 addresses intact. A regression
 * in constants.ts, a misconfigured Vercel deploy, or a botched build will all
 * produce a 0-match for at least one address and fail the script.
 *
 * Re-runnable any time. Pure-read, no transactions, no state.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const LIVE_ORIGIN = "https://www.myblank.app";
const LIVE_PROBE_PATH = "/app/offramp";

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

const WAVE5_ADDRESSES_ETH = extractWave5(loadDeploymentJson("eth-sepolia.json"));
const WAVE5_ADDRESSES_BASE = extractWave5(loadDeploymentJson("base-sepolia.json"));

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "blank-wave5-bundle-probe/1" } });
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

function extractMainBundleUrl(html: string): string {
  const match = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
  if (!match) throw new Error("could not extract main bundle URL from live HTML");
  return LIVE_ORIGIN + match[1];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  while (true) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) break;
    count += 1;
    from = idx + target.length;
  }
  return count;
}

async function probe(label: string, addresses: Record<string, string>, bundle: string): Promise<boolean> {
  console.log(`\n== ${label} ==`);
  let allOk = true;
  for (const [name, addr] of Object.entries(addresses)) {
    const n = countOccurrences(bundle, addr);
    const verdict = n === 1 ? "OK" : n === 0 ? "MISSING!" : `DUPLICATE x${n}`;
    if (n !== 1) allOk = false;
    console.log(`  ${name.padEnd(22)} ${addr}  ${verdict}`);
  }
  return allOk;
}

const html = await fetchText(LIVE_ORIGIN + LIVE_PROBE_PATH);
const bundleUrl = extractMainBundleUrl(html);
console.log(`Live HTML : ${LIVE_ORIGIN + LIVE_PROBE_PATH}`);
console.log(`Bundle URL: ${bundleUrl}`);
const bundle = await fetchText(bundleUrl);
console.log(`Bundle size: ${bundle.length.toLocaleString()} bytes`);

const ethOk = await probe("Eth Sepolia addresses in live bundle", WAVE5_ADDRESSES_ETH, bundle);
const baseOk = await probe("Base Sepolia addresses in live bundle", WAVE5_ADDRESSES_BASE, bundle);

console.log(`\nresult=${ethOk && baseOk ? "ALL_12_ADDRESSES_IN_LIVE_BUNDLE" : "MISSING_OR_DUPLICATE"}`);
process.exit(ethOk && baseOk ? 0 : 1);
