import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Wave 5 E2E testing-todo writer.
//
// Mirrors wave4/helpers/testing-todo.ts but writes to
// WAVE5_TESTING_TODO.md and adds an optional `proofHash` field
// for Reclaim Protocol zkTLS attestations (Block 1 offramp).

const TODO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../WAVE5_TESTING_TODO.md",
);

const BLOCK_START = "<!-- WAVE5_E2E_PROOF_BLOCK_START -->";
const BLOCK_END = "<!-- WAVE5_E2E_PROOF_BLOCK_END -->";

export interface ProofEntry {
  /** "Block 1 Offramp · Alice maker" / "Block 3 Recovery · Bob veto". Short, sortable. */
  phase: string;
  /** "Eth Sepolia" / "Base Sepolia". */
  chainName: string;
  /** 11155111 / 84532. */
  chainId: number;
  /** "0x..." real on-chain tx hash. Required. */
  txHash: string;
  /** Absolute or repo-relative path to the final screenshot. */
  screenshotPath: string;
  /** Reclaim Protocol attestation hash (Block 1 only). */
  proofHash?: string;
  /** Public deep-link URL artifact. */
  urlArtifact?: string;
  /** Short note: "Alice -> Bob, 50 USDC for 4250 INR via UPI". */
  note?: string;
  /** ISO timestamp; auto-filled. */
  capturedAt?: string;
  /** "desktop" / "mobile". */
  viewport?: string;
  /** Path to the captured Playwright video (mp4). */
  videoPath?: string;
}

interface ProofIndex {
  entries: ProofEntry[];
}

function read(): { head: string; tail: string; index: ProofIndex } {
  if (!fs.existsSync(TODO_PATH)) {
    return { head: "# Wave 5 — testing TODO\n\n", tail: "", index: { entries: [] } };
  }
  const text = fs.readFileSync(TODO_PATH, "utf8");
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) {
    return { head: text, tail: "", index: { entries: [] } };
  }
  const head = text.slice(0, startIdx);
  const tail = text.slice(endIdx + BLOCK_END.length);
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
    const proof = e.proofHash ? ` · reclaim:\`${e.proofHash.slice(0, 10)}…\`` : "";
    const video = e.videoPath ? ` · [video](${e.videoPath.replace(/\\/g, "/")})` : "";
    return `- [x] **${e.phase}** · ${e.chainName} · ${txLink} · ${shot}${proof}${url}${note}${view}${video}`;
  });
  return [
    "",
    "## Wave 5 E2E proof (auto-generated, do not edit by hand)",
    "",
    `Last updated: ${new Date().toISOString()}`,
    "",
    ...lines,
    "",
    `<!-- ENTRIES_JSON:${JSON.stringify(entries)}:END -->`,
    "",
  ].join("\n");
}

/**
 * Record a single proof entry. Idempotent on (phase, chainId, txHash):
 * re-recording the same triple overwrites the prior entry instead of
 * appending a duplicate. Keeps WAVE5_TESTING_TODO clean across reruns.
 */
export function recordProof(entry: ProofEntry): void {
  const filled: ProofEntry = {
    ...entry,
    capturedAt: entry.capturedAt ?? new Date().toISOString(),
  };
  const { head, tail, index } = read();
  const dedupKey = `${filled.phase}|${filled.chainId}|${filled.txHash}`;
  const next = index.entries.filter(
    (e) => `${e.phase}|${e.chainId}|${e.txHash}` !== dedupKey,
  );
  next.push(filled);
  const newBlock = `${BLOCK_START}${format(next)}${BLOCK_END}`;
  fs.writeFileSync(TODO_PATH, head + newBlock + tail);
}

/** Read existing entries. Useful for asserting coverage in the runner. */
export function readEntries(): ProofEntry[] {
  return read().index.entries;
}
