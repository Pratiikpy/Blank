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
 * No auth required — the worst an attacker can do is register their own
 * browser to receive notifications meant for an address they don't own
 * (which is harmless because no decrypted payload is included), but we
 * rate-limit per IP to prevent flood.
 *
 * Schema: see sql/push_subscriptions.sql
 */

import { getSupabaseAdmin } from "../_lib/supabase-admin";
import { checkRateLimit, writeRateLimitHeaders } from "../_lib/rate-limit";

interface SubscribeBody {
  address: string;
  chainId?: number;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
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
