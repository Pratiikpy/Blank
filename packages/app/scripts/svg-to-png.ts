// Convert SVG logos to PNG at multiple sizes via headless Chromium.
import { chromium } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, "..", "public");
const OUT = path.resolve(__dirname, "..", "public", "logo-png");

async function render(svgPath: string, outPath: string, size: number) {
  const svgContent = fs.readFileSync(svgPath, "utf8");
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{width:${size}px;height:${size}px;display:block}
  </style></head><body>${svgContent}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html);
  await page.waitForTimeout(200);
  await page.screenshot({ path: outPath, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await browser.close();
  console.log(`  ${size}x${size} → ${outPath}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const logos = [
    { src: path.join(PUBLIC, "logo-circle.svg"), name: "logo-circle" },
    { src: path.join(PUBLIC, "favicon.svg"), name: "favicon" },
  ];

  const sizes = [64, 128, 256, 512, 1024];

  for (const logo of logos) {
    if (!fs.existsSync(logo.src)) {
      console.log(`  skip ${logo.name} — not found`);
      continue;
    }
    console.log(`\n${logo.name}:`);
    for (const size of sizes) {
      await render(logo.src, path.join(OUT, `${logo.name}-${size}.png`), size);
    }
  }
  console.log(`\nDone. Output: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
