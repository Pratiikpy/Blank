import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal Playwright config — Layer 11 smoke tests.
 *
 * Assumes the Vite dev server is already running on :5173
 * (run `pnpm dev` in a separate terminal). We deliberately do NOT
 * configure `webServer` here so tests can be pointed at either local
 * dev, preview, or a deployed URL via PLAYWRIGHT_BASE_URL.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
