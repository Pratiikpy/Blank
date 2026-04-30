# E2E tests (Playwright)

Layer 11 smoke tests. Runs against a locally-served build of the app.

## One-time setup

Install the Chromium browser binaries Playwright uses:

```bash
pnpm exec playwright install chromium
```

## Running

In one terminal, start the dev server:

```bash
pnpm dev
```

In another terminal, run the tests:

```bash
pnpm test:e2e
```

By default tests hit `http://localhost:5173`. Override with:

```bash
PLAYWRIGHT_BASE_URL=https://preview.example.com pnpm test:e2e
```

## What's covered

- `landing.spec.ts` — asserts the root page loads with title "Blank" and
  the GlobalCounter region mounts. The counter value itself may be "—"
  or a dollar figure depending on whether a wallet is connected; we only
  check that the section renders.
