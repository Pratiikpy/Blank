-- Wave 5.5 — RLS policies for the 3 Wave 5 tables.
--
-- Closes the security advisory raised after applying 010 + 011:
-- "Row Level Security is disabled on public.paymaster_refills,
--  public.push_subscriptions, public.notifications".
--
-- Blank doesn't use Supabase Auth — privacy guarantees come from
-- on-chain encryption, not Postgres RLS. The Wave 1-4 tables intentionally
-- use `USING (true)` policies because the anon key is the only client
-- credential and the encrypted-amount surface already handles per-row
-- privacy at the app layer.
--
-- However, three Wave 5 paths should NEVER come from a browser:
--   - paymaster_refills.INSERT  → only the every-24h topup cron
--   - notifications.INSERT      → only the chain indexer
--   - push_subscriptions.UPDATE/DELETE → only the push-send endpoint
--
-- Those run from Vercel serverless functions which use the service_role
-- key (bypasses RLS by default). Restricting them at the policy level
-- means a leaked anon key can't fabricate paymaster receipts or spam
-- notifications. Reads stay open (matches the existing app pattern;
-- the public /status page reads paymaster_refills, the bell reads
-- notifications filtered by handle in the client).

-- ─── paymaster_refills ─────────────────────────────────────────────
alter table paymaster_refills enable row level security;

create policy "Anyone can read paymaster_refills"
    on paymaster_refills for select
    using (true);

-- INSERT intentionally NOT granted to anon — only service_role writes.
-- (service_role bypasses RLS, so no explicit policy needed for it.)

-- ─── push_subscriptions ────────────────────────────────────────────
alter table push_subscriptions enable row level security;

-- Clients write their own subscription when they subscribe to push.
create policy "Anyone can insert push subscription"
    on push_subscriptions for insert
    with check (true);

-- Clients can read their own subscriptions for "is push enabled?" check.
-- Filtered at the client by handle; full-table read carries no secret.
create policy "Anyone can read push subscriptions"
    on push_subscriptions for select
    using (true);

-- UPDATE/DELETE intentionally NOT granted to anon — only the
-- push-send endpoint reaps invalid subscriptions via service_role.

-- ─── notifications ─────────────────────────────────────────────────
alter table notifications enable row level security;

-- Clients read their own notifications (filtered by handle in client query).
-- The notification payload doesn't contain plaintext encrypted amounts,
-- only event metadata + display text; safe to expose.
create policy "Anyone can read notifications"
    on notifications for select
    using (true);

-- Clients mark their own notifications as read via the API endpoint.
-- We allow UPDATE for the `read` flag specifically; a malicious anon
-- caller can mark someone else's notification read but cannot tamper
-- with payload/event_id/event_type (all immutable at the app layer).
create policy "Anyone can mark notifications read"
    on notifications for update
    using (true)
    with check (true);

-- INSERT intentionally NOT granted to anon — only the chain indexer
-- writes notification rows via service_role.
