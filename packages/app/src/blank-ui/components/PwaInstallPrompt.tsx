import { useEffect, useState } from "react";
import { Download, X, Share2 } from "lucide-react";

const DISMISSED_KEY = "blank:pwa-prompt-dismissed-v1";
const VISIT_COUNT_KEY = "blank:visit-count-v1";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

// Wave 5 Block 7 — PWA install nudge.
//
// Two install paths:
//   Android / Chromium: native `beforeinstallprompt` event capture.
//     We hold the event and show our own button.
//   iOS Safari: no programmatic install. Show a tutorial that says
//     "tap Share -> Add to Home Screen". Triggered when (a) iOS Safari
//     is detected AND (b) the standalone display mode is NOT active
//     AND (c) the user has visited 3+ times AND (d) they haven't
//     dismissed.

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const webkit = /WebKit/.test(ua);
  const notChrome = !/CriOS/.test(ua) && !/FxiOS/.test(ua);
  return iOS && webkit && notChrome;
}

function isStandalone(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari sets navigator.standalone on installed PWAs.
  // The type isn't in lib.dom.d.ts; cast through.
  return Boolean((navigator as unknown as { standalone?: boolean }).standalone);
}

function bumpVisitCount(): number {
  try {
    const prev = Number(localStorage.getItem(VISIT_COUNT_KEY) ?? "0");
    const next = prev + 1;
    localStorage.setItem(VISIT_COUNT_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

export function PwaInstallPrompt() {
  const [androidPrompt, setAndroidPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosTutorial, setShowIosTutorial] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    const visits = bumpVisitCount();
    const dismissed = localStorage.getItem(DISMISSED_KEY) === "1";
    if (dismissed) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setAndroidPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    if (isIosSafari() && visits >= 3) {
      setShowIosTutorial(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* noop */ }
    setAndroidPrompt(null);
    setShowIosTutorial(false);
  };

  const triggerAndroidInstall = async () => {
    if (!androidPrompt) return;
    await androidPrompt.prompt();
    const choice = await androidPrompt.userChoice;
    if (choice.outcome === "accepted") {
      try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* noop */ }
    }
    setAndroidPrompt(null);
  };

  if (!androidPrompt && !showIosTutorial) return null;

  return (
    <div
      data-testid="pwa-install-prompt"
      role="dialog"
      className="fixed left-3 right-3 bottom-3 z-40 sm:left-auto sm:right-6 sm:max-w-xs"
    >
      <div className="glass-card-static rounded-2xl p-4 shadow-2xl flex items-start gap-3 bg-white">
        <div className="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center shrink-0">
          {androidPrompt ? <Download size={18} className="text-blue-600" /> : <Share2 size={18} className="text-blue-600" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold mb-1">Install Blank</div>
          {androidPrompt ? (
            <>
              <div className="text-xs text-[var(--text-secondary)] mb-2 leading-snug">
                One-tap install for offline support and push notifications.
              </div>
              <button
                data-testid="pwa-install-android"
                onClick={triggerAndroidInstall}
                className="h-9 px-4 rounded-xl bg-[#1D1D1F] text-white text-xs font-medium hover:bg-black"
              >
                Install
              </button>
            </>
          ) : (
            <div className="text-xs text-[var(--text-secondary)] leading-snug">
              Tap the <span className="font-medium">Share</span> icon at the
              bottom of Safari, then <span className="font-medium">Add to
              Home Screen</span>.
            </div>
          )}
        </div>
        <button
          data-testid="pwa-install-dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
          className="p-1.5 rounded-lg hover:bg-black/5"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
