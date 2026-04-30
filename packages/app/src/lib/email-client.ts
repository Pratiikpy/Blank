// Frontend wrappers around the /api/invoices/send-email and
// /api/requests/send-email endpoints. Keeps fetch boilerplate out of UI
// components and gives a typed surface for the Phase 1.3 wiring.
//
// Phase 7 follow-up: optional wallet-signed auth fields. When the
// caller signs the canonical message (built via the helpers below),
// the API verifies it against the row's owner. When STRICT_EMAIL_AUTH=1
// is set in the server env, the API rejects unsigned calls with 401.

interface WalletSigFields {
  signature?: `0x${string}`;
  signerAddress?: `0x${string}`;
  signedAt?: number;
  signerChainId?: number;
}

interface SendInvoiceEmailArgs extends WalletSigFields {
  invoiceId: number;
  /** Recipient email — falls back to the row's `client_email` if omitted. */
  recipientEmail?: string;
  /** Plaintext amount displayed in the email (the on-chain amount stays encrypted). */
  amount: string;
  /** Optional override for the pay URL — defaults to /pay/INV-<id>. */
  payUrl?: string;
  /** Optional ENS / display name for the vendor. */
  vendorName?: string;
}

interface SendRequestEmailArgs extends WalletSigFields {
  requestId: number;
  /** Recipient email — falls back to the row's `payer_email` if omitted. */
  payerEmail?: string;
  requesterName?: string;
  reviewUrl?: string;
}

/**
 * Build the canonical message string the invoice-email endpoint expects.
 * Mirrors `api/_lib/sig-auth.ts:buildInvoiceEmailMessage`. Keeping the
 * builder here avoids a relative import from /api/_lib into /src.
 */
export function buildInvoiceEmailSignableMessage(args: {
  invoiceId: number;
  recipient: string;
  signedAt: number;
  chainId: number;
}): string {
  return [
    "Blank: send invoice email",
    `invoiceId: ${args.invoiceId}`,
    `recipient: ${args.recipient.toLowerCase()}`,
    `chainId: ${args.chainId}`,
    `signedAt: ${args.signedAt}`,
  ].join("\n");
}

export function buildRequestEmailSignableMessage(args: {
  requestId: number;
  recipient: string;
  signedAt: number;
  chainId: number;
}): string {
  return [
    "Blank: send payment-request email",
    `requestId: ${args.requestId}`,
    `recipient: ${args.recipient.toLowerCase()}`,
    `chainId: ${args.chainId}`,
    `signedAt: ${args.signedAt}`,
  ].join("\n");
}

interface EmailSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

async function postJson(url: string, body: unknown): Promise<EmailSendResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { messageId?: string; error?: string };
    if (!res.ok) {
      return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: json.messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function sendInvoiceEmail(args: SendInvoiceEmailArgs): Promise<EmailSendResult> {
  return postJson("/api/invoices/send-email", args);
}

export function sendPaymentRequestEmail(args: SendRequestEmailArgs): Promise<EmailSendResult> {
  return postJson("/api/requests/send-email", args);
}
