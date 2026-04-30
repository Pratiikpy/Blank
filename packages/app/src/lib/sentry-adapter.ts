/**
 * Sentry sink for the structured logger.
 *
 * Wires Sentry only when VITE_SENTRY_DSN is set. App still works without
 * it — every log goes to console anyway via the default sink. The check
 * is at runtime so a self-hosted deploy without telemetry stays silent.
 *
 * Init at app boot (main.tsx) by calling initSentry().
 */
import * as Sentry from "@sentry/react";
import { registerLogSink } from "./log";

let _initialized = false;

export function initSentry() {
  if (_initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    // No DSN configured — keep console-only logging. Fine for local dev
    // and open-source self-hosters who don't want telemetry.
    return;
  }
  _initialized = true;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Sample 10% of transactions for performance — tune up to 1.0 if
    // upgrading to a paid plan with more event quota.
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
    // Don't send PII; user wallet addresses + email surface in some
    // breadcrumbs and are fine, but full IP / device fingerprints aren't.
    sendDefaultPii: false,
  });

  registerLogSink((entry) => {
    if (entry.level === "error") {
      // Convert structured log entry back to an Error for Sentry's
      // stack-trace + grouping logic.
      const err = entry.error
        ? Object.assign(new Error(entry.error.message), {
            name: entry.error.name,
            stack: entry.error.stack,
          })
        : new Error(entry.event);
      Sentry.captureException(err, {
        tags: { event: entry.event },
        extra: entry.context,
      });
    } else if (entry.level === "warn") {
      Sentry.captureMessage(entry.event, {
        level: "warning",
        tags: { event: entry.event },
        extra: entry.context,
      });
    }
    // info / debug → breadcrumbs only (cheap, attached to the next error).
    // Sentry's SeverityLevel uses "warning" (not "warn"); map our log
    // level vocabulary to Sentry's. error → error, warn → warning,
    // info → info, debug → debug.
    const sentryLevel: Sentry.SeverityLevel =
      entry.level === "warn" ? "warning" : entry.level;
    Sentry.addBreadcrumb({
      category: entry.event,
      level: sentryLevel,
      data: entry.context,
      timestamp: new Date(entry.ts).getTime() / 1000,
    });
  });
}
