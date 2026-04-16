/**
 * Server-only Supabase client using the service_role key.
 *
 * This client BYPASSES RLS and is the only way back-fill inserts can land
 * when the frontend's anon-key session is absent (which is exactly what we
 * need for /api/reconcile-user — the caller has no Supabase session, only a
 * wallet address).
 *
 * NEVER import this from frontend code — the service role key must never
 * ship to the browser. The .env.example entry for SUPABASE_SERVICE_ROLE_KEY
 * has no VITE_ prefix, so Vite can't leak it even if a frontend file tries.
 *
 * Returns null when env vars are missing so callers can degrade gracefully
 * (endpoints become no-ops rather than crashing).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (_admin) return _admin;
  if (!URL || !SERVICE_KEY) return null;
  _admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  return _admin;
}
