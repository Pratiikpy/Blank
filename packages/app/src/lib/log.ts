/**
 * Minimal structured logger — drop-in replacement for console.warn/error.
 *
 * Every log call is tagged with event, level, timestamp, and optional
 * address/chainId context. If Sentry is wired later, swap the sinks at
 * the bottom of this file; no caller needs to change.
 *
 * Usage:
 *   import { log } from "@/lib/log";
 *   log.info("tx.send", { hash, amount });
 *   log.warn("supabase.insertActivity", { err: String(err) });
 *   log.error("relay.timeout", err);
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  event: string;
  ts: string;
  context?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string };
}

type Sink = (entry: LogEntry) => void;

const sinks: Sink[] = [];

/**
 * Console sink. Production filters out debug-level entries to keep prod
 * console output focused on actionable signal. Dev mode prints every level.
 *
 * §3.21 of BEST_VERSION_FULL_PLAN: the production filter was added so that
 * migrating hot-path console.log calls to log.debug doesn't reintroduce the
 * console spam that the §1.10 esbuild drop solved. Hot-path debug events
 * still flow to non-console sinks (Sentry per §3.22) where they're useful.
 */
sinks.push((entry) => {
  if (entry.level === "debug" && !import.meta.env.DEV) return;
  const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
  // eslint-disable-next-line no-console
  console[method](`[${entry.event}]`, entry.context ?? "", entry.error ?? "");
});

/** Register an extra sink (e.g. Sentry, Amplitude). Called once at app boot. */
export function registerLogSink(sink: Sink) {
  sinks.push(sink);
}

function emit(level: LogLevel, event: string, arg?: unknown) {
  let context: Record<string, unknown> | undefined;
  let error: LogEntry["error"];
  if (arg instanceof Error) {
    error = { name: arg.name, message: arg.message, stack: arg.stack };
  } else if (arg && typeof arg === "object") {
    context = arg as Record<string, unknown>;
  }
  const entry: LogEntry = {
    level,
    event,
    ts: new Date().toISOString(),
    context,
    error,
  };
  for (const sink of sinks) {
    try { sink(entry); } catch { /* sink must not break callers */ }
  }
}

export const log = {
  debug: (event: string, arg?: unknown) => emit("debug", event, arg),
  info: (event: string, arg?: unknown) => emit("info", event, arg),
  warn: (event: string, arg?: unknown) => emit("warn", event, arg),
  error: (event: string, arg?: unknown) => emit("error", event, arg),
};

// Expose a minimal hook so ErrorBoundary and global error handler can
// emit without importing React. Safe to call from vanilla code.
if (typeof window !== "undefined") {
  // @ts-expect-error — intentional global for ErrorBoundary
  window.__blankLogError = (err: Error, ctx?: Record<string, unknown>) => {
    log.error("error_boundary", err);
    if (ctx) log.warn("error_boundary.context", ctx);
  };
  // Capture uncaught errors too
  window.addEventListener("error", (e) => log.error("window.error", e.error ?? new Error(e.message)));
  window.addEventListener("unhandledrejection", (e) =>
    log.error("window.unhandledrejection", e.reason instanceof Error ? e.reason : new Error(String(e.reason))),
  );
}
