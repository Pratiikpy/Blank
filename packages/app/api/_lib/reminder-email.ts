/**
 * Reminder email template — used by /api/cron/invoice-reminders to nudge
 * clients before / on / after the due date.
 */

import { renderBrandedEmail } from "./email-templates.js";

export type ReminderKind = "upcoming" | "due_today" | "overdue";

export interface ReminderEmailArgs {
  kind: ReminderKind;
  invoiceId: number;
  vendorName: string;
  amount: string;
  currency: string;
  dueDate: string | null;
  payUrl: string;
}

export function reminderTitle(kind: ReminderKind): string {
  switch (kind) {
    case "upcoming":
      return "Heads up — invoice due soon";
    case "due_today":
      return "Invoice due today";
    case "overdue":
      return "Invoice past due";
  }
}

export function renderReminderEmail(args: ReminderEmailArgs) {
  const dueLabel = args.dueDate
    ? new Date(args.dueDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
  const intro =
    args.kind === "upcoming"
      ? `${args.vendorName}'s invoice is due on ${dueLabel}. One click and you're done.`
      : args.kind === "due_today"
        ? `${args.vendorName}'s invoice is due today (${dueLabel}). One click and you're done.`
        : `${args.vendorName}'s invoice from ${dueLabel} is past due. Tap to settle now.`;
  const subject =
    args.kind === "overdue"
      ? `Past due: invoice from ${args.vendorName}`
      : `Reminder: invoice from ${args.vendorName}`;

  const { html, text } = renderBrandedEmail({
    preheader: `${args.vendorName} — ${args.amount} ${args.currency} due ${dueLabel}`,
    title: reminderTitle(args.kind),
    intro,
    ctaLabel: args.kind === "overdue" ? "Settle now" : "Pay invoice",
    ctaUrl: args.payUrl,
    rows: [
      { label: "Amount", value: `${args.amount} ${args.currency}` },
      { label: "Invoice", value: `#${args.invoiceId.toString().padStart(4, "0")}` },
      { label: "Due", value: dueLabel },
    ],
  });

  return { subject, html, text };
}
