// Popup logic — lets users point the extension at their own Blank deploy
// (defaults to the public Vercel URL). The chosen origin is read by the
// content script every time it boots, so the change applies on the next
// page load.

(() => {
  "use strict";

  const STORAGE_KEY = "blank.appOrigin";
  const DEFAULT_ORIGIN = "https://www.myblank.app";

  const $origin = document.getElementById("origin");
  const $save = document.getElementById("save");
  const $open = document.getElementById("open");
  const $status = document.getElementById("status");

  function setStatus(msg) {
    $status.textContent = msg ?? "";
  }

  function applyOrigin(origin) {
    const cleaned = (origin || DEFAULT_ORIGIN).replace(/\/$/, "");
    $origin.value = cleaned;
    $open.href = cleaned;
  }

  // Load stored origin on open.
  chrome.storage?.sync?.get?.([STORAGE_KEY], (out) => {
    applyOrigin(out?.[STORAGE_KEY] || DEFAULT_ORIGIN);
  });

  $save.addEventListener("click", () => {
    const value = $origin.value.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(value)) {
      setStatus("URL must start with http:// or https://");
      return;
    }
    chrome.storage?.sync?.set?.({ [STORAGE_KEY]: value }, () => {
      applyOrigin(value);
      setStatus("Saved. Refresh tabs for the change to apply.");
      setTimeout(() => setStatus(""), 3000);
    });
  });
})();
