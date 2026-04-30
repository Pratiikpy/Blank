// Splitwise CSV importer.
//
// Splitwise's "Export trip / group history" produces a CSV with this shape
// (columns in order):
//
//   Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...
//
// Each row is one expense. The trailing per-member columns hold the
// signed share for that member: positive = they owe, negative = they paid
// or are owed. The sum across member columns is always `0` (or close to,
// modulo rounding).
//
// We map each row to a Blank expense:
//   - Cost is the plaintext total (we'll re-encrypt on-chain inside FHE).
//   - Per-member shares become a `Map<memberLabel, shareAmount>`.
//   - Caller is responsible for resolving member labels to addresses
//     (out-of-scope here — usually a small modal asking "which Blank
//     contact is 'Alice'?" before import).

import Papa from "papaparse";

export interface SplitwiseRow {
  /** ISO YYYY-MM-DD if parseable, else NULL. */
  date: string | null;
  description: string;
  category: string;
  cost: number;
  currency: string;
  /** Map of member display name → signed share. Positive = owed, negative
   *  = paid. Members with a `0` share are dropped. */
  shares: Record<string, number>;
}

export interface SplitwiseImportResult {
  /** Successfully parsed rows. */
  rows: SplitwiseRow[];
  /** All unique member labels found across rows — used for the address
   *  mapping prompt. */
  members: string[];
  /** Errors per offending row, keyed by row index (1-based, header-skipped). */
  errors: Array<{ row: number; reason: string }>;
}

const FIXED_COLUMNS = new Set([
  "date",
  "description",
  "category",
  "cost",
  "currency",
  // Splitwise sometimes appends these — we ignore them.
  "exchange rate",
  "deleted",
  "deleted at",
  "deleted by",
]);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Splitwise default is YYYY-MM-DD — accept it directly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Parse the full CSV text into structured rows. Caller can then drive a
 *  member-to-address mapping UI before persisting expenses. */
export function parseSplitwiseCsv(text: string): SplitwiseImportResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const rows: SplitwiseRow[] = [];
  const errors: Array<{ row: number; reason: string }> = [];
  const memberSet = new Set<string>();

  parsed.data.forEach((rawRow, idx) => {
    const lookup: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawRow)) {
      lookup[normalizeKey(k)] = (v ?? "").trim();
    }

    const cost = parseAmount(lookup.cost);
    if (cost == null) {
      errors.push({ row: idx + 2, reason: "Missing or invalid Cost column" });
      return;
    }

    // Member columns = anything not in the fixed set.
    const shares: Record<string, number> = {};
    for (const [originalKey, value] of Object.entries(rawRow)) {
      const key = normalizeKey(originalKey);
      if (FIXED_COLUMNS.has(key)) continue;
      const share = parseAmount(value);
      if (share == null || share === 0) continue;
      const label = originalKey.trim();
      shares[label] = share;
      memberSet.add(label);
    }

    rows.push({
      date: parseDate(lookup.date),
      description: lookup.description ?? "",
      category: lookup.category ?? "",
      cost,
      currency: (lookup.currency ?? "USD").toUpperCase(),
      shares,
    });
  });

  for (const err of parsed.errors ?? []) {
    errors.push({ row: err.row ?? -1, reason: err.message });
  }

  return {
    rows,
    members: Array.from(memberSet).sort(),
    errors,
  };
}
