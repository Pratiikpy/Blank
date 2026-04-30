// Workspace mode — pick a focused subset of features so the app stops
// feeling like a "feature pile" the first time a user opens it.
//
// Storage model: a single global preference (NOT per-address). The
// rationale is that a user's role doesn't change per-wallet — a
// freelancer is a freelancer regardless of which smart account they're
// signed into. Per-address scoping would also require a no-op fallback
// for visitors who haven't connected yet.

export type WorkspaceMode = "freelancer" | "business" | "privacy" | "full";

export const WORKSPACE_MODES: WorkspaceMode[] = [
  "freelancer",
  "business",
  "privacy",
  "full",
];

export const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  freelancer: "Freelancer",
  business: "Business",
  privacy: "Privacy",
  full: "Full",
};

export const WORKSPACE_MODE_DESCRIPTIONS: Record<WorkspaceMode, string> = {
  freelancer:
    "Just the essentials for invoicing clients and getting paid privately.",
  business:
    "Adds payroll, escrow, group expenses, and analytics for teams and small businesses.",
  privacy:
    "Stealth payments, burner wallets, inheritance, and on-chain proofs for users who lead with privacy.",
  full: "Everything — every screen and every feature.",
};

const STORAGE_KEY = "blank_workspace_mode";
const DEFAULT_MODE: WorkspaceMode = "full";

function isValidMode(s: string | null): s is WorkspaceMode {
  return s !== null && (WORKSPACE_MODES as readonly string[]).includes(s);
}

/** Read the current mode from localStorage. SSR-safe (returns the default). */
export function getMode(): WorkspaceMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isValidMode(raw) ? raw : DEFAULT_MODE;
}

// In-memory subscribers so a same-tab `setMode` re-renders the sidebar
// immediately. The browser `storage` event covers cross-tab updates but
// does NOT fire in the tab that wrote the change — so we need a
// supplementary in-memory event.
type Listener = (mode: WorkspaceMode) => void;
const listeners = new Set<Listener>();

function emit(mode: WorkspaceMode) {
  for (const l of listeners) {
    try {
      l(mode);
    } catch {
      // Listeners must not break each other.
    }
  }
}

/** Persist + broadcast a mode change. Idempotent if the value matches. */
export function setMode(mode: WorkspaceMode): void {
  if (typeof window === "undefined") return;
  if (!(WORKSPACE_MODES as readonly string[]).includes(mode)) return;
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current === mode) return;
  window.localStorage.setItem(STORAGE_KEY, mode);
  emit(mode);
}

/** Subscribe to mode changes (same-tab + cross-tab). Returns unsubscribe. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  let storageHandler: ((e: StorageEvent) => void) | null = null;
  if (typeof window !== "undefined") {
    storageHandler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = isValidMode(e.newValue) ? e.newValue : DEFAULT_MODE;
      listener(next);
    };
    window.addEventListener("storage", storageHandler);
  }
  return () => {
    listeners.delete(listener);
    if (storageHandler && typeof window !== "undefined") {
      window.removeEventListener("storage", storageHandler);
    }
  };
}
