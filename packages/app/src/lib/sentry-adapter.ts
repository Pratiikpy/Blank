// @ts-nocheck
// TODO: Run `pnpm install` to enable Sentry — until then this file is a no-op.
//
// The real implementation below is commented out because `@sentry/react` is
// not yet in node_modules. Once `pnpm install` picks up the dependency from
// package.json, uncomment the import + body and delete this stub.
/**
 * Sentry sink for the structured logger.
 *
 * Wires Sentry only when VITE_SENTRY_DSN is set. App still works
 * without it — every log goes to console anyway via the default sink.
 *
 * Init at app boot (App.tsx or main.tsx) by calling initSentry().
 */

// import * as Sentry from "@sentry/react";
// import { registerLogSink } from "./log";

// let _initialized = false;

export function initSentry() {
  // No-op until `pnpm install` brings in @sentry/react. See file header.
  //
  // if (_initialized) return;
  // _initialized = true;
  //
  // const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  // if (!dsn) {
  //   // No DSN configured — keep console-only logging. This is fine for
  //   // local dev + open-source self-hosters who don't want telemetry.
  //   return;
  // }
  //
  // Sentry.init({
  //   dsn,
  //   environment: import.meta.env.MODE,
  //   tracesSampleRate: 0.1,
  //   integrations: [Sentry.browserTracingIntegration()],
  //   // Don't send PII
  //   sendDefaultPii: false,
  // });
  //
  // registerLogSink((entry) => {
  //   if (entry.level === "error") {
  //     // Convert structured log entry back to an Error for Sentry
  //     const err = entry.error
  //       ? Object.assign(new Error(entry.error.message), { name: entry.error.name, stack: entry.error.stack })
  //       : new Error(entry.event);
  //     Sentry.captureException(err, {
  //       tags: { event: entry.event },
  //       extra: entry.context,
  //     });
  //   } else if (entry.level === "warn") {
  //     Sentry.captureMessage(entry.event, {
  //       level: "warning",
  //       tags: { event: entry.event },
  //       extra: entry.context,
  //     });
  //   }
  //   // info/debug → breadcrumbs only
  //   Sentry.addBreadcrumb({
  //     category: entry.event,
  //     level: entry.level === "debug" ? "debug" : entry.level === "info" ? "info" : entry.level,
  //     data: entry.context,
  //     timestamp: new Date(entry.ts).getTime() / 1000,
  //   });
  // });
}
