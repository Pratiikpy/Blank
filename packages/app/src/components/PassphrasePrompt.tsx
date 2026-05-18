import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { Fingerprint, Loader2, X } from "lucide-react";

// ──────────────────────────────────────────────────────────────────
//  PassphrasePrompt — global modal for unlocking the smart-wallet
//  passkey. Provider mounts once at the app root; any hook can call
//  usePassphrasePrompt().request() to get a one-shot passphrase.
//
//  Pattern: returns a Promise<string | null> that resolves on submit
//  or null on cancel. Caller awaits it inline — no callback hell.
// ──────────────────────────────────────────────────────────────────

interface PassphrasePromptContext {
  request: (opts?: { title?: string; subtitle?: string }) => Promise<string | null>;
}

const Ctx = createContext<PassphrasePromptContext | null>(null);

export function usePassphrasePrompt(): PassphrasePromptContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePassphrasePrompt: PassphrasePromptProvider missing");
  return ctx;
}

interface QueuedRequest {
  resolver: (v: string | null) => void;
  title: string;
  subtitle: string;
  /** Auto-expire this entry after N ms of sitting in the queue. Protects
   *  callers whose caller-side flow was cancelled but didn't unwind the
   *  passphrase promise — prevents hang-forever. */
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/** How long a queued request waits before we auto-settle it with null.
 *  60s balances UX (real users finish typing in <60s) with safety (we
 *  can't leak promises forever). */
const QUEUE_ENTRY_TIMEOUT_MS = 60_000;

// #377: hoist the queue + listener registry to module scope so it survives
// provider remounts. In dev (StrictMode + Vite HMR + cross-route page
// navigations) the provider can unmount + remount while a UserOp request
// is in flight; if the queue lives on a per-instance useRef, the new
// instance's queue is empty and the inbound modal close() becomes a no-op
// — the pending promise stays unsettled until the 60s queue-timer fires
// with null. Wave4 phase 02 reproduced this on every approve UserOp prompt.
const _passphraseQueue: QueuedRequest[] = [];
const _passphraseListeners = new Set<() => void>();

function _notifyQueueChanged() {
  for (const fn of _passphraseListeners) {
    try { fn(); } catch { /* listener threw — don't break others */ }
  }
}

export function PassphrasePromptProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(_passphraseQueue.length > 0);
  const [title, setTitle] = useState(_passphraseQueue[0]?.title ?? "Unlock smart wallet");
  const [subtitle, setSubtitle] = useState(_passphraseQueue[0]?.subtitle ?? "Enter your passphrase to sign this transaction.");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe to queue mutations so a request from any source (a sibling
  // provider mount during a remount race) re-syncs this instance.
  useEffect(() => {
    const listener = () => {
      const head = _passphraseQueue[0];
      if (head) {
        setTitle(head.title);
        setSubtitle(head.subtitle);
        setOpen(true);
      } else {
        setOpen(false);
      }
    };
    _passphraseListeners.add(listener);
    listener();
    return () => { _passphraseListeners.delete(listener); };
  }, []);

  const request = useCallback(
    (opts?: { title?: string; subtitle?: string }) => {
      return new Promise<string | null>((resolve) => {
        const entry: QueuedRequest = {
          resolver: resolve,
          title: opts?.title ?? "Unlock smart wallet",
          subtitle: opts?.subtitle ?? "Enter your passphrase to sign this transaction.",
          timeoutId: null,
        };
        // #124: auto-settle after 60s so cancelled flows don't leak
        // promises forever. Reads against the module-scope queue (see
        // #377 comment above) so the timer survives provider remounts.
        entry.timeoutId = setTimeout(() => {
          const idx = _passphraseQueue.indexOf(entry);
          if (idx >= 0) {
            _passphraseQueue.splice(idx, 1);
            entry.resolver(null);
            _notifyQueueChanged();
          }
        }, QUEUE_ENTRY_TIMEOUT_MS);
        _passphraseQueue.push(entry);
        console.log("[PassphrasePrompt.request]", JSON.stringify({
          title: entry.title.slice(0, 40),
          queueLenAfter: _passphraseQueue.length,
        }));
        _notifyQueueChanged();
      });
    },
    [],
  );

  const close = useCallback((v: string | null) => {
    // #377 diag: log every close() call so the e2e trace shows whether the
    // resolver was settled with a real passphrase or null.
    console.log("[PassphrasePrompt.close]", JSON.stringify({
      hasValue: v !== null && v !== "",
      queueLenBefore: _passphraseQueue.length,
    }));
    // Settle the FRONT resolver (FIFO) against the module-scope queue.
    const front = _passphraseQueue.shift();
    if (front) {
      if (front.timeoutId) clearTimeout(front.timeoutId);
      front.resolver(v);
    }
    setValue("");
    _notifyQueueChanged();
  }, []);

  // #377: no cleanup-side resolver(null). Pending requests survive provider
  // remounts via the module-scope `_passphraseQueue`. Cleanup is intentionally
  // a no-op; the only state that needed cleanup (the focus/key-event handlers)
  // is cleaned by its own useEffect below.

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <Ctx.Provider value={{ request }}>
      {children}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={(e) => { if (e.target === e.currentTarget) close(null); }}
        >
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-[#0F0F10] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden">
            <div className="flex items-start gap-3 p-6 pb-4">
              <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                <Fingerprint size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-heading font-semibold text-[var(--text-primary)] text-base">
                  {title}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-snug">
                  {subtitle}
                </p>
              </div>
              <button
                onClick={() => close(null)}
                aria-label="Cancel"
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] -mt-1 -mr-1"
              >
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (value) close(value);
              }}
              className="px-6 pb-6 space-y-3"
            >
              <input
                ref={inputRef}
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Passphrase"
                // Suppress Chrome's password-manager dropdown. This is an
                // ephemeral signing passphrase, NOT a saved credential.
                // new-password reliably stops "No username / saved passwords"
                // autofill from rendering over the modal.
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                name="blank-passphrase"
                data-lpignore="true"
                data-1p-ignore="true"
                className="w-full h-12 px-4 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] border border-black/5 dark:border-white/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm"
              />
              <button
                type="submit"
                disabled={!value}
                className="w-full h-12 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                Unlock
              </button>
              <p className="text-[11px] text-[var(--text-tertiary)] text-center pt-1">
                Decryption happens locally — your passphrase never leaves this browser.
              </p>
            </form>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

// Helper for hooks: shows a loading-state spinner overlay while signing.
export function SigningOverlay({ visible, label }: { visible: boolean; label: string }) {
  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-[99] flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="rounded-2xl bg-white dark:bg-[#0F0F10] border border-black/10 dark:border-white/10 px-6 py-5 flex items-center gap-3 shadow-xl">
        <Loader2 size={18} className="animate-spin text-blue-600 dark:text-blue-400" />
        <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
      </div>
    </div>
  );
}
