# Deprecated — these have moved to `supabase/migrations/`

The five `*.sql` files in this directory are duplicates of canonical
migrations in `../supabase/migrations/`:

| File here                         | Canonical migration                       |
| --------------------------------- | ----------------------------------------- |
| `push_subscriptions.sql`          | `005_push_subscriptions.sql`              |
| `invoices_pdf_cid.sql`            | `006_invoices_pdf_cid.sql`                |
| `invoice_request_emails.sql`      | `007_invoice_request_emails.sql`          |
| `invoice_reminders.sql`           | `008_invoice_reminders.sql`               |
| `escrow_attachments.sql`          | `009_escrow_attachments.sql`              |

Apply via the migrations directory only — a fresh deploy that misses
these would silently lose invoice PDF tracking, push notifications,
reminder cron, and escrow attachments. The duplicates here remain only
for git-blame continuity and will be removed in a future cleanup PR.
