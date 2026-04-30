/**
 * /api/invoices/send-email
 *
 * Send an invoice email to the client. Looks up the invoice by ID,
 * fetches the IPFS-pinned PDF (if available), renders a Stripe-style
 * HTML email, and sends via Resend with the PDF attached.
 *
 * Body: { invoiceId: number, recipientEmail?: string, amount: string, payUrl?: string }
 *   - `recipientEmail` overrides the row's `client_email`. Useful when
 *     the vendor enters / corrects the address at email-send time.
 *   - `amount` is the human-readable plaintext amount the client should
 *     see. Required because the on-chain amount is encrypted.
 *   - `payUrl` defaults to `${origin}/pay/INV-<id>?amount=<amount>`.
 *
 * Auth: rate-limited per IP. Wallet-signed auth is a Wave 4 follow-up.
 *
 * Returns: { ok: true, messageId } | { ok: false, error }
 */

import { getSupabaseAdmin } from "../_lib/supabase-admin";
import { checkRateLimit, writeRateLimitHeaders } from "../_lib/rate-limit";
import { sendEmail, emailEnabled, EmailNotConfiguredError } from "../_lib/resend";
import { renderInvoiceEmail } from "../_lib/email-templates";
import {
  buildInvoiceEmailMessage,
  checkTimestampWindow,
  strictEmailAuthEnabled,
  verifyOwnerSignature,
} from "../_lib/sig-auth";
import { ipfsUrl } from "../../src/lib/ipfs";

interface SendInvoiceEmailBody {
  invoiceId: number;
  recipientEmail?: string;
  /** Plaintext amount for the email body (e.g. "3700" or "3,700"). */
  amount: string;
  /** Optional override for the pay URL. */
  payUrl?: string;
  /** Optional override for the vendor's display name (e.g. an ENS name). */
  vendorName?: string;
  /** Wallet-signed auth (Phase 7-followup). When `STRICT_EMAIL_AUTH=1`,
   *  these become required and the endpoint rejects unsigned calls.
   *  During rollout the endpoint logs a warning and accepts unsigned
   *  requests, so existing UI keeps working. */
  signature?: `0x${string}`;
  signerAddress?: `0x${string}`;
  /** Unix-seconds timestamp included in the canonical signed message. */
  signedAt?: number;
  /** Chain id of the signer (matters for ERC-1271 contract sig verify). */
  signerChainId?: number;
}

interface InvoiceLookup {
  invoice_id: number;
  vendor_address: string;
  client_address: string;
  description: string;
  due_date: string | null;
  client_email: string | null;
  vendor_email: string | null;
  pdf_cid: string | null;
}

function getIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!;
  return req.socket?.remoteAddress ?? "unknown";
}

function isPlausibleEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = getIp(req);
  const rl = await checkRateLimit({ ip, key: "invoice-email", windowMs: 60_000, max: 10 });
  writeRateLimitHeaders(res, rl);
  if (!rl.ok) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  if (!emailEnabled()) {
    res.status(503).json({ error: "Email is not configured" });
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const body = req.body as SendInvoiceEmailBody;
  if (!body || typeof body.invoiceId !== "number") {
    res.status(400).json({ error: "invoiceId required" });
    return;
  }
  if (typeof body.amount !== "string" || body.amount.length === 0) {
    res.status(400).json({ error: "amount required" });
    return;
  }

  // Look up invoice.
  const { data, error } = await admin
    .from("invoices")
    .select(
      "invoice_id, vendor_address, client_address, description, due_date, client_email, vendor_email, pdf_cid",
    )
    .eq("invoice_id", body.invoiceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const invoice = data as InvoiceLookup;

  const recipient = body.recipientEmail ?? invoice.client_email ?? undefined;
  if (!isPlausibleEmail(recipient)) {
    res.status(400).json({
      error: "No recipient email — pass recipientEmail or set client_email on the invoice row.",
    });
    return;
  }

  // Wallet-signed auth check. When STRICT_EMAIL_AUTH=1, every request
  // MUST carry a fresh signature from the invoice's vendor. During
  // rollout we log + accept unsigned requests so existing UI keeps
  // working — flip to strict in production once the frontend integrates
  // the signing call.
  if (body.signature && body.signerAddress && body.signedAt !== undefined && body.signerChainId !== undefined) {
    const tsErr = checkTimestampWindow(body.signedAt);
    if (tsErr) {
      res.status(401).json({ error: `signature rejected: ${tsErr}` });
      return;
    }
    if (body.signerAddress.toLowerCase() !== invoice.vendor_address.toLowerCase()) {
      res.status(403).json({ error: "signer is not the invoice vendor" });
      return;
    }
    const message = buildInvoiceEmailMessage({
      invoiceId: invoice.invoice_id,
      recipient,
      signedAt: body.signedAt,
      chainId: body.signerChainId,
    });
    const verified = await verifyOwnerSignature({
      chainId: body.signerChainId,
      signer: body.signerAddress,
      message,
      signature: body.signature,
    });
    if (!verified.ok) {
      res.status(401).json({ error: `signature verify failed: ${verified.reason ?? "unknown"}` });
      return;
    }
  } else if (strictEmailAuthEnabled()) {
    res.status(401).json({
      error: "missing wallet signature (signature, signerAddress, signedAt, signerChainId required)",
    });
    return;
  } else {
    // Soft mode: log so we can audit which clients still send unsigned
    // requests during rollout. Once all callers sign, flip
    // STRICT_EMAIL_AUTH=1 in env to reject anything unsigned.
    console.warn(
      `[invoices/send-email] unsigned request accepted (STRICT_EMAIL_AUTH off) for invoice=${invoice.invoice_id} vendor=${invoice.vendor_address}`,
    );
  }

  // Fetch PDF (best effort) so we can attach it.
  let attachment: { filename: string; content: string; contentType: string } | undefined;
  if (invoice.pdf_cid) {
    try {
      const pdfRes = await fetch(ipfsUrl(invoice.pdf_cid));
      if (pdfRes.ok) {
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        attachment = {
          filename: `INV-${invoice.invoice_id.toString().padStart(4, "0")}.pdf`,
          content: buf.toString("base64"),
          contentType: "application/pdf",
        };
      }
    } catch (err) {
      console.warn("send-email: PDF fetch failed", err);
    }
  }

  // Build the email.
  const origin = req.headers?.origin || process.env.PUBLIC_APP_URL || "https://blank.app";
  const payUrl =
    body.payUrl ??
    `${origin}/pay/INV-${invoice.invoice_id}?amount=${encodeURIComponent(body.amount)}`;
  const vendorName =
    body.vendorName ?? invoice.vendor_address.slice(0, 6) + "…" + invoice.vendor_address.slice(-4);

  const tpl = renderInvoiceEmail({
    invoiceId: invoice.invoice_id,
    vendorName,
    amount: body.amount,
    currency: "USDC",
    description: invoice.description,
    dueDate: invoice.due_date,
    payUrl,
  });

  try {
    const result = await sendEmail({
      to: recipient,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      replyTo: invoice.vendor_email ?? undefined,
      attachments: attachment ? [attachment] : undefined,
      idempotencyKey: `invoice:${invoice.invoice_id}:${recipient}`,
    });
    res.status(200).json({ ok: true, messageId: result.id });
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
