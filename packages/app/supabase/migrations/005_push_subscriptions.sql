-- push_subscriptions — Web Push subscription registry.
--
-- One row per (browser endpoint). A single user/address can have many rows
-- (phone + laptop + tablet). Removed when the user unsubscribes locally OR
-- when /api/push/notify gets a 404/410 from the push service (subscription
-- expired).
--
-- Run from the Supabase SQL editor or via supabase migrations.

create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  address     text not null,
  chain_id    integer,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_address_idx
  on public.push_subscriptions (address);

-- RLS: this table is only accessed via the service-role key (server-side
-- /api/push/* endpoints), so we leave RLS enabled with no policies — that
-- means the anon key cannot read or write it. The service-role key bypasses
-- RLS by design.
alter table public.push_subscriptions enable row level security;
