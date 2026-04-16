-- ═══════════════════════════════════════════════════════════════════
--  003_chain_id_all_tables — add chain_id to every multi-tenant table
--
--  Before this migration, only `activities` and `indexer_state` carried
--  chain_id. Every other table (payment_requests, group_*, invoices,
--  escrows, exchange_offers, creator_*, contacts) pooled rows across
--  chains, so a user who switched networks saw polluted results
--  (Sepolia requests leaking into Base mainnet, etc.).
--
--  Strategy:
--   1. Add chain_id column with a default of Ethereum Sepolia (11155111)
--      so existing rows keep working under the chain they were written on.
--   2. Add a btree index on chain_id for the fetch-by-address paths that
--      now include `.eq("chain_id", ...)` filters.
--   3. Writers after this migration must set chain_id explicitly via
--      `_activeChainIdForSupabase` (tracked by setSupabaseActiveChain()
--      in packages/app/src/lib/supabase.ts) or a direct column value.
-- ═══════════════════════════════════════════════════════════════════

-- Add chain_id to all tables that currently lack it so cross-chain users
-- don't see polluted results after a chain switch.

alter table payment_requests     add column if not exists chain_id bigint default 11155111;
alter table group_memberships    add column if not exists chain_id bigint default 11155111;
alter table group_expenses       add column if not exists chain_id bigint default 11155111;
alter table creator_profiles     add column if not exists chain_id bigint default 11155111;
alter table creator_supporters   add column if not exists chain_id bigint default 11155111;
alter table invoices             add column if not exists chain_id bigint default 11155111;
alter table escrows              add column if not exists chain_id bigint default 11155111;
alter table exchange_offers      add column if not exists chain_id bigint default 11155111;
alter table contacts             add column if not exists chain_id bigint default 11155111;

create index if not exists idx_payment_requests_chain    on payment_requests(chain_id);
create index if not exists idx_group_memberships_chain   on group_memberships(chain_id);
create index if not exists idx_group_expenses_chain      on group_expenses(chain_id);
create index if not exists idx_invoices_chain            on invoices(chain_id);
create index if not exists idx_escrows_chain             on escrows(chain_id);
create index if not exists idx_exchange_offers_chain     on exchange_offers(chain_id);

-- existing rows default to Eth Sepolia (11155111); writers after this
-- migration must explicitly set chain_id via setSupabaseActiveChain() or
-- a direct column value.
