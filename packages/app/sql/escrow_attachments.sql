-- Add attachment_cid to escrows for IPFS-pinned project files (briefs,
-- contracts, deliverables — anything the parties want to anchor to the
-- escrow without putting it on-chain).
--
-- Phase 3.4 lets the depositor (or beneficiary) upload a file at escrow
-- creation; the CID is recorded on the row, retrievable later via the
-- Pinata gateway. NULL on legacy rows.

alter table public.escrows
  add column if not exists attachment_cid text;
