/**
 * /api/cron/[job] — dynamic-route cron dispatcher.
 *
 * Vercel Hobby caps Serverless Functions at 12 per deployment, so the
 * four cron jobs are consolidated under a single dynamic route. The
 * actual handlers live in api/_lib/jobs/cron-*.ts (private — Vercel
 * does not turn underscored dirs into endpoints) and are dynamic-imported
 * on demand so cold-start cost only pays for the job that fires.
 *
 * vercel.json keeps the original cron paths (/api/cron/reconcile-tick,
 * etc.) — they all route here with req.query.job set to the slug.
 */

const handlers: Record<string, () => Promise<{ default: (req: any, res: any) => unknown }>> = {
  "reconcile-tick": () => import("../_lib/jobs/cron-reconcile-tick.js"),
  "invoice-reminders": () => import("../_lib/jobs/cron-invoice-reminders.js"),
  "paymaster-monitor": () => import("../_lib/jobs/cron-paymaster-monitor.js"),
  "paymaster-refill": () => import("../_lib/jobs/cron-paymaster-refill.js"),
  "scheduled-sends-tick": () => import("../_lib/jobs/cron-scheduled-sends-tick.js"),
  // Frontend-triggered reconciliation (vercel.json rewrites /api/reconcile-user here).
  // Consolidated under this dispatcher to stay within Hobby's 12-function cap.
  "reconcile-user": () => import("../_lib/jobs/reconcile-user.js"),
};

export default async function handler(req: any, res: any) {
  const job = String(req.query?.job ?? "");
  const loader = handlers[job];
  if (!loader) {
    res.status(404).json({ error: `unknown cron job: ${job || "(empty)"}` });
    return;
  }
  const mod = await loader();
  return mod.default(req, res);
}
