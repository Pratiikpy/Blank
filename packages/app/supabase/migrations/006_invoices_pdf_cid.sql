-- Add pdf_cid to invoices for IPFS-pinned PDF tracking.
--
-- Phase 1.1 generates a PDF after every invoice is created on-chain and
-- pins it to IPFS via Pinata. The resulting CID is stored on the row so
-- /pay/<INV-id> can serve a download link, and so the email-out flow
-- (Phase 1.3) can attach the same PDF without re-rendering.
--
-- Schema-additive migration — safe to run on a live Supabase project; old
-- rows simply have NULL until a future regeneration job back-fills them.

alter table public.invoices
  add column if not exists pdf_cid text;
