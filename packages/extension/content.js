// Pay with Blank — content script
//
// Walk every text node on the page, find 0x… addresses and *.eth /
// *.base.eth names, and inject a "Pay with Blank" button next to each.
// Re-scans on DOM mutations so this works on Twitter, Discord, GitHub —
// anywhere with infinite scroll or reactive updates.
//
// We're deliberately careful about what we touch:
//   • Skip <script>, <style>, <code>, <pre> — code shouldn't be wrapped.
//   • Skip <input>, <textarea>, [contenteditable] — would corrupt user
//     input.
//   • Skip nodes already inside our own injected wrappers (idempotent).
//   • Skip nodes whose ancestor is an <a> link — overlaying buttons on
//     anchors causes broken click semantics.
//
// Every injected element is tagged `data-blank-injected="1"` so we can
// recognise our own work and never double-process.

(() => {
  "use strict";

  // ── Configuration ─────────────────────────────────────────────────
  const APP_ORIGIN_FALLBACK = "https://blank-omega-jade.vercel.app";
  const STORAGE_KEY = "blank.appOrigin";

  // 40 hex chars after 0x, with word boundaries so "0xabc...123FOO" stops at FOO.
  const ADDRESS_RE = /\b(0x[a-fA-F0-9]{40})\b/g;
  // ENS / Basenames — labels separated by dots, ending in `.eth`.
  // Allow 3-63 chars per label, alphanumerics + hyphen (no leading/trailing
  // hyphen). Both `pratik.eth` and `pratik.base.eth` match.
  const NAME_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}eth)\b/gi;

  const SKIPPED_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "CODE",
    "PRE",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "BUTTON",
  ]);

  let appOrigin = APP_ORIGIN_FALLBACK;

  // Read configured origin (set by popup) so users on a self-hosted Blank
  // deployment can point the extension at their own URL.
  try {
    chrome.storage?.sync?.get?.([STORAGE_KEY], (out) => {
      const stored = out?.[STORAGE_KEY];
      if (typeof stored === "string" && /^https?:\/\//.test(stored)) {
        appOrigin = stored.replace(/\/$/, "");
      }
    });
  } catch (_e) {
    // chrome.storage unavailable in some contexts — fall back to default.
  }

  // ── Eligibility check for a text node ─────────────────────────────

  /** Should this text node be scanned? Walks ancestors looking for stop-conditions. */
  function isEligible(node) {
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue;
    if (!text || text.length < 6) return false;
    let parent = node.parentElement;
    while (parent) {
      if (parent.dataset && parent.dataset.blankInjected === "1") return false;
      if (parent.dataset && parent.dataset.blankProcessed === "1") return false;
      if (SKIPPED_TAGS.has(parent.tagName)) return false;
      if (parent.isContentEditable) return false;
      // Skip already-linked text — wrapping a span inside an <a> works but
      // the click handler races with the ancestor anchor. Cleaner to bail.
      if (parent.tagName === "A") return false;
      parent = parent.parentElement;
    }
    return true;
  }

  // ── Replace matched text with original + injected button ──────────

  function buildButton(identifier) {
    const btn = document.createElement("a");
    btn.href = `${appOrigin}/pay/${encodeURIComponent(identifier)}?utm_source=ext`;
    btn.target = "_blank";
    btn.rel = "noopener noreferrer";
    btn.className = "blank-pay-btn";
    btn.dataset.blankInjected = "1";
    btn.title = `Pay with Blank → ${identifier}`;
    btn.textContent = "Pay";
    const dot = document.createElement("span");
    dot.className = "blank-pay-btn__dot";
    dot.dataset.blankInjected = "1";
    btn.prepend(dot);
    return btn;
  }

  /** Collect non-overlapping matches from `text`. Address matches take
   * precedence; an ENS name overlapping an address is dropped. */
  function findMatches(text) {
    const matches = [];
    for (const m of text.matchAll(ADDRESS_RE)) {
      const start = m.index ?? 0;
      matches.push({ start, end: start + m[0].length, value: m[1] });
    }
    for (const m of text.matchAll(NAME_RE)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (matches.some((x) => start < x.end && end > x.start)) continue;
      matches.push({ start, end, value: m[1] });
    }
    matches.sort((a, b) => a.start - b.start);
    return matches;
  }

  /** Replace `node` with: text-before-match, original-match, pay-button, text-after-match. */
  function injectAroundMatches(node) {
    const text = node.nodeValue;
    const matches = findMatches(text);
    if (matches.length === 0) return false;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      }
      // Original token stays visible — we only ADD the button next to it.
      const tokenSpan = document.createElement("span");
      tokenSpan.dataset.blankProcessed = "1";
      tokenSpan.textContent = text.slice(match.start, match.end);
      fragment.appendChild(tokenSpan);
      fragment.appendChild(document.createTextNode(" "));
      fragment.appendChild(buildButton(match.value));
      cursor = match.end;
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    node.parentNode?.replaceChild(fragment, node);
    return true;
  }

  // ── DOM walking ───────────────────────────────────────────────────

  function scan(root) {
    if (!root || !root.ownerDocument) return;
    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => (isEligible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      },
    );
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const target of targets) {
      try {
        injectAroundMatches(target);
      } catch (err) {
        // Never let one weird DOM trip the whole pass.
        console.warn("[blank-ext] inject failed:", err);
      }
    }
  }

  // ── Mutation observer for SPA / infinite-scroll sites ─────────────

  let scheduled = false;
  function scheduleScan(root) {
    if (scheduled) return;
    scheduled = true;
    requestIdleCallback(
      () => {
        scheduled = false;
        scan(root || document.body);
      },
      { timeout: 500 },
    );
  }

  function start() {
    if (!document.body) return;
    scan(document.body);
    const obs = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const added of mut.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            scheduleScan(added);
          } else if (added.nodeType === Node.TEXT_NODE) {
            scheduleScan(added.parentElement);
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // requestIdleCallback isn't on every site / browser — fall back.
  if (typeof requestIdleCallback === "undefined") {
    window.requestIdleCallback = (cb) => setTimeout(cb, 16);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
