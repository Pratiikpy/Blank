// Background service worker (extension MV3 SW — distinct from the app's
// /sw.js). Currently a no-op — we keep it because Chrome's MV3 enforcement
// is fussy about extensions without one and a stub is safer than letting
// the platform pick its own behavior.
//
// Future hooks:
//   • Listen for chrome.commands keyboard shortcuts ("Pay last copied 0x")
//   • Right-click context menu integration ("Pay this address with Blank")

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
