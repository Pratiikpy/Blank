// Coach-mark banner pointing iPhone/iPad Safari users at "Add to Home
// Screen". Web Push notifications on iOS only fire when Blank is
// installed as a PWA — Apple gated this on home-screen install in iOS
// 16.4. Without coaching, mobile Safari users assume push is broken
// because the prompt never appears.
//
// Visibility rules:
//   1. Render only on iPhone/iPad (`isIos()`).
//   2. Hide when already in standalone mode (`isStandalonePwa()`).
//   3. Hide once the user has explicitly dismissed it (sticky via
//      localStorage so we don't re-prompt every session).
//
// Dismissal is per-device, not per-account, so re-prompting after the
// user reinstalls or clears storage is correct behaviour — they may
// genuinely benefit from another nudge.

import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";
import { isIos, isStandalonePwa } from "@/lib/push-notifications";

const STORAGE_KEY = "blank_ios_pwa_coach_dismissed";

function readDismissed(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* localStorage quota / disabled — best effort, fail closed */
  }
}

export function IosPwaCoachMark() {
  // Run-once detection inside the effect so SSR / non-browser environments
  // don't render anything during hydration.
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!isIos()) return;
    if (isStandalonePwa()) return;
    if (readDismissed()) return;
    setShouldShow(true);
  }, []);

  if (!shouldShow) return null;

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 p-4 flex items-start gap-3"
    >
      <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center text-blue-700 dark:text-blue-300 shrink-0">
        <Share size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-blue-900 dark:text-blue-300 mb-0.5">
          Add Blank to your Home Screen
        </p>
        <p className="text-sm text-blue-700 dark:text-blue-400/80 leading-snug">
          Payment notifications on iPhone require the home-screen install.
          Tap the Share icon in Safari, then{" "}
          <span className="font-medium">Add to Home Screen</span>.
        </p>
      </div>
      <button
        onClick={() => {
          writeDismissed();
          setShouldShow(false);
        }}
        className="shrink-0 w-8 h-8 rounded-full hover:bg-blue-100 dark:hover:bg-blue-500/20 flex items-center justify-center text-blue-700 dark:text-blue-300"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
