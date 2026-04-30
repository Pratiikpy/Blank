import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  type WorkspaceMode,
  getMode,
  setMode as persistMode,
  subscribe,
} from "@/lib/workspace-mode";

interface WorkspaceModeContextValue {
  mode: WorkspaceMode;
  setMode: (next: WorkspaceMode) => void;
}

const Ctx = createContext<WorkspaceModeContextValue | null>(null);

export function WorkspaceModeProvider({ children }: { children: ReactNode }) {
  // Initialise from storage so the very first render already has the
  // user's last choice — no flash of "Full" mode for a Freelancer who
  // saved their preference last session.
  const [mode, setModeState] = useState<WorkspaceMode>(() => getMode());

  // Subscribe to cross-tab + same-tab changes. The same-tab path is
  // critical: setMode() in Settings must instantly re-render the
  // sidebar without a navigate or reload.
  useEffect(() => subscribe((next) => setModeState(next)), []);

  const setMode = useCallback((next: WorkspaceMode) => {
    persistMode(next); // emits → subscriber → setModeState
  }, []);

  return (
    <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>
  );
}

export function useWorkspaceMode(): WorkspaceModeContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useWorkspaceMode must be used inside <WorkspaceModeProvider>",
    );
  }
  return v;
}
