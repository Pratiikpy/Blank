/**
 * Fetches the live production bundle from https://www.myblank.app and
 * searches it for the 12 Wave 5 deployed contract addresses. The bundle
 * URL is content-hashed (`/assets/index-XXXXXX.js`), so we extract it from
 * the live HTML before fetching the bundle itself.
 *
 * The only way to make this script pass is if `packages/app/src/lib/constants.ts`
 * was built into the served bundle with all 12 addresses intact. A regression
 * in constants.ts, a misconfigured Vercel deploy, or a botched build will all
 * produce a 0-match for at least one address and fail the script.
 *
 * Re-runnable any time. Pure-read, no transactions, no state.
 */

const LIVE_ORIGIN = "https://www.myblank.app";
const LIVE_PROBE_PATH = "/app/offramp";

const WAVE5_ADDRESSES_ETH = {
  P2POfframp:          "0x5981C437032Da38844AE9a3aa382F993b1B8444a",
  ReclaimAdapter:      "0xf866EA7630eE91cCcd0Df638679865BCD909cce6",
  MockReclaimVerifier: "0xdfc2606B1Ba148CC35b93849ac888BD7DfFD28a8",
  BlankHandles:        "0xb6F5d0a407B459D7Ab64Ae13dee0f6b371e8eA06",
  GuardianModule:      "0xdBE8252D1e089759b56E742843303f0b18700c3E",
  ProofOfBalance:      "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856",
} as const;

const WAVE5_ADDRESSES_BASE = {
  P2POfframp:          "0xd717E7AFE5eB627c9913bc682003d6E83b9032f9",
  ReclaimAdapter:      "0x2F7B59A920B76d5fD0e3c010b6a7D5E14eF83486",
  MockReclaimVerifier: "0xB36441E8c4155709E350f7c66B16c2B8174c0e75",
  BlankHandles:        "0x346077e5DA2a552f0353f3430F8baE6D7049DEF9",
  GuardianModule:      "0x4fa2152A940651404F2722c0192624d0662e5B46",
  ProofOfBalance:      "0x25e7383Bd5602a07928629e9Ec6eaec9535536Ff",
} as const;

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
