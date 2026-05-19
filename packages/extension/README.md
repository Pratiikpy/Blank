# Pay with Blank, Chrome Extension

Inject a one-click "Pay" button next to every Ethereum address (`0x…`) and
ENS / Basenames name (`pratik.eth`, `pratik.base.eth`) you see on the web.
Click → opens Blank's `/pay/<id>` page in a new tab with the recipient
pre-filled.

## Local install (development)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Pick this folder: `packages/extension/`
5. The "Pay with Blank" extension appears in your toolbar.
6. Visit any page with an Ethereum address (Etherscan, Twitter, Discord,
   GitHub). Buttons should appear next to addresses within ~1s.

## Configure target URL

Click the extension icon to open the popup and change the **App URL**.
Defaults to `https://blank-omega-jade.vercel.app`. Useful when running a
local Blank dev server (`http://localhost:3000`) or your own deployment.

## What it touches

- Walks text nodes on the page.
- Skips: `<script>`, `<style>`, `<code>`, `<pre>`, `<input>`, `<textarea>`,
  `[contenteditable]`, anything inside an `<a>`.
- Idempotent: every injected element carries `data-blank-injected="1"` so
  re-scans never duplicate.
- Re-scans on `MutationObserver` events (Twitter, Discord, Notion, etc.).

## Files

| File              | Purpose                                                |
|-------------------|--------------------------------------------------------|
| `manifest.json`   | Manifest V3 declaration                                |
| `content.js`      | DOM scan + button injection                            |
| `content.css`     | Injected button styles (scoped + `!important`)         |
| `popup.html`      | Settings popup                                         |
| `popup.js`        | Popup logic, saves App URL to `chrome.storage.sync`    |
| `background.js`   | MV3 SW stub (no-op for now)                            |

## Wave 4+ TODO

- [ ] Right-click context-menu: "Pay this address with Blank"
- [ ] Keyboard shortcut: pay the most recently copied address
- [ ] Firefox / Safari ports (`browser_specific_settings`)
- [ ] Chrome Web Store listing (privacy policy, screenshots)
