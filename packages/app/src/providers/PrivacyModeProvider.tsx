import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";

// PrivacyModeProvider — single source of truth for the global "hide
// balances / mask amounts" toggle in the sidebar. Persists across reloads
// via localStorage so the user's preference sticks.
//
// Before this provider, DesktopSidebar and Dashboard each held their own
// useState(true) for privacyMode — the sidebar toggle clicked but the
// Dashboard's masked balances never reacted.

interface PrivacyModeContextValue {
  privacyMode: boolean;
  setPrivacyMode: (v: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<PrivacyModeContextValue | null>(null);

const STORAGE_KEY = "blank_privacy_mode";

function readInitial(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return true; // default ON for privacy
  return stored === "true";
}

export function PrivacyModeProvider({ children }: { children: ReactNode }) {
  const [privacyMode, setPrivacyModeState] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, String(privacyMode));
    }
  }, [privacyMode]);

  const setPrivacyMode = useCallback((v: boolean) => setPrivacyModeState(v), []);
  const toggle = useCallback(() => setPrivacyModeState((p) => !p), []);

  return <Ctx.Provider value={{ privacyMode, setPrivacyMode, toggle }}>{children}</Ctx.Provider>;
}

export function usePrivacyMode(): PrivacyModeContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePrivacyMode must be used inside PrivacyModeProvider");
  return ctx;
}
