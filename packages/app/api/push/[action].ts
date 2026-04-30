/**
 * /api/push/[action] — dynamic-route push dispatcher.
 *
 * Two actions share one Vercel Serverless Function (Hobby plan caps at 12):
 *   - /api/push/subscribe — frontend registers a Web Push subscription
 *   - /api/push/notify    — Supabase webhook fans out a push payload to subs
 *
 * Handler implementations live in api/_lib/jobs/push-*.ts.
 */

const handlers: Record<string, () => Promise<{ default: (req: any, res: any) => unknown }>> = {
  subscribe: () => import("../_lib/jobs/push-subscribe.js"),
  notify: () => import("../_lib/jobs/push-notify.js"),
};

export default async function handler(req: any, res: any) {
  const action = String(req.query?.action ?? "");
  const loader = handlers[action];
  if (!loader) {
    res.status(404).json({ error: `unknown push action: ${action || "(empty)"}` });
    return;
  }
  const mod = await loader();
  return mod.default(req, res);
}
