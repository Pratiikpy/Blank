#!/usr/bin/env tsx
// Wave 5 Block 9 — voice CI gate.
//
// Scans user-facing TSX/MD/MDX for CLAUDE.md voice rules violations:
//   - em-dashes in prose (allowed in code comments under §16.4.2)
//   - banned words: delve / unlock / unleash / robust / leverage /
//     empower / seamless / harness / streamline / cutting-edge /
//     state-of-the-art / revolutionize
//   - "in today's fast-paced world" / "in the realm of" openers
//
// Usage:
//   pnpm tsx packages/app/scripts/check-voice.ts           (warn-mode)
//   pnpm tsx packages/app/scripts/check-voice.ts --strict  (fail CI)
//
// Exit codes:
//   0 = clean
//   1 = violations found (only when --strict; otherwise 0 with warnings)

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APP_ROOT = path.resolve(REPO_ROOT, "packages", "app");

const STRICT = process.argv.includes("--strict");

const BANNED_WORDS = [
  "delve", "unlock", "unleash", "robust", "leverage", "empower",
  "seamless", "harness", "streamline", "cutting-edge",
  "state-of-the-art", "revolutionize",
];

const BANNED_OPENERS = [
  "in today's fast-paced world",
  "in the realm of",
];

interface Violation {
  file: string;
  line: number;
  col: number;
  kind: "em-dash" | "banned-word" | "banned-opener";
  match: string;
  context: string;
}

async function walk(dir: string, exts: Set<string>, out: string[] = []): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      await walk(full, exts, out);
    } else {
      const lower = e.name.toLowerCase();
      if (lower.endsWith(".test.tsx") || lower.endsWith(".test.ts")) continue;
      if (/_plan\.md$|_audit\.md$|_todo\.md$|_half_baked\.md$/i.test(lower)) continue;
      if (/wave\d+/.test(lower) && lower.endsWith(".md")) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (exts.has(ext)) out.push(full);
    }
  }
  return out;
}

function stripCodeComments(line: string, inBlock: boolean): { stripped: string; inBlock: boolean } {
  let out = line;
  let block = inBlock;

  // If already inside a /* ... */ that spans lines, drop until we find */.
  if (block) {
    const end = out.indexOf("*/");
    if (end < 0) return { stripped: "", inBlock: true };
    out = out.slice(end + 2);
    block = false;
  }

  // Repeatedly strip inline /* ... */ block comments on this line.
  while (true) {
    const start = out.indexOf("/*");
    if (start < 0) break;
    const end = out.indexOf("*/", start + 2);
    if (end < 0) {
      // Block opens here, continues to next line.
      out = out.slice(0, start);
      block = true;
      break;
    }
    out = out.slice(0, start) + out.slice(end + 2);
  }

  // Strip JSX braces around comments and single-line // comments.
  out = out.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  const slashIdx = out.indexOf("//");
  if (slashIdx >= 0) out = out.slice(0, slashIdx);

  return { stripped: out, inBlock: block };
}

function stripMarkdownCode(line: string, inFence: boolean): { stripped: string; inFence: boolean } {
  if (/^\s*```/.test(line)) {
    return { stripped: "", inFence: !inFence };
  }
  if (inFence) return { stripped: "", inFence: true };
  const stripped = line.replace(/`[^`]*`/g, "");
  return { stripped, inFence: false };
}

async function scanFile(file: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const isMd = file.endsWith(".md") || file.endsWith(".mdx");
  const isTsx = file.endsWith(".tsx") || file.endsWith(".ts");

  let inMdFence = false;
  let inTsBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let scanLine = raw;

    if (isMd) {
      const r = stripMarkdownCode(scanLine, inMdFence);
      scanLine = r.stripped;
      inMdFence = r.inFence;
    }
    if (isTsx) {
      const r = stripCodeComments(scanLine, inTsBlockComment);
      scanLine = r.stripped;
      inTsBlockComment = r.inBlock;
    }

    if (!scanLine) continue;

    let idx = -1;
    while ((idx = scanLine.indexOf("—", idx + 1)) !== -1) {
      // Skip legitimate "—" no-data placeholder uses (CLAUDE.md §20.15).
      // Patterns:
      //   "—"  (string literal that IS the dash)
      //   ?? "—"  (nullish coalescing fallback)
      //   : "—"  (ternary fallback)
      //   {value ?? "—"} / {value || "—"}  (JSX placeholder)
      const trimmed = raw.trim();
      const isJustDash = /["']—["']/.test(scanLine.slice(Math.max(0, idx - 2), idx + 3));
      const isPlaceholder =
        /\?\?\s*["']—["']/.test(scanLine) ||
        /\|\|\s*["']—["']/.test(scanLine) ||
        /:\s*["']—["']/.test(scanLine) ||
        /return\s*["']—["']/.test(scanLine) ||
        /<span[^>]*>\s*—\s*<\/span>/.test(scanLine);

      // Also skip if the dash is inside a string-of-chars constant
      // (e.g. SCRAMBLE_CHARS) — heuristic: a string longer than 8
      // chars containing many punctuation chars.
      const charClassConst = /["'][!<>\-_\\/[\]{}—=+*^?#a-zA-Z0-9]{12,}["']/.test(scanLine);

      // Bare JSX content placeholder: <... >—<...> or {foo ?? "—"} variants.
      const bareJsxPlaceholder = /<[^<>]*>\s*—\s*<\/[^<>]*>/.test(scanLine);

      if (isJustDash || isPlaceholder || charClassConst || bareJsxPlaceholder) continue;

      violations.push({
        file, line: i + 1, col: idx + 1, kind: "em-dash", match: "—",
        context: trimmed.slice(0, 120),
      });
    }

    const lower = scanLine.toLowerCase();
    // Heuristic: skip banned-word checks on lines that are clearly code,
    // not user-facing prose. JSX text content is between > and <; code
    // statements typically contain destructuring braces, fat arrows, or
    // function-call parens around identifiers.
    const looksLikeCode =
      isTsx && (
        /^\s*(const|let|var|import|export|function|return)\b/.test(scanLine) ||
        /\{[^}]*\b(unlock|delve|harness|leverage)\b[^}]*\}/.test(scanLine) ||
        /=>\s*void\s*\w+\s*\(/.test(scanLine) ||
        /onClick=\{[^}]*\w+\s*\(\)/.test(scanLine)
      );
    if (!looksLikeCode) {
      for (const w of BANNED_WORDS) {
        const pattern = new RegExp(`\\b${w.replace(/-/g, "\\-")}\\b`, "gi");
        const matches = [...lower.matchAll(pattern)];
        for (const m of matches) {
          violations.push({
            file, line: i + 1, col: (m.index ?? 0) + 1, kind: "banned-word", match: w,
            context: raw.trim().slice(0, 120),
          });
        }
      }
    }

    for (const op of BANNED_OPENERS) {
      if (lower.includes(op)) {
        violations.push({
          file, line: i + 1, col: lower.indexOf(op) + 1, kind: "banned-opener", match: op,
          context: raw.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

async function main() {
  // Scope: user-facing surfaces only. Excludes internal architecture docs
  // (docs/*) which the project intentionally uses em-dashes in. The voice
  // rule in CLAUDE.md §writing-voice scopes to "anything that ships" —
  // landing pages, app screens, README, on-screen strings, error toasts.
  const targets = [
    path.join(APP_ROOT, "src", "blank-ui", "landing"),
    path.join(APP_ROOT, "src", "blank-ui", "screens"),
    path.join(APP_ROOT, "src", "blank-ui", "components"),
    path.join(APP_ROOT, "src", "components"),
  ];

  const files: string[] = [];
  for (const t of targets) {
    files.push(...(await walk(t, new Set([".tsx", ".mdx"]))));
  }
  const readme = path.join(REPO_ROOT, "README.md");
  try {
    await fs.access(readme);
    files.push(readme);
  } catch { /* no README */ }

  const violations: Violation[] = [];
  for (const f of files) {
    violations.push(...(await scanFile(f)));
  }

  if (violations.length === 0) {
    console.log(`check-voice: clean (${files.length} files)`);
    process.exit(0);
  }

  const grouped: Record<string, Violation[]> = {};
  for (const v of violations) {
    if (!grouped[v.file]) grouped[v.file] = [];
    grouped[v.file].push(v);
  }
  const sortedFiles = Object.keys(grouped).sort();
  for (const file of sortedFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    console.log(`\n${rel}:`);
    for (const v of grouped[file]) {
      const tag =
        v.kind === "em-dash" ? "em-dash" :
        v.kind === "banned-word" ? `banned-word "${v.match}"` :
        `banned-opener "${v.match}"`;
      console.log(`  ${v.line}:${v.col}  ${tag}`);
      if (v.context) console.log(`    > ${v.context}`);
    }
  }

  const emDash = violations.filter((v) => v.kind === "em-dash").length;
  const banned = violations.filter((v) => v.kind === "banned-word").length;
  const openers = violations.filter((v) => v.kind === "banned-opener").length;
  console.log(`\nTotal: ${violations.length} violations across ${sortedFiles.length} files`);
  console.log(`  em-dash:        ${emDash}`);
  console.log(`  banned-word:    ${banned}`);
  console.log(`  banned-opener:  ${openers}`);

  if (STRICT) {
    console.log("\n--strict mode: failing.");
    process.exit(1);
  } else {
    console.log("\n(warn-mode: pass --strict to fail CI on violations)");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("check-voice crashed:", e);
  process.exit(2);
});
