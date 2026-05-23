-- Wave 5 Block 5 — notifications + push subscriptions.
--
-- One row per notification event; one row per browser push subscription.
-- See WAVE5_PLAN.md §5.3 for the schema rationale + idempotency rule.

-- 1. Web-push subscription registry. One row per (handle, endpoint).
create table if not exists push_subscriptions (
    id         uuid primary key default gen_random_uuid(),
    handle     text not null,
    chain_id   int  not null,
    endpoint   text not null unique,
    p256dh     text not null,
    auth       text not null,
    created_at timestamptz not null default now()
);
create index if not exists push_subs_handle on push_subscriptions(handle);
create index if not exists push_subs_chain  on push_subscriptions(chain_id);

-- 2. Notification ledger. Idempotency by event_id (deterministic hash
-- of tx_hash + log_index + event_type + handle). Re-emitting the
-- same chain event lands the same row (insert ... on conflict do nothing).
create table if not exists notifications (
    id          uuid primary key default gen_random_uuid(),
    event_id    text not null unique,
    handle      text not null,
    event_type  text not null,
    payload     jsonb not null,
    read        boolean not null default false,
    delivered_push  boolean not null default false,
    delivered_email boolean not null default false,
    created_at  timestamptz not null default now()
);
create index if not exists notif_handle_unread
    on notifications(handle, read);
create index if not exists notif_handle_created
    on notifications(handle, created_at desc);
