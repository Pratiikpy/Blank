/**
 * record-loop — produces the hero loop for the README.
 *
 *   pnpm dev    (in another terminal)
 *   pnpm tsx e2e/record-loop.ts
 *
 * Output
 * ------
 *   docs/screenshots/hero-loop.{webm,mp4,gif}
 *
 * What it captures
 * ----------------
 * A clean ~12-second loop on the X-Ray slider, framed tight on the
 * dollar-bill component. The recording starts and ends on the same
 * frame (mouse just off the slider, public bill fully visible) so the
 * GIF/MP4 can autoplay-loop without a visible seam.
 *
 * Loop choreography
 * -----------------
 *   t=0.0  mouse off slider  → public bill (loop start frame)
 *   t=0.5  enter slider left → reveal window appears
 *   t=2.5  sweep right       → ciphertext rolls across
 *   t=4.5  hold at right edge → encrypted side dominant
 *   t=6.5  sweep left        → public side rolls back
 *   t=9.0  exit slider       → public bill (loop end frame, matches t=0)
 *
 * The "matching start/end frame" is what makes a loop feel hypnotic
 * vs jarring. Both states are "mouse not on the slider" → identical
 * pixels.
 */
import { chromium } from "@playwright/test";
import * as path from "path";
import * as fs from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");
const RAW_DIR = path.resolve(__dirname, "..", "test-results", "loop-recording");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function record() {
  console.log(`[loop] base URL: ${BASE_URL}`);
  await ensureDir(RAW_DIR);
  await ensureDir(OUT_DIR);

  // Tight viewport: the slider component is the entire frame. Smaller
  // dimensions also keep the GIF size manageable (palette + scale apply
  // anyway, but starting smaller helps).
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 700 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: RAW_DIR,
      size: { width: 1100, height: 700 },
    },
  });
  const page = await context.newPage();

  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60_000 });

  const slider = page.locator(".ll-slider").first();
  await slider.scrollIntoViewIfNeeded();
  // Center the slider in the viewport so the recording crops cleanly
  // around it (no eyebrow/headline/subline competing for attention).
  await page.evaluate(() => {
    const el = document.querySelector(".ll-slider") as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const targetTop = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
    window.scrollTo({ top: targetTop, behavior: "instant" as ScrollBehavior });
  });
  await page.waitForTimeout(800);

  const box = await slider.boundingBox();
  if (!box) throw new Error("X-Ray slider not found in DOM");
  const yMid = box.y + box.height / 2;

  // ── Loop start frame: mouse OFF the slider ──────────────────────────
  // Move to a known "off" position so the public-bill state is rendered
  // for the first half-second. This is the frame the loop returns to.
  await page.mouse.move(box.x + box.width + 100, yMid);
  await page.waitForTimeout(500);

  // ── Beat A: enter from the left, sweep right ────────────────────────
  await page.mouse.move(box.x + 30, yMid, { steps: 8 });
  await page.waitForTimeout(300);
  await page.mouse.move(box.x + box.width - 30, yMid, { steps: 60 });

  // ── Beat B: hold near right edge — encrypted side dominant ──────────
  await page.waitForTimeout(1_500);

  // ── Beat C: sweep back to the left ──────────────────────────────────
  await page.mouse.move(box.x + 30, yMid, { steps: 60 });
  await page.waitForTimeout(800);

  // ── Loop end frame: mouse OFF the slider — matches start frame ──────
  await page.mouse.move(box.x + box.width + 100, yMid);
  await page.waitForTimeout(700);

  const video = page.video();
  await context.close();
  await browser.close();
  if (!video) throw new Error("Playwright didn't produce a video");

  const rawPath = await video.path();
  const finalWebm = path.join(OUT_DIR, "hero-loop.webm");
  const finalMp4 = path.join(OUT_DIR, "hero-loop.mp4");
  const finalGif = path.join(OUT_DIR, "hero-loop.gif");

  await fs.copyFile(rawPath, finalWebm);
  console.log(`[loop] webm: ${finalWebm}`);

  if (!ffmpegPath) {
    console.warn("[loop] ffmpeg-static missing — only WebM produced.");
    return;
  }

  // MP4 — for any embeds where browsers prefer h264. Loop friendly +
  // faststart so the first frame paints immediately.
  await runFfmpeg([
    "-y",
    "-i", finalWebm,
    "-vcodec", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "24",
    "-preset", "slow",
    "-movflags", "+faststart",
    "-an",
    finalMp4,
  ]);
  console.log(`[loop] mp4:  ${finalMp4}`);

  // GIF — palette-optimised, infinite loop. Width 720 to keep size
  // under ~3 MB while retaining the slider reveal detail. fps=15 so
  // the sweep stays smooth without the typical 12fps GIF judder.
  await runFfmpeg([
    "-y",
    "-i", finalWebm,
    "-vf", "fps=15,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
    "-loop", "0",
    finalGif,
  ]);
  console.log(`[loop] gif:  ${finalGif}`);

  for (const f of [finalMp4, finalGif]) {
    const stats = await fs.stat(f);
    console.log(`[loop] ${path.basename(f).padEnd(16)} ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static missing"));
    const proc = spawn(ffmpegPath, args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

record().catch((err) => {
  console.error(err);
  process.exit(1);
});
