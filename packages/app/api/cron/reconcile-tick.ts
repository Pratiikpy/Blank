/**
 * /api/cron/reconcile-tick — Vercel Cron entrypoint
 *
 * Runs every 10 minutes. Pulls the last N active addresses from Supabase,
 * calls the reconcile logic for each per supported chain. Catches up
 * activity rows that were lost due to frontend crashes.
 *
 * Vercel Cron auth: in production, requests carry a CRON_SECRET header.
 * Set CRON_SECRET in Vercel env + verify here so randos can't trigger
 * expensive reconciliation runs.
 */

import { getSupabaseAdmin } from "../_lib/supabase-admin";

const SUPPORTED_CHAIN_IDS = [11155111, 84532];
const ACTIVE_WINDOW_HOURS = 24;
const MAX_ADDRESSES_PER_TICK = 50;

export default async function handler(req: any, res: any) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const expected = process.env.CRON_SECRET;
  const provided = req.headers["authorization"];
  if (expected && provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(200).json({ status: "no-db", indexed: 0 });
    return;
  }

  // Find recently-active addresses (sender or receiver in last 24h)
  const since = new Date(Date.now() - ACTIVE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: rows } = await admin
    .from("activities")
    .select("user_from, user_to")
    .gt("created_at", since)
    .limit(MAX_ADDRESSES_PER_TICK * 4); // a few collisions expected

  const addrs = new Set<string>();
  for (const r of (rows ?? [])) {
    if (r.user_from && r.user_from !== "0x0000000000000000000000000000000000000000") addrs.add(r.user_from);
    if (r.user_to && r.user_to !== "0x0000000000000000000000000000000000000000") addrs.add(r.user_to);
    if (addrs.size >= MAX_ADDRESSES_PER_TICK) break;
  }

  // Reconcile each (address, chainId). Internally calls the same logic
  // as /api/reconcile-user. We hit our own endpoint to keep the impl
  // single-sourced.
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
  let totalIndexed = 0;
  for (const addr of addrs) {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      try {
        const r = await fetch(`${baseUrl}/api/reconcile-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr, chainId }),
        });
        if (r.ok) {
          const body = await r.json();
          totalIndexed += (body?.indexed ?? 0);
        }
      } catch {
        // continue — one bad reconcile shouldn't kill the tick
      }
    }
  }

  res.status(200).json({
    status: "ok",
    addresses: addrs.size,
    chainsPerAddress: SUPPORTED_CHAIN_IDS.length,
    totalIndexed,
  });
}
