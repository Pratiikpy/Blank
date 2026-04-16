import { Component, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-phase errors anywhere in the subtree so a single broken
 * component doesn't white-screen the whole app. Logs to the structured
 * log helper so Sentry wiring later can capture automatically.
 *
 * Does NOT catch async errors (those must be handled by callers) or
 * event-handler errors (React re-throws those to window.error).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
    // Optional: dispatch to lib/log when it exists
    if (typeof window !== "undefined") {
      // @ts-expect-error — set by lib/log runtime wiring
      window.__blankLogError?.(error, { componentStack: info.componentStack });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-[50vh] flex items-center justify-center p-6">
          <div className="max-w-md rounded-3xl border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-900/20 p-6 space-y-3">
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-medium">
              <AlertCircle size={18} />
              Something broke
            </div>
            <p className="text-sm text-red-800/80 dark:text-red-200/80">
              The error has been logged. Try reloading; if it persists, contact support.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="h-10 px-4 rounded-2xl bg-red-600 text-white text-sm font-medium hover:bg-red-700"
            >
              Reload
            </button>
            <details className="text-xs text-red-800/60 dark:text-red-200/60">
              <summary className="cursor-pointer">Error details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all">{this.state.error.message}</pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
