/**
 * /api/push/notify
 *
 * Internal endpoint called by Supabase Database Webhooks (or our own server
 * code) to fan a notification out to all subscriptions for one or more
 * addresses.
 *
 * Auth: requires `Authorization: Bearer <PUSH_NOTIFY_SECRET>`. Without this
 * header anyone could spam our users.
 *
 * Body shape:
 *   {
 *     "addresses": ["0xabc…"],          // who to notify
 *     "payload": {
 *       "title": "Acme paid your invoice",
 *       "body":  "$3,700 received",
 *       "url":   "/app/history",
 *       "tag":   "activity:0xtxhash"
 *     }
 *   }
 *
 * For each subscription that returns 404/410 (dead browser), the row is
 * deleted from Supabase so the table doesn't grow unbounded.
 */

import { getSupabaseAdmin } from "../_lib/supabase-admin.js";
import { sendPush, webPushConfigured, type PushPayload } from "../_lib/web-push.js";

interface NotifyBody {
  addresses: string[];
  payload: PushPayload;
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = process.env.PUSH_NOTIFY_SECRET;
  if (!secret) {
    res.status(503).json({ error: "PUSH_NOTIFY_SECRET not configured" });
    return;
  }
  const authHeader = req.headers?.authorization ?? "";
  const expected = `Bearer ${secret}`;
  if (authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!webPushConfigured()) {
    res.status(503).json({ error: "Web Push not configured (VAPID keys missing)" });
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const body = req.body as NotifyBody;
  if (!body || !Array.isArray(body.addresses) || !body.payload) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const normalized = body.addresses
    .filter(isHexAddress)
    .map((a) => a.toLowerCase());
  if (normalized.length === 0) {
    res.status(400).json({ error: "addresses must contain at least one valid 0x address" });
    return;
  }
  if (
    typeof body.payload.title !== "string" ||
    typeof body.payload.body !== "string"
  ) {
    res.status(400).json({ error: "payload.title and payload.body required" });
    return;
  }

  // Look up all subscriptions for the target addresses.
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("address", normalized);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const subs = (data ?? []) as SubRow[];
  if (subs.length === 0) {
    res.status(200).json({ ok: true, sent: 0, pruned: 0 });
    return;
  }

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      const result = await sendPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body.payload,
      );
      if (result.ok) sent++;
      else if (result.gone) dead.push(s.endpoint);
    }),
  );

  // Prune dead subscriptions so we don't keep retrying them.
  if (dead.length > 0) {
    await admin.from("push_subscriptions").delete().in("endpoint", dead);
  }

  res.status(200).json({ ok: true, sent, pruned: dead.length });
}
