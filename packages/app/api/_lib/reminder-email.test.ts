import { describe, it, expect } from "vitest";
import { reminderTitle, renderReminderEmail } from "./reminder-email.js";

// §15.x server-side test for the invoice-reminder email. Cron
// fires this for every overdue / due-today / upcoming invoice;
// wrong subject or CTA copy means a vendor's "Past due" reminder
// looks like a routine "due soon" notice.

describe("reminderTitle", () => {
  it("upcoming → 'Heads up' phrasing", () => {
    expect(reminderTitle("upcoming")).toBe("Heads up — invoice due soon");
  });

  it("due_today → 'due today' phrasing", () => {
    expect(reminderTitle("due_today")).toBe("Invoice due today");
  });

  it("overdue → 'past due' phrasing", () => {
    expect(reminderTitle("overdue")).toBe("Invoice past due");
  });
});

describe("renderReminderEmail", () => {
  const baseArgs = {
    invoiceId: 7,
    vendorName: "Acme",
    amount: "100",
    currency: "USDC",
    dueDate: "2026-05-20",
    payUrl: "https://blank/pay/INV-7",
  };

  it("upcoming subject says 'Reminder' (not 'Past due')", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "upcoming" });
    expect(out.subject).toContain("Reminder");
    expect(out.subject).not.toContain("Past due");
  });

  it("due_today subject says 'Reminder'", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "due_today" });
    expect(out.subject).toContain("Reminder");
  });

  it("overdue subject says 'Past due' (NOT a routine reminder)", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "overdue" });
    expect(out.subject).toContain("Past due");
    expect(out.subject).not.toContain("Reminder");
  });

  it("overdue CTA label is 'Settle now' (urgency)", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "overdue" });
    expect(out.html).toContain("Settle now");
  });

  it("upcoming + due_today CTA label is 'Pay invoice' (neutral)", () => {
    const a = renderReminderEmail({ ...baseArgs, kind: "upcoming" });
    const b = renderReminderEmail({ ...baseArgs, kind: "due_today" });
    expect(a.html).toContain("Pay invoice");
    expect(b.html).toContain("Pay invoice");
  });

  it("includes invoice id padded to 4 digits", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "upcoming" });
    expect(out.html).toContain("#0007");
  });

  it("includes amount + currency in the rows", () => {
    const out = renderReminderEmail({ ...baseArgs, kind: "upcoming" });
    expect(out.text).toContain("100 USDC");
  });

  it("falls back to '—' for null dueDate (text body)", () => {
    const out = renderReminderEmail({
      ...baseArgs,
      dueDate: null,
      kind: "upcoming",
    });
    expect(out.text).toContain("Due: —");
  });

  it("escapes vendor name (XSS via invoice fields)", () => {
    const out = renderReminderEmail({
      ...baseArgs,
      vendorName: "<script>",
      kind: "overdue",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});
