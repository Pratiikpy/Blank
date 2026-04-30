/**
 * Internal Resend wrapper for transactional email.
 *
 * NOT exposed as its own public endpoint — Phase 1 routes (invoices, payment
 * requests, reminders) import `sendEmail` directly. That keeps spam/abuse
 * surface narrow: every caller is server-side and authenticates the user
 * before triggering an email.
 *
 * Resend REST API:
 *   POST https://api.resend.com/emails
 *   Auth: Bearer RESEND_API_KEY
 *   Body: { from, to, subject, html, text?, reply_to?, attachments?[] }
 *   Response: { id }
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

const RESEND_BASE_URL = "https://api.resend.com";

export interface EmailAttachment {
  /** Display filename (e.g. "invoice-0042.pdf"). */
  filename: string;
  /** Base64-encoded contents. */
  content: string;
  /** MIME type, e.g. "application/pdf". */
  contentType?: string;
}

export interface SendEmailArgs {
  /** Recipient address. Plain string or `Name <addr@example.com>`. */
  to: string | string[];
  /** Subject line — keep it under 78 chars to avoid client wrapping. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Optional plaintext fallback (auto-generated if omitted). */
  text?: string;
  /** Override default From; otherwise uses EMAIL_FROM env var. */
  from?: string;
  /** Reply-To, defaults to EMAIL_FROM. */
  replyTo?: string;
  /** Attachments (e.g. invoice PDFs). */
  attachments?: EmailAttachment[];
  /** Idempotency key — Resend de-dupes if same key is reused within ~30 days. */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  /** Resend message ID. */
  id: string;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Resend not configured: RESEND_API_KEY (and EMAIL_FROM) env vars missing.");
    this.name = "EmailNotConfiguredError";
  }
}

function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

export function emailEnabled(): boolean {
  return isEmailConfigured();
}

/**
 * Send a single transactional email through Resend.
 *
 * Throws `EmailNotConfiguredError` if env vars are missing — callers should
 * handle gracefully (e.g. return a 503 from their endpoint, or skip the
 * email step but still complete the on-chain action).
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  if (!isEmailConfigured()) {
    throw new EmailNotConfiguredError();
  }
  const apiKey = process.env.RESEND_API_KEY!;
  const defaultFrom = process.env.EMAIL_FROM!;
  const from = args.from ?? defaultFrom;

  const body: Record<string, unknown> = {
    from,
    to: Array.isArray(args.to) ? args.to : [args.to],
    subject: args.subject,
    html: args.html,
  };
  if (args.text) body.text = args.text;
  if (args.replyTo ?? defaultFrom) body.reply_to = args.replyTo ?? defaultFrom;
  if (args.attachments && args.attachments.length > 0) {
    body.attachments = args.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      content_type: a.contentType,
    }));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (args.idempotencyKey) {
    headers["Idempotency-Key"] = args.idempotencyKey;
  }

  const res = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { id: string };
  return { id: data.id };
}
