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

export function PassphrasePromptProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Unlock smart wallet");
  const [subtitle, setSubtitle] = useState("Enter your passphrase to sign this transaction.");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const resolverRef = useRef<((v: string | null) => void) | null>(null);

  const request = useCallback(
    (opts?: { title?: string; subtitle?: string }) => {
      return new Promise<string | null>((resolve) => {
        setTitle(opts?.title ?? "Unlock smart wallet");
        setSubtitle(opts?.subtitle ?? "Enter your passphrase to sign this transaction.");
        setValue("");
        resolverRef.current = resolve;
        setOpen(true);
      });
    },
    [],
  );

  const close = useCallback((v: string | null) => {
    if (resolverRef.current) {
      resolverRef.current(v);
      resolverRef.current = null;
    }
    setOpen(false);
    setValue("");
  }, []);

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
