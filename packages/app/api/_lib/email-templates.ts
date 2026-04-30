/**
 * Shared HTML templates for transactional email.
 *
 * We keep these simple and inline-styled (most email clients strip <style>
 * blocks anyway). Brand-consistent: deep ink text, emerald CTA, lots of
 * whitespace. The matching plain-text version is auto-derived for spam
 * filters / accessibility.
 */

interface BrandedEmailArgs {
  preheader: string;
  title: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  /** Optional rows rendered as a definition list under the intro. */
  rows?: Array<{ label: string; value: string }>;
  /** Optional footer note (e.g. "Encrypted on-chain"). */
  footer?: string;
}

export function renderBrandedEmail(args: BrandedEmailArgs): { html: string; text: string } {
  const rows = args.rows ?? [];
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#F9FAFB;color:#1D1D1F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;">
    <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(args.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border:1px solid #E4E4E7;border-radius:24px;overflow:hidden;">
            <tr>
              <td style="padding:40px 40px 32px 40px;">
                <p style="margin:0 0 8px 0;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#71717A;">Blank</p>
                <h1 style="margin:0 0 16px 0;font-size:26px;font-weight:600;letter-spacing:-0.4px;color:#1D1D1F;">${escapeHtml(args.title)}</h1>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.55;color:#3F3F46;">${escapeHtml(args.intro)}</p>
                ${
                  rows.length > 0
                    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E4E4E7;margin:0 0 24px 0;">
                  ${rows
                    .map(
                      (r) => `<tr>
                    <td style="padding:14px 0;border-bottom:1px solid #E4E4E7;font-size:13px;color:#71717A;">${escapeHtml(r.label)}</td>
                    <td align="right" style="padding:14px 0;border-bottom:1px solid #E4E4E7;font-size:14px;color:#1D1D1F;font-weight:500;">${escapeHtml(r.value)}</td>
                  </tr>`,
                    )
                    .join("")}
                </table>`
                    : ""
                }
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0 0;">
                  <tr>
                    <td style="border-radius:14px;background:#1D1D1F;">
                      <a href="${escapeAttribute(args.ctaUrl)}" style="display:inline-block;padding:14px 28px;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:14px;">${escapeHtml(args.ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:18px 0 0 0;font-size:12px;color:#A1A1AA;word-break:break-all;">${escapeHtml(args.ctaUrl)}</p>
              </td>
            </tr>
            ${
              args.footer
                ? `<tr><td style="padding:0 40px 32px 40px;font-size:12px;color:#71717A;line-height:1.5;">${escapeHtml(args.footer)}</td></tr>`
                : ""
            }
          </table>
          <p style="margin:24px 0 0 0;font-size:11px;color:#A1A1AA;">Sent by Blank · Private payments on Fhenix CoFHE</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // Plain-text fallback — mirrors the same content for clients that don't
  // render HTML.
  const text =
    `${args.title}\n\n${args.intro}\n\n` +
    rows.map((r) => `${r.label}: ${r.value}`).join("\n") +
    (rows.length > 0 ? "\n\n" : "") +
    `${args.ctaLabel}: ${args.ctaUrl}` +
    (args.footer ? `\n\n${args.footer}` : "");

  return { html, text };
}

// ─── Specialised builders ───────────────────────────────────────────────

export interface InvoiceEmailArgs {
  invoiceId: number;
  vendorName: string;
  amount: string;
  currency: string;
  description: string;
  dueDate: string | null;
  payUrl: string;
}

export function renderInvoiceEmail(args: InvoiceEmailArgs) {
  const subject = `${args.vendorName} sent you an invoice — $${args.amount} ${args.currency}`;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Amount", value: `${args.amount} ${args.currency}` },
    { label: "Description", value: args.description || "—" },
  ];
  if (args.dueDate) {
    rows.push({
      label: "Due",
      value: new Date(args.dueDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    });
  }
  rows.push({ label: "Invoice", value: `#${args.invoiceId.toString().padStart(4, "0")}` });

  const { html, text } = renderBrandedEmail({
    preheader: `${args.vendorName} sent you an invoice for ${args.amount} ${args.currency}.`,
    title: "You have an invoice",
    intro: `${args.vendorName} just sent you an invoice via Blank. Pay in one click — the amount stays private on-chain.`,
    ctaLabel: "Pay invoice",
    ctaUrl: args.payUrl,
    rows,
    footer:
      "The amount you see here is for your records. On-chain, it stays encrypted — only you and the sender ever see the number.",
  });
  return { subject, html, text };
}

export interface PaymentRequestEmailArgs {
  requestId: number;
  requesterName: string;
  note: string;
  reviewUrl: string;
}

export function renderPaymentRequestEmail(args: PaymentRequestEmailArgs) {
  const subject = `${args.requesterName} requested a payment from you on Blank`;
  const { html, text } = renderBrandedEmail({
    preheader: `${args.requesterName} just sent you a payment request on Blank.`,
    title: "Payment request",
    intro: `${args.requesterName} is requesting a payment from you. Open Blank to review and decide.`,
    ctaLabel: "Review request",
    ctaUrl: args.reviewUrl,
    rows: args.note
      ? [
          { label: "From", value: args.requesterName },
          { label: "Note", value: args.note },
          { label: "Request", value: `#${args.requestId}` },
        ]
      : [
          { label: "From", value: args.requesterName },
          { label: "Request", value: `#${args.requestId}` },
        ],
  });
  return { subject, html, text };
}

// ─── HTML escaping ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(s: string): string {
  // URL attributes — URL itself is already safe (we control it), but we
  // still HTML-escape to be defensive.
  return escapeHtml(s);
}
