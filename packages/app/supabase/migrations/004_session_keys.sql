-- ═══════════════════════════════════════════════════════════════════
--  004_session_keys — Phase 4.1 server-held session keys for ScheduledSends.
--
--  Each row holds the AES-GCM-encrypted private key for one session-key
--  authorization. The cron tick (api/cron/scheduled-sends-tick) reads
--  rows, decrypts them with the env-stored master key, and signs UserOps
--  on schedule.
--
--  Authoritative state lives ON CHAIN in SessionKeyValidator. This table
--  is just the secret-storage adjunct — losing it means the cron stops
--  firing for the affected scopes, but the on-chain authorization is
--  still valid (user can `revokeScope` and re-set with a new session key).
--
--  RLS posture: enabled, NO public policies — only the service-role key
--  (server-side) ever reads or writes. Even an attacker with the anon
--  key cannot pull encrypted blobs.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists session_keys (
  -- (account, session_key, chain_id) is the natural primary key — the
  -- same session key is unique per AA per chain.
  account text not null,
  session_key text not null,
  chain_id bigint not null,

  -- Hex-encoded AES-GCM envelope: nonce(12) || ciphertext || tag(16).
  -- The plaintext under the cipher is the 32-byte raw secp256k1 private
  -- key. Master key lives in SESSION_KEYS_MASTER_KEY env (32 bytes hex).
  encrypted_private_key text not null,

  -- User-facing label captured at create time (e.g. "Rent — March").
  -- Free-text, max 64 chars enforced client-side.
  label text default '',

  -- The recipient address the session key is scoped to. Mirrored here
  -- so the cron tick can build the UserOp's callData without a chain
  -- read for every fire (chain read still happens for amount + period
  -- + lastFiredAt).
  recipient text not null,

  -- The ERC-20 token address (USDC on testnet). Mirrored same as recipient.
  spend_token text not null,

  -- Soft-delete via revoked_at — cron skips revoked rows. The on-chain
  -- revoke is authoritative, but having a flag here lets us short-circuit
  -- expensive chain reads when a row is known-revoked.
  revoked_at timestamptz default null,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  primary key (account, session_key, chain_id)
);

alter table session_keys enable row level security;

create index if not exists session_keys_account_chain_idx
  on session_keys (account, chain_id)
  where revoked_at is null;

-- Server-side cron-tick lookup: find all not-yet-revoked rows for a
-- chain, ordered by oldest-fired so the earliest scopes get processed
-- first under tick budget pressure.
create index if not exists session_keys_chain_active_idx
  on session_keys (chain_id, created_at asc)
  where revoked_at is null;
