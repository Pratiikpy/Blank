/**
 * /api/email/[kind] — dynamic-route email dispatcher.
 *
 * Two outbound email flows share one Vercel Serverless Function:
 *   - /api/email/invoice — vendor sends an invoice PDF to a client
 *   - /api/email/request — requester pings a payer about a payment request
 *
 * Handler implementations live in api/_lib/jobs/email-*.ts.
 */

const handlers: Record<string, () => Promise<{ default: (req: any, res: any) => unknown }>> = {
  invoice: () => import("../_lib/jobs/email-invoice.js"),
  request: () => import("../_lib/jobs/email-request.js"),
};

export default async function handler(req: any, res: any) {
  const kind = String(req.query?.kind ?? "");
  const loader = handlers[kind];
  if (!loader) {
    res.status(404).json({ error: `unknown email kind: ${kind || "(empty)"}` });
    return;
  }
  const mod = await loader();
  return mod.default(req, res);
}
