// Diagnostic: does .rabby-profile-blank unlock, and what accounts does it hold?
import { launchRabby, unlockRabby } from "./rabby-driver";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
  const profileDir = process.env.RABBY_PROFILE_DIR ?? resolve(REPO, ".rabby-profile-blank");
  const shotsDir = resolve(__dirname, "diag-shots");
  const password = process.env.RABBY_PASSWORD ?? "RabbyPass123!QA";
  console.log("profileDir:", profileDir);

  const h = await launchRabby({ shotsDir, headless: false, profileDir });
  await h.rabbyPage.screenshot({ path: resolve(shotsDir, "01-initial.png") }).catch(() => {});
  // dump inputs to find the password field
  const inputs = await h.rabbyPage.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map((i) => ({ type: (i as HTMLInputElement).type, ph: (i as HTMLInputElement).placeholder }))
  ).catch(() => []);
  console.log("INPUTS:", JSON.stringify(inputs));
  // robust unlock: fill by placeholder OR type, then Enter
  let unlocked = await unlockRabby(h.rabbyPage, password);
  if (!unlocked) {
    const pwField = h.rabbyPage
      .locator('input[placeholder*="assword"], input[type="password"], input[type="text"]')
      .first();
    if (await pwField.count().catch(() => 0)) {
      await pwField.click({ timeout: 3000 }).catch(() => {});
      await pwField.fill(password).catch(async () => { await h.rabbyPage.keyboard.type(password, { delay: 40 }); });
      await h.rabbyPage.keyboard.press("Enter");
      await h.rabbyPage.waitForTimeout(3500);
      unlocked = true;
    }
  }
  console.log("unlock attempted:", unlocked);
  await h.rabbyPage.waitForTimeout(3000);
  await h.rabbyPage.screenshot({ path: resolve(shotsDir, "02-after-unlock.png") }).catch(() => {});
  const homeText = await h.rabbyPage.evaluate(() => document.body.innerText).catch(() => "");
  console.log("HOME TEXT (first 300):", homeText.slice(0, 300).replace(/\n+/g, " | "));

  // address-management page lists every account in the profile
  await h.rabbyPage.goto(`chrome-extension://${h.rabbyExtensionId}/index.html#/settings/address`).catch(() => {});
  await h.rabbyPage.waitForTimeout(2500);
  await h.rabbyPage.screenshot({ path: resolve(shotsDir, "03-accounts.png") }).catch(() => {});
  const accText = await h.rabbyPage.evaluate(() => document.body.innerText).catch(() => "");
  console.log("ACCOUNTS TEXT:", accText.slice(0, 600).replace(/\n+/g, " | "));
  for (const a of ["0x7eF9", "0x7ef9", "0x0D18", "0x0d18", "0x5448"]) {
    if (accText.toLowerCase().includes(a.toLowerCase())) console.log("  FOUND persona:", a);
  }
  await h.context.close();
})().catch((e) => { console.error("DIAG ERROR:", e.message); process.exit(1); });
