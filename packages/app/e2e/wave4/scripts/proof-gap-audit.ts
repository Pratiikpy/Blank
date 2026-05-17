#!/usr/bin/env tsx
import { readEntries } from "../helpers/testing-todo";

// ──────────────────────────────────────────────────────────────────
//  Phase 13 — Wave 4 proof-block gap audit.
//
//  Reads the entries that `recordProof` wrote into
//  WAVE4_TESTING_TODO.md's fenced block + compares them to the
//  EXPECTED coverage matrix below. Exits non-zero with a per-line
//  diff if any (phase prefix, chainId) tuple is missing OR if a
//  recorded entry's tx hash doesn't look like a real on-chain hash
//  (i.e. the synthetic 0x0...0 marker is OK for explicit UI-gated
//  negatives, but NOT for happy-path features that must produce
//  a real tx).
//
//  Why a coverage matrix and not just "count > 0":
//   • The spec's hard gate is "every shipped feature has a line",
//     not "the suite produced N entries". A bug where one phase
//     records 10 entries but another records 0 would pass a count
//     check + leave the judge with a gap.
//   • Matrix definition is the single source of truth for "what
//     does shipped mean" for Wave 4. Reviewers can read this file
//     to see the exhaustive list without spelunking through phases.
//
//  How to extend: when a new phase ships, add its expected tuples
//  here. The audit is the canary — if it goes red, either the spec
//  failed to record or the expected matrix is stale.
// ──────────────────────────────────────────────────────────────────

interface ExpectedCoverage {
  /** Substring matched against entry.phase (case-insensitive). */
  phasePrefix: string;
  /** Chain ids that MUST appear for this phase. */
  chainIds: number[];
  /** When true, the recorded tx hash MUST be a real on-chain hash
   *  (not the synthetic 0x0...0 placeholder for UI-gated cases). */
  requiresRealTx: boolean;
  /** Short description for the failure message. */
  desc: string;
}

const ETH = 11155111;
const BASE = 84532;
const BOTH = [ETH, BASE];

const EXPECTED: ExpectedCoverage[] = [
  // ─── Phase 1: bootstrap (faucet TestUSDC) ─────────────────────
  { phasePrefix: "P1 Bootstrap", chainIds: BOTH, requiresRealTx: true, desc: "Alice/Bob/Carol faucet TestUSDC + balance assert" },

  // ─── Phase 2: P2P payments ────────────────────────────────────
  { phasePrefix: "P2 P2P", chainIds: BOTH, requiresRealTx: true, desc: "Alice → Bob encrypted USDC transfer (happy path)" },
  { phasePrefix: "P2 P2P negative", chainIds: BOTH, requiresRealTx: false, desc: "P2P over-balance error surface" },

  // ─── Phase 3: business (invoice + payroll) ────────────────────
  { phasePrefix: "P3 Invoice", chainIds: BOTH, requiresRealTx: true, desc: "Invoice create + pay round-trip" },
  { phasePrefix: "P3 Payroll", chainIds: BOTH, requiresRealTx: true, desc: "Payroll batch tx (3+ employees)" },

  // ─── Phase 4: escrow ──────────────────────────────────────────
  { phasePrefix: "P4 Escrow create", chainIds: BOTH, requiresRealTx: true, desc: "Alice creates encrypted escrow" },
  { phasePrefix: "P4 Escrow delivered", chainIds: BOTH, requiresRealTx: true, desc: "Bob marks escrow delivered" },
  { phasePrefix: "P4 Escrow release", chainIds: BOTH, requiresRealTx: true, desc: "Alice approves release → Bob receives funds" },

  // ─── Phase 5: public deep-link create ─────────────────────────
  { phasePrefix: "P5 claim PublicLink", chainIds: BOTH, requiresRealTx: true, desc: "Public claim link created (no bind)" },
  { phasePrefix: "P5 claim AddressBound", chainIds: BOTH, requiresRealTx: true, desc: "Address-bound claim link created" },
  { phasePrefix: "P5 claim PasscodeBound", chainIds: BOTH, requiresRealTx: true, desc: "Passcode-bound claim link created" },
  { phasePrefix: "P5 storefront auction", chainIds: BOTH, requiresRealTx: true, desc: "Storefront auction listing created" },
  { phasePrefix: "P5 fund campaign", chainIds: BOTH, requiresRealTx: true, desc: "Crowdfund campaign created" },

  // ─── Phase 6: public deep-link consume ────────────────────────
  { phasePrefix: "P6 claim consume", chainIds: BOTH, requiresRealTx: true, desc: "Bob claims all 3 link modes" },
  { phasePrefix: "P6 auction bid", chainIds: BOTH, requiresRealTx: true, desc: "Auction 3-bid sequence (Bob+Carol)" },
  { phasePrefix: "P6 fund contribute", chainIds: BOTH, requiresRealTx: true, desc: "Bob + Carol contribute (cumulative >= goal)" },
  { phasePrefix: "P6 F1 verify-error", chainIds: BOTH, requiresRealTx: false, desc: "/verify/:bogusId honest error UI" },

  // ─── Phase 7: privacy primitives ──────────────────────────────
  { phasePrefix: "P7 income-proof", chainIds: BOTH, requiresRealTx: true, desc: "Income proof create + auto-publish + /v/:id og:image + /verify SPA" },
  { phasePrefix: "P7 stealth", chainIds: BOTH, requiresRealTx: true, desc: "Bob registers stealth keys, Alice sends, Bob scanner detects" },

  // ─── Phase 8: gas wallet (Dave MM external EOA → Alice AA) ────
  { phasePrefix: "P8 receive auto-deposit", chainIds: BOTH, requiresRealTx: true, desc: "External ETH → Alice AA receive() → EntryPoint deposit grows" },
  { phasePrefix: "P8 self-pay UserOp", chainIds: BOTH, requiresRealTx: true, desc: "Alice fires self-pay UserOp; deposit decreases" },

  // ─── Phase 9: MetaMask smoke (opt-in via TEST_METAMASK=1) ─────
  // Not in the required matrix — skip-gracefully gate makes it
  // optional. Audit reports it as "informational" if present.

  // ─── Phase 11: negative cases ─────────────────────────────────
  { phasePrefix: "P11 Negatives · §1.14 A4", chainIds: BOTH, requiresRealTx: false, desc: "Crowdfund zero-goal grief blocked" },
  { phasePrefix: "P11 Negatives · §1.2", chainIds: BOTH, requiresRealTx: true, desc: "Escrow no-arbiter dispute revert (escrow create tx required)" },
  { phasePrefix: "P11 Negatives · C4", chainIds: BOTH, requiresRealTx: false, desc: "Claim wrong-wallet UI gate (no on-chain tx by design)" },

  // ─── Phase 12: mobile sweep ───────────────────────────────────
  { phasePrefix: "P12 Mobile Sweep · BottomNav", chainIds: BOTH, requiresRealTx: false, desc: "Mobile BottomNav + More sheet UX coverage" },
  { phasePrefix: "P12 Mobile Sweep · mobile P2P", chainIds: BOTH, requiresRealTx: true, desc: "Mobile P2P send happy path" },
  { phasePrefix: "P12 Mobile Sweep · public surface", chainIds: BOTH, requiresRealTx: false, desc: "Mobile public-URL CTA reachability" },

  // ─── Phase 14: Groups (encrypted group expense splits) ───────
  { phasePrefix: "P14 Groups · group create", chainIds: BOTH, requiresRealTx: true, desc: "Alice creates encrypted group with Bob + Carol via /app/groups UI" },

  // ─── Phase 13: read-only screen render sweep ──────────────────
  { phasePrefix: "P13 Render Sweep · Dashboard", chainIds: BOTH, requiresRealTx: false, desc: "Dashboard h1 visible + screenshot" },
  { phasePrefix: "P13 Render Sweep · History", chainIds: BOTH, requiresRealTx: false, desc: "History list page render check" },
  { phasePrefix: "P13 Render Sweep · Explore", chainIds: BOTH, requiresRealTx: false, desc: "Explore (public deep-link discovery) render check" },
  { phasePrefix: "P13 Render Sweep · Contacts", chainIds: BOTH, requiresRealTx: false, desc: "Contacts (address book) render check" },
  { phasePrefix: "P13 Render Sweep · Privacy", chainIds: BOTH, requiresRealTx: false, desc: "Privacy settings render check" },
  { phasePrefix: "P13 Render Sweep · Analytics", chainIds: BOTH, requiresRealTx: false, desc: "Analytics dashboard render check" },
  { phasePrefix: "P13 Render Sweep · Profile", chainIds: BOTH, requiresRealTx: false, desc: "Profile (ENS) render check" },
  { phasePrefix: "P13 Render Sweep · Settings", chainIds: BOTH, requiresRealTx: false, desc: "Settings render check" },
  { phasePrefix: "P13 Render Sweep · Help", chainIds: BOTH, requiresRealTx: false, desc: "Help center render check" },
  { phasePrefix: "P13 Render Sweep · TransactionDetail", chainIds: BOTH, requiresRealTx: false, desc: "Tx detail (bogus hash → graceful render)" },
];

const ZERO_HASH = `0x${"0".repeat(64)}`;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function main(): void {
  const entries = readEntries();
  const errors: string[] = [];
  const ok: string[] = [];

  for (const exp of EXPECTED) {
    for (const chainId of exp.chainIds) {
      const matches = entries.filter(
        (e) =>
          e.phase.toLowerCase().includes(exp.phasePrefix.toLowerCase()) &&
          e.chainId === chainId,
      );

      if (matches.length === 0) {
        errors.push(
          `  MISSING: "${exp.phasePrefix}" on chain ${chainId} — ${exp.desc}`,
        );
        continue;
      }

      // Validate every match's tx hash format. If requiresRealTx, the
      // hash MUST not be the synthetic 0x0...0 placeholder.
      for (const m of matches) {
        if (!HASH_RE.test(m.txHash)) {
          errors.push(
            `  BAD HASH FORMAT: "${m.phase}" chain ${chainId} → ${m.txHash}`,
          );
        } else if (exp.requiresRealTx && m.txHash === ZERO_HASH) {
          errors.push(
            `  SYNTHETIC HASH ON HAPPY PATH: "${m.phase}" chain ${chainId} expects a real tx hash — got 0x0...0. Did the relay never confirm?`,
          );
        }
      }
      ok.push(`  OK:      "${exp.phasePrefix}" on chain ${chainId} (${matches.length} entr${matches.length === 1 ? "y" : "ies"})`);
    }
  }

  console.log("─── Wave 4 proof-block coverage audit ───");
  console.log(`Read ${entries.length} entries from WAVE4_TESTING_TODO.md`);
  console.log("");
  console.log("Coverage results:");
  for (const line of ok) console.log(line);
  console.log("");

  if (errors.length > 0) {
    console.log(`Gaps (${errors.length}):`);
    for (const line of errors) console.log(line);
    console.log("");
    console.log("FAIL — fix the suite or update the expected matrix in");
    console.log("packages/app/e2e/wave4/scripts/proof-gap-audit.ts.");
    process.exit(1);
  }

  console.log("PASS — every expected (phase, chainId) tuple has at least one entry.");
}

main();
