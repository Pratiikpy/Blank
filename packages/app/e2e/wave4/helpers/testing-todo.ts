import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 E2E testing-todo writer.
//
//  Appends a structured "Proof" line to WAVE4_TESTING_TODO.md after
//  each phase succeeds. The output is auto-generated under a fenced
//  block so the file's manual checklist content stays untouched.
//
//  Format per line:
//    - [x] <feature> · <chain> · <tx_hash> · <screenshot_path> · <url_artifact?>
//
//  CLAUDE.md §H gate: one tx hash + screenshot path per feature, per
//  chain. The block is sorted by phase then chain so it reads
//  top-to-bottom in the same order the suite runs.
// ──────────────────────────────────────────────────────────────────

const TODO_PATH = path.resolve(
  path.dirname(import.meta.url.replace(/^file:\/\//, "")),
  "../../../../../WAVE4_TESTING_TODO.md",
);

const BLOCK_START = "<!-- WAVE4_E2E_PROOF_BLOCK_START -->";
const BLOCK_END = "<!-- WAVE4_E2E_PROOF_BLOCK_END -->";

export interface ProofEntry {
  /** "P1 Bootstrap" / "P5 Claim Links" / etc. Short, sortable. */
  phase: string;
  /** "Eth Sepolia" / "Base Sepolia". */
  chainName: string;
  /** "11155111" / "84532". */
  chainId: number;
  /** "0xabc..." on-chain tx hash. Required. */
  txHash: string;
  /** Absolute or repo-relative path to the final screenshot. */
  screenshotPath: string;
  /** Public deep-link URL artifact (verify/v, claim, shop, fund). Optional. */
  urlArtifact?: string;
  /** Build short note for the line — "Alice → Bob, $50 USDC". */
  note?: string;
  /** ISO timestamp when the proof was captured. Auto-filled. */
  capturedAt?: string;
  /** "desktop" / "mobile" — captured viewport class. */
  viewport?: string;
}

interface ProofIndex {
  entries: ProofEntry[];
}

function read(): { head: string; tail: string; index: ProofIndex } {
  if (!fs.existsSync(TODO_PATH)) {
    return { head: "# Wave 4 — testing TODO\n\n", tail: "", index: { entries: [] } };
  }
  const text = fs.readFileSync(TODO_PATH, "utf8");
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) {
    // No managed block yet — return whole file as head + empty index.
    return { head: text, tail: "", index: { entries: [] } };
  }
  const head = text.slice(0, startIdx);
  const tail = text.slice(endIdx + BLOCK_END.length);
  // Recover prior entries from the JSON inside the block.
  const inner = text.slice(startIdx + BLOCK_START.length, endIdx);
  const m = inner.match(/<!-- ENTRIES_JSON:(.*?):END -->/s);
  const entries: ProofEntry[] = m ? JSON.parse(m[1]) : [];
  return { head, tail, index: { entries } };
}

function format(entries: ProofEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
    return a.chainId - b.chainId;
  });
  const lines = sorted.map((e) => {
    const explorer = e.chainId === 11155111
      ? "https://sepolia.etherscan.io/tx/"
      : "https://sepolia.basescan.org/tx/";
    const txLink = `[\`${e.txHash.slice(0, 10)}…\`](${explorer}${e.txHash})`;
    const shot = `\`${path.relative(path.dirname(TODO_PATH), e.screenshotPath).replace(/\\/g, "/")}\``;
    const url = e.urlArtifact ? ` · ${e.urlArtifact}` : "";
    const note = e.note ? ` · ${e.note}` : "";
    const view = e.viewport ? ` · ${e.viewport}` : "";
    return `- [x] **${e.phase}** · ${e.chainName} · ${txLink} · ${shot}${url}${note}${view}`;
  });
  return [
    "",
    "## Wave 4 E2E proof (auto-generated, do not edit by hand)",
    "",
    `Last updated: ${new Date().toISOString()}`,
    "",
    ...lines,
    "",
    // Embed the JSON so subsequent runs can deduplicate + re-emit.
    `<!-- ENTRIES_JSON:${JSON.stringify(entries)}:END -->`,
    "",
  ].join("\n");
}

/**
 * Record a single proof entry. Idempotent on (phase, chainId, txHash):
 * re-recording the same triple overwrites the prior entry rather than
 * appending a duplicate. This keeps the WAVE4_TESTING_TODO clean even
 * when a phase reruns.
 */
export function recordProof(entry: ProofEntry): void {
  const filled: ProofEntry = { ...entry, capturedAt: entry.capturedAt ?? new Date().toISOString() };
  const { head, tail, index } = read();
  const dedupKey = `${filled.phase}|${filled.chainId}|${filled.txHash}`;
  const next = index.entries.filter(
    (e) => `${e.phase}|${e.chainId}|${e.txHash}` !== dedupKey,
  );
  next.push(filled);
  const newBlock = `${BLOCK_START}${format(next)}${BLOCK_END}`;
  fs.writeFileSync(TODO_PATH, head + newBlock + tail);
}

/** Read existing entries — useful for asserting coverage in the runner. */
export function readEntries(): ProofEntry[] {
  return read().index.entries;
}
