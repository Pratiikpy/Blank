import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ──────────────────────────────────────────────────────────────────
//  Wave 4 E2E screenshot helper.
//
//  Naming convention: `<phase>-<persona>-<chain>-<NN>-<label>.png`
//  where NN is a zero-padded counter that increments per phase + chain
//  combo. Auto-creates the directory tree.
//
//  Per CLAUDE.md §H: screenshots at every meaningful state transition.
//  The helper standardizes the naming so judges can map a tx hash in
//  WAVE4_TESTING_TODO.md back to the exact PNG via filename.
// ──────────────────────────────────────────────────────────────────

const SHOTS_DIR = path.resolve(
  path.dirname(import.meta.url.replace(/^file:\/\//, "")),
  "../../../test-results/wave4-shots",
);

const counters = new Map<string, number>();

export interface ShotContext {
  /** "phase-01-bootstrap" / "feature-claim-link" / etc. */
  phase: string;
  /** "alice" / "bob" / "carol" / "dave" / "public". */
  persona: string;
  /** "eth-sepolia" / "base-sepolia". */
  chain: string;
  /** "desktop" / "mobile". */
  viewport: string;
}

function keyOf(ctx: ShotContext): string {
  return `${ctx.phase}|${ctx.persona}|${ctx.chain}|${ctx.viewport}`;
}

/**
 * Capture a screenshot with auto-naming. Returns the absolute path so
 * the testing-todo helper can record it.
 *
 * @param label Snake-cased state label, e.g. "pre-action", "encrypting",
 *              "post-confirm", "final-result". Keep short — it lands in
 *              the filename verbatim.
 */
export async function snap(
  page: Page,
  ctx: ShotContext,
  label: string,
): Promise<string> {
  const key = keyOf(ctx);
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);

  const dir = path.join(SHOTS_DIR, ctx.phase, ctx.chain, ctx.viewport);
  fs.mkdirSync(dir, { recursive: true });

  const safe = label.replace(/[^\w-]/g, "_");
  const file = path.join(
    dir,
    `${String(n).padStart(2, "0")}-${ctx.persona}-${safe}.png`,
  );
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Reset the counter for a phase+chain combo. Call at phase start. */
export function resetCounter(ctx: ShotContext): void {
  counters.delete(keyOf(ctx));
}
