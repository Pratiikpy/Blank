/**
 * /api/requests/send-email
 *
 * Send a payment-request email to the payer. Mirror of the invoice
 * variant, lighter shape: no PDF attachment, deep link to /app/requests
 * for review.
 *
 * Body: { requestId: number, payerEmail?: string, requesterName?: string, reviewUrl?: string }
 *
 * Returns: { ok: true, messageId } | { ok: false, error }
 */

import { getSupabaseAdmin } from "../_lib/supabase-admin.js";
import { checkRateLimit, writeRateLimitHeaders } from "../_lib/rate-limit.js";
import { sendEmail, emailEnabled, EmailNotConfiguredError } from "../_lib/resend.js";
import { renderPaymentRequestEmail } from "../_lib/email-templates.js";
import {
  buildRequestEmailMessage,
  checkTimestampWindow,
  strictEmailAuthEnabled,
  verifyOwnerSignature,
} from "../_lib/sig-auth.js";

interface SendRequestEmailBody {
  requestId: number;
  payerEmail?: string;
  requesterName?: string;
  reviewUrl?: string;
  /** Wallet-signed auth — see api/_lib/sig-auth.ts. The signer must
   *  match the request's `from_address` (the requester who authored
   *  the row). Soft mode logs a warning and accepts unsigned. Strict
   *  mode (`STRICT_EMAIL_AUTH=1`) rejects with 401. */
  signature?: `0x${string}`;
  signerAddress?: `0x${string}`;
  signedAt?: number;
  signerChainId?: number;
}

interface RequestLookup {
  request_id: number;
  to_address: string;
  from_address: string;
  note: string;
  payer_email: string | null;
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

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = getIp(req);
  const rl = await checkRateLimit({ ip, key: "request-email", windowMs: 60_000, max: 10 });
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

  const body = req.body as SendRequestEmailBody;
  if (!body || typeof body.requestId !== "number") {
    res.status(400).json({ error: "requestId required" });
    return;
  }

  const { data, error } = await admin
    .from("payment_requests")
    .select("request_id, to_address, from_address, note, payer_email")
    .eq("request_id", body.requestId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Payment request not found" });
    return;
  }
  const request = data as RequestLookup;

  const recipient = body.payerEmail ?? request.payer_email ?? undefined;
  if (!isPlausibleEmail(recipient)) {
    res.status(400).json({
      error: "No payer email — pass payerEmail or set payer_email on the request row.",
    });
    return;
  }

  // Wallet-signed auth — signer must match the request's `to_address`
  // (the requester who authored the row; per Supabase schema:
  //   from_address = PAYER (being asked to pay)
  //   to_address   = REQUESTER (current user who created the row)
  // ). Mirror of the invoice variant.
  if (body.signature && body.signerAddress && body.signedAt !== undefined && body.signerChainId !== undefined) {
    const tsErr = checkTimestampWindow(body.signedAt);
    if (tsErr) {
      res.status(401).json({ error: `signature rejected: ${tsErr}` });
      return;
    }
    if (body.signerAddress.toLowerCase() !== request.to_address.toLowerCase()) {
      res.status(403).json({ error: "signer is not the request's requester" });
      return;
    }
    const message = buildRequestEmailMessage({
      requestId: request.request_id,
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
    console.warn(
      `[requests/send-email] unsigned request accepted (STRICT_EMAIL_AUTH off) for request=${request.request_id} requester=${request.from_address}`,
    );
  }

  const origin = req.headers?.origin || process.env.PUBLIC_APP_URL || "https://blank.app";
  const reviewUrl = body.reviewUrl ?? `${origin}/app/requests`;
  const requesterName = body.requesterName ?? shortAddress(request.to_address);

  const tpl = renderPaymentRequestEmail({
    requestId: request.request_id,
    requesterName,
    note: request.note ?? "",
    reviewUrl,
  });

  try {
    const result = await sendEmail({
      to: recipient,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `request:${request.request_id}:${recipient}`,
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
