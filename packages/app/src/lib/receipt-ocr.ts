// Receipt OCR — extract a total + merchant from a photo.
//
// Backend choice: in-browser tesseract.js (privacy-preserving, the image
// never leaves the user's device) vs. cloud OCR (faster + more accurate,
// but the image gets uploaded to a third party). For a privacy-focused
// app, tesseract is the right default. The WASM is dynamically imported
// so it doesn't bloat the initial bundle — first invocation pays a one-
// time ~10MB download, subsequent invocations are cached.
//
// Future: Phase 4 may introduce a server-side cloud-vision opt-in for
// users who explicitly trade privacy for speed (settings flag).

export interface ReceiptOcrResult {
  /** Most likely numeric total found on the receipt. NULL if no plausible
   *  total was extracted — caller should prompt the user to type it manually. */
  total: number | null;
  /** Best-guess merchant name (first non-empty line that isn't numeric). */
  merchant: string | null;
  /** Best-guess date string (YYYY-MM-DD) — NULL if no parseable date found. */
  date: string | null;
  /** Raw OCR text — exposed so callers can let the user edit / re-extract. */
  rawText: string;
}

/** Extract the most likely total from raw receipt text.
 *
 * Strategy: look for amounts on the same line as keywords like "TOTAL",
 * "AMOUNT DUE", "BALANCE". Pick the largest such amount as a tiebreaker
 * (subtotals are usually smaller than the grand total). Fall back to the
 * largest numeric value on the receipt when no keyword matches. */
function extractTotal(text: string): number | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // ($)?<digits>(.<2-3 digits>)?  — also handles 1,234.56 style.
  const AMOUNT_RE = /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?|\d+\.\d{1,3})/g;
  const TOTAL_KEYWORDS = /total|amount\s*due|balance\s*due|grand\s*total/i;

  const candidates: number[] = [];
  const keywordCandidates: number[] = [];

  for (const line of lines) {
    const isKeywordLine = TOTAL_KEYWORDS.test(line);
    for (const m of line.matchAll(AMOUNT_RE)) {
      const value = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(value) || value <= 0) continue;
      candidates.push(value);
      if (isKeywordLine) keywordCandidates.push(value);
    }
  }

  if (keywordCandidates.length > 0) {
    return Math.max(...keywordCandidates);
  }
  if (candidates.length === 0) return null;
  // Largest amount on the receipt — heuristic last-resort.
  return Math.max(...candidates);
}

/** Find the first non-numeric, non-empty line — usually the merchant name. */
function extractMerchant(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 2) continue;
    // Skip lines that are mostly digits / punctuation (timestamps, totals).
    const alphaCount = (line.match(/[A-Za-z]/g) ?? []).length;
    if (alphaCount < 3) continue;
    return line.slice(0, 64);
  }
  return null;
}

function extractDate(text: string): string | null {
  // Match common date shapes: YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY.
  const isoMatch = text.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${pad(isoMatch[2])}-${pad(isoMatch[3])}`;
  }
  const usMatch = text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (usMatch) {
    let year = usMatch[3];
    if (year.length === 2) year = (Number(year) > 50 ? "19" : "20") + year;
    return `${year}-${pad(usMatch[1])}-${pad(usMatch[2])}`;
  }
  return null;
}

function pad(n: string | number): string {
  return String(n).padStart(2, "0");
}

/** Run OCR on an image File / Blob and return the structured extraction.
 *
 * Throws if tesseract fails to load or recognize. Callers should wrap in
 * try/catch and fall back to manual entry. */
export async function recognizeReceipt(file: File | Blob): Promise<ReceiptOcrResult> {
  // Dynamic import keeps the ~10MB tesseract WASM out of the initial bundle.
  // Only paid for when the user opens the scanner.
  const { recognize } = await import("tesseract.js");
  const result = await recognize(file, "eng");
  const text = result.data.text ?? "";
  return {
    total: extractTotal(text),
    merchant: extractMerchant(text),
    date: extractDate(text),
    rawText: text,
  };
}
