/**
 * Shared rate limiter — Vercel KV when available, in-memory fallback.
 *
 * Usage:
 *   const res = await checkRateLimit({ ip, key: "relay", windowMs: 60_000, max: 10 });
 *   if (!res.ok) return res.error(req_res); // returns 429 with headers
 *
 * KV key shape: `rl:<key>:<ip>` -> JSON array of epoch-ms timestamps.
 *
 * When KV env vars are missing (local dev, preview without KV), we fall
 * back to a module-level Map. That loses correctness across cold starts
 * but is better than hard-requiring KV in every environment.
 */

const memCache = new Map<string, number[]>();

interface RateLimitArgs {
  ip: string;
  key: string;
  windowMs: number;
  max: number;
}

interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key: string): Promise<number[] | null> {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const raw = body?.result;
    if (!raw) return [];
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}

async function kvSet(key: string, value: number[], ttlSeconds: number): Promise<boolean> {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?EX=${ttlSeconds}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkRateLimit(args: RateLimitArgs): Promise<RateLimitResult> {
  const storeKey = `rl:${args.key}:${args.ip}`;
  const now = Date.now();
  const cutoff = now - args.windowMs;

  const useKv = !!KV_URL && !!KV_TOKEN;
  let calls: number[];

  if (useKv) {
    calls = (await kvGet(storeKey)) ?? [];
  } else {
    calls = memCache.get(storeKey) ?? [];
  }

  // Drop expired
  calls = calls.filter((t) => t > cutoff);

  const ok = calls.length < args.max;
  if (ok) calls.push(now);

  if (useKv) {
    await kvSet(storeKey, calls, Math.ceil(args.windowMs / 1000));
  } else {
    memCache.set(storeKey, calls);
  }

  const resetSeconds = calls.length > 0 ? Math.ceil((calls[0] + args.windowMs - now) / 1000) : 0;

  return {
    ok,
    remaining: Math.max(0, args.max - calls.length),
    resetSeconds,
  };
}

export function writeRateLimitHeaders(res: any, result: RateLimitResult) {
  res.setHeader?.("RateLimit-Remaining", String(result.remaining));
  res.setHeader?.("RateLimit-Reset", String(result.resetSeconds));
}
