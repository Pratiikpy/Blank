/**
 * /api/push/subscribe
 *
 * POST  — store a browser push subscription against a wallet address
 * DELETE — remove a subscription by endpoint (during unsubscribe)
 *
 * The frontend calls this from `lib/push-notifications.ts` after the user
 * grants Notification permission. We persist to Supabase so /api/push/notify
 * can later look up subscriptions by address.
 *
 * Audit P2.11: requires a wallet-signed challenge so an attacker can't
 * register their browser as the recipient of notifications for someone
 * else's address (which would surface every counterparty + activity type
 * the victim sees — a deanonymization channel even without payload bodies).
 * The signature binds (address, chainId, signedAt) and is checked via the
 * shared `verifyOwnerSignature` helper that already handles EOA + ERC-1271.
 *
 * Schema: see sql/push_subscriptions.sql
 */

import { getSupabaseAdmin } from "../supabase-admin.js";
import { checkRateLimit, writeRateLimitHeaders } from "../rate-limit.js";
import {
  checkTimestampWindow,
  verifyOwnerSignature,
  strictEmailAuthEnabled,
} from "../sig-auth.js";
import type { Address, Hex } from "viem";

interface SubscribeBody {
  address: string;
  chainId?: number;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  /** Wallet signature over `pushSubscribeMessage(address, chainId, signedAt)`.
   *  Required when STRICT_EMAIL_AUTH defaults are on (production). */
  signature?: Hex;
  signedAt?: number;
  signerChainId?: number;
}

function buildPushSubscribeMessage(args: {
  address: string;
  chainId: number;
  signedAt: number;
}): string {
  return [
    "Blank: register push subscription",
    `address: ${args.address.toLowerCase()}`,
    `chainId: ${args.chainId}`,
    `signedAt: ${args.signedAt}`,
  ].join("\n");
}

interface UnsubscribeBody {
  endpoint: string;
}

function getIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!;
  return req.socket?.remoteAddress ?? "unknown";
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = getIp(req);
  const rl = await checkRateLimit({ ip, key: "push-subscribe", windowMs: 60_000, max: 30 });
  writeRateLimitHeaders(res, rl);
  if (!rl.ok) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  try {
    if (req.method === "POST") {
      const body = req.body as SubscribeBody;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "Invalid body" });
        return;
      }
      if (!isHexAddress(body.address)) {
        res.status(400).json({ error: "Invalid address" });
        return;
      }
      const sub = body.subscription;
      if (
        !sub ||
        typeof sub.endpoint !== "string" ||
        typeof sub.keys?.p256dh !== "string" ||
        typeof sub.keys?.auth !== "string"
      ) {
        res.status(400).json({ error: "Invalid subscription payload" });
        return;
      }

      // Audit P2.11: require a wallet-signed challenge so the registrant
      // proves they own `body.address`. Default fail-closed; opt out only
      // for local dev with STRICT_EMAIL_AUTH=0 (the same flag gates email
      // signature verification — same threat model: prevent unauthorized
      // address registration).
      if (strictEmailAuthEnabled()) {
        const signedAt = body.signedAt;
        const signature = body.signature;
        const signerChainId = body.signerChainId ?? body.chainId;
        if (typeof signedAt !== "number" || !signature || !signerChainId) {
          res.status(401).json({
            error:
              "push-subscribe requires a wallet signature: signature, signedAt, signerChainId",
          });
          return;
        }
        const tsErr = checkTimestampWindow(signedAt);
        if (tsErr) {
          res.status(401).json({ error: tsErr });
          return;
        }
        const message = buildPushSubscribeMessage({
          address: body.address,
          chainId: signerChainId,
          signedAt,
        });
        const verify = await verifyOwnerSignature({
          chainId: signerChainId,
          signer: body.address as Address,
          message,
          signature,
        });
        if (!verify.ok) {
          res.status(401).json({
            error: `signature verification failed: ${verify.reason ?? "unknown"}`,
          });
          return;
        }
      }

      const { error } = await admin
        .from("push_subscriptions")
        .upsert(
          {
            address: body.address.toLowerCase(),
            chain_id: body.chainId ?? null,
            endpoint: sub.endpoint,
            p256dh: sub.keys.p256dh,
            auth: sub.keys.auth,
            user_agent: req.headers?.["user-agent"]?.slice(0, 256) ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "endpoint" },
        );

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // DELETE
    const body = req.body as UnsubscribeBody;
    if (!body || typeof body.endpoint !== "string") {
      res.status(400).json({ error: "endpoint required" });
      return;
    }
    const { error } = await admin
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", body.endpoint);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
