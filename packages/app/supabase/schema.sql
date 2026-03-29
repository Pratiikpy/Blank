-- ═══════════════════════════════════════════════════════════════════
--  GhostPay — Supabase Schema
--  Notification & indexing layer. Source of truth is ALWAYS blockchain.
--  NEVER store encrypted amounts here — only public context.
-- ═══════════════════════════════════════════════════════════════════

-- ─── Activity Feed ──────────────────────────────────────────────────
-- Written by frontend after each successful on-chain tx.
-- Supabase Realtime pushes to recipient instantly.

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  tx_hash text not null,
  user_from text not null,
  user_to text not null,
  activity_type text not null,
  contract_address text not null default '',
  note text default '',
  token_address text default '',
  block_number bigint default 0,
  created_at timestamptz default now()
);

create index if not exists idx_activities_user_to on activities(user_to);
create index if not exists idx_activities_user_from on activities(user_from);
create index if not exists idx_activities_created on activities(created_at desc);
create unique index if not exists idx_activities_tx_hash on activities(tx_hash);

-- ─── Payment Requests ───────────────────────────────────────────────
-- So recipients know someone requested money without polling chain.

create table if not exists payment_requests (
  id uuid primary key default gen_random_uuid(),
  request_id bigint not null default 0,
  from_address text not null,
  to_address text not null,
  token_address text not null default '',
  note text default '',
  status text not null default 'pending',
  tx_hash text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_requests_from on payment_requests(from_address);
create index if not exists idx_requests_to on payment_requests(to_address);
create index if not exists idx_requests_status on payment_requests(status);

-- ─── Group Memberships ──────────────────────────────────────────────
-- So users can discover groups they belong to without scanning chain.

create table if not exists group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null,
  group_name text not null default '',
  member_address text not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_groups_member on group_memberships(member_address);
create unique index if not exists idx_groups_unique on group_memberships(group_id, member_address);

-- ─── Group Expenses (metadata only) ────────────────────────────────
-- Description and payer are public. Amounts are encrypted on-chain.

create table if not exists group_expenses (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null,
  expense_id bigint not null,
  payer_address text not null,
  description text not null default '',
  member_count integer not null default 0,
  tx_hash text default '',
  created_at timestamptz default now()
);

create index if not exists idx_expenses_group on group_expenses(group_id);

-- ─── Creator Profiles ───────────────────────────────────────────────
-- Public profile data for discovery. On-chain is source of truth.

create table if not exists creator_profiles (
  address text primary key,
  name text not null,
  bio text default '',
  avatar_url text default '',
  tier1_threshold bigint default 0,
  tier2_threshold bigint default 0,
  tier3_threshold bigint default 0,
  supporter_count integer default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── Creator Supporters (public membership, not amounts) ────────────

create table if not exists creator_supporters (
  id uuid primary key default gen_random_uuid(),
  creator_address text not null,
  supporter_address text not null,
  message text default '',
  created_at timestamptz default now()
);

create index if not exists idx_supporters_creator on creator_supporters(creator_address);
create index if not exists idx_supporters_supporter on creator_supporters(supporter_address);
create unique index if not exists idx_supporters_unique on creator_supporters(creator_address, supporter_address);

-- ─── Invoices (metadata only) ───────────────────────────────────────

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_id bigint not null default 0,
  vendor_address text not null,
  client_address text not null,
  description text not null default '',
  due_date timestamptz,
  status text not null default 'pending',
  tx_hash text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_invoices_vendor on invoices(vendor_address);
create index if not exists idx_invoices_client on invoices(client_address);
create index if not exists idx_invoices_status on invoices(status);

-- ─── Escrows (metadata only) ────────────────────────────────────────

create table if not exists escrows (
  id uuid primary key default gen_random_uuid(),
  escrow_id bigint not null default 0,
  depositor_address text not null,
  beneficiary_address text not null,
  arbiter_address text default '',
  description text not null default '',
  deadline timestamptz,
  status text not null default 'active',
  tx_hash text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_escrows_depositor on escrows(depositor_address);
create index if not exists idx_escrows_beneficiary on escrows(beneficiary_address);

-- ─── P2P Exchange Offers (public order book) ────────────────────────

create table if not exists exchange_offers (
  id uuid primary key default gen_random_uuid(),
  offer_id bigint not null default 0,
  maker_address text not null,
  token_give text not null,
  token_want text not null,
  amount_give bigint not null default 0,
  amount_want bigint not null default 0,
  expiry timestamptz,
  status text not null default 'active',
  taker_address text default '',
  tx_hash text default '',
  created_at timestamptz default now()
);

create index if not exists idx_offers_status on exchange_offers(status);
create index if not exists idx_offers_maker on exchange_offers(maker_address);

-- ─── Contacts (synced across devices via Supabase) ──────────────────

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  owner_address text not null,
  contact_address text not null,
  nickname text not null default '',
  created_at timestamptz default now()
);

create index if not exists idx_contacts_owner on contacts(owner_address);
create unique index if not exists idx_contacts_unique on contacts(owner_address, contact_address);

-- ═══════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════

-- Activities: anyone can read (public context) and insert (after tx)
alter table activities enable row level security;
create policy "Anyone can read activities" on activities for select using (true);
create policy "Anyone can insert activities" on activities for insert with check (true);

-- Payment requests: anyone can read/insert (testnet permissive)
alter table payment_requests enable row level security;
create policy "Anyone can read requests" on payment_requests for select using (true);
create policy "Anyone can insert requests" on payment_requests for insert with check (true);
create policy "Anyone can update requests" on payment_requests for update using (true);

-- Groups: anyone can read/insert
alter table group_memberships enable row level security;
create policy "Anyone can read groups" on group_memberships for select using (true);
create policy "Anyone can insert groups" on group_memberships for insert with check (true);

alter table group_expenses enable row level security;
create policy "Anyone can read expenses" on group_expenses for select using (true);
create policy "Anyone can insert expenses" on group_expenses for insert with check (true);

-- Creators: public read, anyone can insert
alter table creator_profiles enable row level security;
create policy "Anyone can read profiles" on creator_profiles for select using (true);
create policy "Anyone can upsert profiles" on creator_profiles for insert with check (true);
create policy "Anyone can update profiles" on creator_profiles for update using (true);

alter table creator_supporters enable row level security;
create policy "Anyone can read supporters" on creator_supporters for select using (true);
create policy "Anyone can insert supporters" on creator_supporters for insert with check (true);

-- Invoices: anyone can read/insert
alter table invoices enable row level security;
create policy "Anyone can read invoices" on invoices for select using (true);
create policy "Anyone can insert invoices" on invoices for insert with check (true);
create policy "Anyone can update invoices" on invoices for update using (true);

-- Escrows
alter table escrows enable row level security;
create policy "Anyone can read escrows" on escrows for select using (true);
create policy "Anyone can insert escrows" on escrows for insert with check (true);
create policy "Anyone can update escrows" on escrows for update using (true);

-- Exchange offers
alter table exchange_offers enable row level security;
create policy "Anyone can read offers" on exchange_offers for select using (true);
create policy "Anyone can insert offers" on exchange_offers for insert with check (true);
create policy "Anyone can update offers" on exchange_offers for update using (true);

-- Contacts
alter table contacts enable row level security;
create policy "Anyone can read contacts" on contacts for select using (true);
create policy "Anyone can insert contacts" on contacts for insert with check (true);
create policy "Anyone can delete contacts" on contacts for delete using (true);

-- ═══════════════════════════════════════════════════════════════════
--  REALTIME
-- ═══════════════════════════════════════════════════════════════════

alter publication supabase_realtime add table activities;
alter publication supabase_realtime add table payment_requests;
alter publication supabase_realtime add table group_memberships;
alter publication supabase_realtime add table group_expenses;
alter publication supabase_realtime add table creator_supporters;
alter publication supabase_realtime add table invoices;
alter publication supabase_realtime add table escrows;
alter publication supabase_realtime add table exchange_offers;

-- ═══════════════════════════════════════════════════════════════════
--  FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════

-- Auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_payment_requests_updated
  before update on payment_requests
  for each row execute function update_updated_at();

create trigger trg_invoices_updated
  before update on invoices
  for each row execute function update_updated_at();

create trigger trg_escrows_updated
  before update on escrows
  for each row execute function update_updated_at();

create trigger trg_creator_profiles_updated
  before update on creator_profiles
  for each row execute function update_updated_at();
