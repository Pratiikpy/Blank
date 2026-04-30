-- Add optional email addresses to invoices and payment_requests.
--
-- Phase 1.3 sends transactional emails when an invoice is created (vendor
-- → client) and when a payment request is created (requester → payer).
-- The email addresses are user-supplied at creation time and are NEVER
-- exposed on-chain. Storing them in Supabase keeps the linkage local to
-- the row that already exists.
--
-- All columns are NULLable — emails remain entirely optional. If the
-- creator omits them, the row still stores everything else and the
-- send-email API simply skips that row.

alter table public.invoices
  add column if not exists client_email text,
  add column if not exists vendor_email text;

alter table public.payment_requests
  add column if not exists payer_email text;
