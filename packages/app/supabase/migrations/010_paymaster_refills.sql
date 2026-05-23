-- Paymaster auto-refill rate-limit counter.
--
-- Wave 5 Block 0.3 ships an every-6h cron that tops up
-- BlankPaymaster's EntryPoint deposit from a dedicated
-- topup-only signer. Daily rate cap (default 2 ETH per chain
-- per UTC day) is enforced by summing rows in this table for
-- the current chain + day.
--
-- One row per successful refill tx. Failed refills are not
-- recorded so the cap allows a retry on the next tick.

create table if not exists paymaster_refills (
    id         bigserial primary key,
    chain_id   int      not null,
    utc_day    text     not null,
    amount_wei text     not null,
    tx_hash    text     not null,
    created_at timestamptz not null default now()
);

create index if not exists paymaster_refills_chain_day
    on paymaster_refills (chain_id, utc_day);

create unique index if not exists paymaster_refills_tx_hash
    on paymaster_refills (tx_hash);
