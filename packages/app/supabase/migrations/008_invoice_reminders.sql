-- Track when we last sent a reminder for an invoice so the cron job
-- doesn't double-send within a 22-hour window. NULL on legacy rows means
-- "never reminded yet" — they get a reminder on the next eligible cron tick.

alter table public.invoices
  add column if not exists last_reminder_at timestamptz;
