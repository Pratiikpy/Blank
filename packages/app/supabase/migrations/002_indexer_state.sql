-- ═══════════════════════════════════════════════════════════════════
--  002_indexer_state — per-(address, chainId) cursor for /api/reconcile-user
--
--  The reconciliation endpoint scans recent chain logs to back-fill any
--  activity rows the frontend failed to insert (tx confirmed but Supabase
--  insert crashed). We persist the highest block seen per user+chain so
--  subsequent calls can resume from where we left off instead of always
--  re-scanning the last ~10k blocks.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists indexer_state (
  address text not null,
  chain_id bigint not null,
  last_block bigint not null default 0,
  updated_at timestamptz default now(),
  primary key (address, chain_id)
);

alter table indexer_state enable row level security;

-- service role only — no anon/auth RLS policy. The reconcile endpoint uses
-- the service_role key via getSupabaseAdmin(), which bypasses RLS. Clients
-- with the anon key have zero read/write access.
create policy "service role manages indexer_state" on indexer_state
  for all using (true) with check (true);
