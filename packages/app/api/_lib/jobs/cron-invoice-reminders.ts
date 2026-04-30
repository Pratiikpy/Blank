/**
 * /api/cron/invoice-reminders — Vercel Cron entrypoint
 *
 * Daily reminder fan-out. For each unpaid invoice we know about:
 *
 *   • T-3d  → "upcoming" reminder (push + email if available)
 *   • T0    → "due today" reminder
 *   • T+1d  → "overdue" reminder
 *   • T+7d  → second "overdue" nudge
 *
 * We dedupe by `invoices.last_reminder_at` — never send more than once per
 * 22-hour window for the same invoice. Skipped silently when Resend or
 * Supabase env vars are missing (no-op cron is fine).
 *
 * Late fees: deferred to a follow-up — needs a `BusinessHub.applyLateFee`
 * contract method (UUPS upgrade), which is its own work item.
 *
 * Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
 */

import { getSupabaseAdmin } from "../supabase-admin.js";
import { sendEmail, emailEnabled } from "../resend.js";
import { renderReminderEmail, type ReminderKind } from "../reminder-email.js";

const REMINDER_DEDUPE_HOURS = 22;
const ONE_DAY_MS = 86_400_000;
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "https://blank.app";

interface InvoiceForReminder {
  invoice_id: number;
  vendor_address: string;
  client_address: string;
  description: string;
  due_date: string | null;
  status: string;
  client_email: string | null;
  vendor_email: string | null;
  last_reminder_at: string | null;
}

function classify(dueDateIso: string | null, now: number): ReminderKind | null {
  if (!dueDateIso) return null;
  const due = new Date(dueDateIso).getTime();
  if (Number.isNaN(due)) return null;
  const deltaDays = Math.floor((due - now) / ONE_DAY_MS);
  if (deltaDays === 3) return "upcoming";
  if (deltaDays === 0) return "due_today";
  if (deltaDays === -1 || deltaDays === -7) return "overdue";
  return null;
}

/** Trigger Web Push to the client (if any subscriptions registered). */
async function fanoutPush(args: {
  baseUrl: string;
  secret: string | undefined;
  clientAddress: string;
  invoiceId: number;
  kind: ReminderKind;
  vendorLabel: string;
  amountLabel: string;
}) {
  if (!args.secret) return; // No PUSH_NOTIFY_SECRET configured.
  const titleByKind: Record<ReminderKind, string> = {
    upcoming: "Invoice due soon",
    due_today: "Invoice due today",
    overdue: "Invoice past due",
  };
  try {
    await fetch(`${args.baseUrl}/api/push/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.secret}`,
      },
      body: JSON.stringify({
        addresses: [args.clientAddress.toLowerCase()],
        payload: {
          title: titleByKind[args.kind],
          body: `${args.vendorLabel} — ${args.amountLabel}. Tap to pay.`,
          url: `/pay/INV-${args.invoiceId}`,
          tag: `invoice-reminder:${args.invoiceId}:${args.kind}`,
        },
      }),
    });
  } catch (err) {
    console.warn("invoice-reminders push fanout failed:", err);
  }
}

export default async function handler(req: any, res: any) {
  // Fail closed: missing CRON_SECRET in env = reject all requests.
  const expected = process.env.CRON_SECRET;
  const provided = req.headers["authorization"];
  if (!expected || provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(200).json({ status: "no-db", reminded: 0 });
    return;
  }

  // Pull invoices that are still unpaid and have a due date set. We deal
  // with the date math in JS rather than SQL so the same logic produces
  // the same partition regardless of database TZ.
  const { data, error } = await admin
    .from("invoices")
    .select(
      "invoice_id, vendor_address, client_address, description, due_date, status, client_email, vendor_email, last_reminder_at",
    )
    .in("status", ["pending", "payment_pending"])
    .not("due_date", "is", null)
    .limit(500);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const invoices = (data ?? []) as InvoiceForReminder[];
  const now = Date.now();
  const cutoff = now - REMINDER_DEDUPE_HOURS * 3_600_000;
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : PUBLIC_APP_URL;
  const pushSecret = process.env.PUSH_NOTIFY_SECRET;
  const canEmail = emailEnabled();

  let reminded = 0;
  let skippedDeduped = 0;
  let skippedNoMatch = 0;

  for (const invoice of invoices) {
    const kind = classify(invoice.due_date, now);
    if (!kind) {
      skippedNoMatch++;
      continue;
    }
    if (
      invoice.last_reminder_at &&
      new Date(invoice.last_reminder_at).getTime() > cutoff
    ) {
      skippedDeduped++;
      continue;
    }

    const vendorLabel =
      invoice.vendor_address.slice(0, 6) + "…" + invoice.vendor_address.slice(-4);
    const amountLabel = invoice.description || `Invoice #${invoice.invoice_id}`;
    const payUrl = `${baseUrl}/pay/INV-${invoice.invoice_id}`;

    // Email branch — best-effort.
    if (canEmail && invoice.client_email) {
      const tpl = renderReminderEmail({
        kind,
        invoiceId: invoice.invoice_id,
        vendorName: vendorLabel,
        amount: amountLabel,
        currency: "USDC",
        dueDate: invoice.due_date,
        payUrl,
      });
      try {
        await sendEmail({
          to: invoice.client_email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          replyTo: invoice.vendor_email ?? undefined,
          idempotencyKey: `reminder:${invoice.invoice_id}:${kind}:${new Date(now).toISOString().slice(0, 10)}`,
        });
      } catch (err) {
        console.warn("invoice-reminders email failed:", err);
      }
    }

    // Push branch — best-effort.
    await fanoutPush({
      baseUrl,
      secret: pushSecret,
      clientAddress: invoice.client_address,
      invoiceId: invoice.invoice_id,
      kind,
      vendorLabel,
      amountLabel,
    });

    // Mark as reminded so the next tick doesn't re-fire within 22h.
    await admin
      .from("invoices")
      .update({ last_reminder_at: new Date(now).toISOString() })
      .eq("invoice_id", invoice.invoice_id);

    reminded++;
  }

  res.status(200).json({
    status: "ok",
    scanned: invoices.length,
    reminded,
    skippedDeduped,
    skippedNoMatch,
  });
}
