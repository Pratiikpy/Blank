/**
 * record-demo — produces a hero video for the README.
 *
 * Run with the dev server already up:
 *   pnpm dev    (in another terminal)
 *   pnpm tsx e2e/record-demo.ts
 *
 * What it captures
 * ----------------
 * A single-take demo of Blank's brand surface — landing X-Ray slider,
 * scroll into the live ticker, and the public invoice page rendered
 * with a paid status. Everything visible on the recording is the real
 * app, but rendered against the live www.myblank.app
 * deployment so the timing is reliable.
 *
 * The full vendor → client → finalize → proof loop on real chain takes
 * 2-3 minutes (threshold-decrypt budget on Sepolia). That's too long for
 * a hero video. Instead this script produces a 25-30s walkthrough that
 * showcases:
 *
 *   1. Landing hero with the dollar-bill x-ray slider (the brand moment)
 *   2. Scroll to the live volume counter ("real, on-chain, today")
 *   3. The public invoice page in its paid state — proof of the wedge
 *
 * Output
 * ------
 *   docs/screenshots/demo.webm   (Playwright's native record)
 *   docs/screenshots/demo.mp4    (compressed via ffmpeg-static; for README embed)
 */
import { chromium } from "@playwright/test";
import * as path from "path";
import * as fs from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.DEMO_BASE_URL ?? "https://www.myblank.app";
// A real public invoice id on Base Sepolia that's already paid — gives us
// the proof-of-payment moment without having to drive a fresh tx during
// the recording. Falls back to a prompt-for-not-found state otherwise.
const DEMO_INVOICE_PATH = process.env.DEMO_INVOICE_PATH ?? "/app/invoice/84532/22";

const OUT_DIR = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");
const RAW_VIDEO_DIR = path.resolve(__dirname, "..", "test-results", "demo-recording");
const FINAL_WEBM = path.join(OUT_DIR, "demo.webm");
const FINAL_MP4 = path.join(OUT_DIR, "demo.mp4");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function record() {
  console.log(`[demo] base URL: ${BASE_URL}`);
  console.log(`[demo] invoice path: ${DEMO_INVOICE_PATH}`);

  await ensureDir(RAW_VIDEO_DIR);
  await ensureDir(OUT_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: RAW_VIDEO_DIR,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();

  // ── Beat 1: landing hero, sweep the X-Ray slider ───────────────────
  // The slider reveals on mouse hover (not drag). Sweep left → right →
  // back to ~60% so the encrypted "ciphertext" side is the dominant
  // thumbnail frame at end of beat.
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1_500);
  const slider = page.locator(".ll-slider").first();
  await slider.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  if (await slider.count()) {
    const box = await slider.boundingBox();
    if (box) {
      const yMid = box.y + box.height / 2;
      // Sweep left → right (reveals the cipher progressively)
      await page.mouse.move(box.x + 20, yMid, { steps: 5 });
      await page.waitForTimeout(400);
      await page.mouse.move(box.x + box.width - 20, yMid, { steps: 40 });
      await page.waitForTimeout(800);
      // Sweep right → left
      await page.mouse.move(box.x + 20, yMid, { steps: 30 });
      await page.waitForTimeout(600);
      // Settle at 60% — encrypted side dominant. Leave the mouse on
      // the slider so the reveal stays visible until the next beat
      // scrolls past it (the slider only renders the reveal window
      // on hover; moving off collapses back to the public bill).
      await page.mouse.move(box.x + box.width * 0.6, yMid, { steps: 20 });
      await page.waitForTimeout(1_800);
    }
  }

  // ── Beat 2: scroll to the live counter + features stack ────────────
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: "smooth" }));
  await page.waitForTimeout(3_000);
  await page.evaluate(() => window.scrollTo({ top: 1500, behavior: "smooth" }));
  await page.waitForTimeout(3_000);

  // ── Beat 3: navigate to a paid public invoice page ─────────────────
  await page.goto(`${BASE_URL}${DEMO_INVOICE_PATH}`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await page.evaluate(() => window.scrollTo({ top: 200, behavior: "smooth" }));
  await page.waitForTimeout(3_000);

  // ── Beat 4: scroll back to the top for a clean tail frame ──────────
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(2_000);

  // Close cleanly so Playwright finishes encoding the WebM.
  const video = page.video();
  await context.close();
  await browser.close();

  if (!video) {
    throw new Error("Playwright didn't produce a video — recordVideo config?");
  }
  const rawPath = await video.path();
  console.log(`[demo] raw webm: ${rawPath}`);

  await fs.copyFile(rawPath, FINAL_WEBM);
  console.log(`[demo] wrote ${FINAL_WEBM}`);

  // ── Compress to MP4 for README hero (smaller, broader compat) ──────
  if (!ffmpegPath) {
    console.warn("[demo] ffmpeg-static path not found — skipping MP4 transcode");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i", FINAL_WEBM,
      // Speed up 1.4x to land closer to a 25s feel; use setpts for video,
      // there's no audio stream from Playwright so no atempo needed.
      "-filter:v", "setpts=PTS/1.4",
      "-vcodec", "libx264",
      "-pix_fmt", "yuv420p",   // QuickTime/Twitter-friendly
      "-crf", "26",            // 18 = visually lossless; 26 = small + fine for hero
      "-preset", "slow",
      "-movflags", "+faststart",
      "-an",                   // strip audio (none anyway)
      FINAL_MP4,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
  console.log(`[demo] wrote ${FINAL_MP4}`);

  const stats = await fs.stat(FINAL_MP4);
  console.log(`[demo] mp4 size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

record().catch((err) => {
  console.error(err);
  process.exit(1);
});
