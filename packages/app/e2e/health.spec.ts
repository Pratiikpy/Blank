import { test, expect } from "@playwright/test";

/**
 * Layer 11 E2E — /api/health endpoint shape.
 *
 * The health check is a control-plane signal for uptime monitoring; it must
 * never 5xx. Valid statuses are 200 (green), 207 (degraded), 503 (red).
 * The body shape is contract with external dashboards — assert every top-level
 * key the dashboards consume.
 */
test("health endpoint returns expected shape", async ({ request }) => {
  const res = await request.get("/api/health");
  // Always returns 200 / 207 / 503 — never 5xx
  expect([200, 207, 503]).toContain(res.status());
  const body = await res.json();
  expect(body).toHaveProperty("status");
  expect(body).toHaveProperty("derived");
  expect(body).toHaveProperty("fhenix");
  expect(body.fhenix).toHaveProperty("cofhe");
  expect(body.fhenix).toHaveProperty("verifier");
  expect(body.fhenix).toHaveProperty("thresholdNetwork");
});
