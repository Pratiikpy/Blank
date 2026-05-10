import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for cron-invoice-reminders. Pins:
//   - CRON_SECRET fail-closed gate.
//   - The 4 classify() windows (T+3 upcoming, T0 due_today, T-1 overdue,
//     T-7 overdue) and the implicit skip-everything-else.
//   - The 22-hour last_reminder_at dedup so daily cron runs don't
//     double-send.
//   - Best-effort email + push fanout (one branch failing doesn't kill
//     the other; last_reminder_at gets marked regardless).

const getSupabaseAdminMock = vi.hoisted(() => vi.fn());
const sendEmailMock = vi.hoisted(() => vi.fn());
const emailEnabledMock = vi.hoisted(() => vi.fn());
const renderReminderEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../supabase-admin.js", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock("../resend.js", () => ({
  sendEmail: sendEmailMock,
  emailEnabled: emailEnabledMock,
}));

vi.mock("../reminder-email.js", () => ({
  renderReminderEmail: renderReminderEmailMock,
}));

import handler from "./cron-invoice-reminders.js";

const SECRET = "reminders-secret";
const VENDOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function isoNDaysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

// Mid-day variant: adds 12 hours so handler-side floor((due-now)/1d)
// can't slide into the adjacent integer if a few ms pass between
// test setup and handler execution.
function isoMidDayOffset(n: number): string {
  return new Date(Date.now() + n * 86_400_000 + 12 * 3600_000).toISOString();
}

function invoiceRow(opts: Partial<Record<string, unknown>> = {}) {
  return {
    invoice_id: 1,
    vendor_address: VENDOR,
    client_address: CLIENT,
    description: "Web design",
    due_date: isoMidDayOffset(3), // mid-day = floor()-stable at deltaDays=3
    status: "pending",
    client_email: "client@example.com",
    vendor_email: "vendor@example.com",
    last_reminder_at: null,
    ...opts,
  };
}

function adminWithInvoices(rows: Array<Record<string, unknown>>, opts: { selectError?: { message: string } } = {}) {
  const limitMock = vi.fn().mockResolvedValue({
    data: rows,
    error: opts.selectError ?? null,
  });
  const updateEqMock = vi.fn().mockResolvedValue({ error: null });
  const chain: Record<string, unknown> = {
    select: () => chain,
    in: () => chain,
    not: () => chain,
    limit: limitMock,
    update: () => ({ eq: updateEqMock }),
  };
  return {
    updateEqMock,
    client: { from: () => chain },
  };
}

function makeReq(opts: Partial<{ method: string; headers: Record<string, unknown> }> = {}) {
  return {
    method: opts.method ?? "POST",
    headers: opts.headers ?? { authorization: `Bearer ${SECRET}` },
  };
}

function makeRes() {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  return {
    captured,
    setHeader: vi.fn(),
    status(s: number) {
      captured.status = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      captured.body = b;
      return this;
    },
  };
}

beforeEach(() => {
  getSupabaseAdminMock.mockReset();
  sendEmailMock.mockReset();
  emailEnabledMock.mockReset();
  renderReminderEmailMock.mockReset();

  process.env.CRON_SECRET = SECRET;
  delete process.env.PUSH_NOTIFY_SECRET;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.VERCEL_URL;

  emailEnabledMock.mockReturnValue(true);
  sendEmailMock.mockResolvedValue({ id: "msg" });
  renderReminderEmailMock.mockReturnValue({
    subject: "s",
    html: "<p>h</p>",
    text: "t",
  });

  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CRON_SECRET;
  delete process.env.PUSH_NOTIFY_SECRET;
});

describe("cron-invoice-reminders — auth gate (§15.x)", () => {
  it("returns 401 when CRON_SECRET env is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(401);
  });

  it("returns 401 on bearer mismatch", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer wrong" } }), res);
    expect(res.captured.status).toBe(401);
  });
});

describe("cron-invoice-reminders — no-DB graceful (§15.x)", () => {
  it("returns 200 status='no-db' when supabase admin is missing", async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(200);
    expect(res.captured.body?.status).toBe("no-db");
    expect(res.captured.body?.reminded).toBe(0);
  });

  it("returns 500 when the select query errors", async () => {
    getSupabaseAdminMock.mockReturnValue(
      adminWithInvoices([], { selectError: { message: "RLS denied" } }).client,
    );
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.status).toBe(500);
    expect(res.captured.body?.error).toBe("RLS denied");
  });
});

describe("cron-invoice-reminders — classify() windows (§15.x)", () => {
  it("T-3 days → 'upcoming'", async () => {
    const adm = adminWithInvoices([invoiceRow({ due_date: isoMidDayOffset(3) })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(1);
    expect(renderReminderEmailMock.mock.calls[0][0].kind).toBe("upcoming");
  });

  it("T-0 (today) → 'due_today'", async () => {
    // Mid-day offset (0d + 12h = 0.5d ahead) → floor(0.5) = 0, stable
    // against 1-second handler timing slippage.
    const adm = adminWithInvoices([invoiceRow({ due_date: isoMidDayOffset(0) })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(1);
    expect(renderReminderEmailMock.mock.calls[0][0].kind).toBe("due_today");
  });

  it("T+1 day past due → 'overdue'", async () => {
    // floor() requires due_date such that (due - now) < 0 but > -2 days.
    // Use -0.5 days so (due-now)/1d = -0.5 → floor = -1.
    const adm = adminWithInvoices([invoiceRow({ due_date: isoMidDayOffset(-1) })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(1);
    expect(renderReminderEmailMock.mock.calls[0][0].kind).toBe("overdue");
  });

  it("T+7 days past due → 'overdue' (second nudge)", async () => {
    const adm = adminWithInvoices([invoiceRow({ due_date: isoMidDayOffset(-7) })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(1);
    expect(renderReminderEmailMock.mock.calls[0][0].kind).toBe("overdue");
  });

  it("Any OTHER day count is skipped (T+1, T+5, T-3, T-4: none match windows)", async () => {
    // Use mid-day offsets so floor() can't slide into 3/0/-1/-7 windows
    // if a few ms pass between test setup and handler invocation.
    const adm = adminWithInvoices([
      invoiceRow({ invoice_id: 1, due_date: isoMidDayOffset(1) }),   // deltaDays=1, null
      invoiceRow({ invoice_id: 2, due_date: isoMidDayOffset(5) }),   // deltaDays=5, null
      invoiceRow({ invoice_id: 3, due_date: isoMidDayOffset(-3) }),  // deltaDays=-3, null
      invoiceRow({ invoice_id: 4, due_date: isoMidDayOffset(-4) }),  // deltaDays=-4, null
    ]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(0);
    expect(res.captured.body?.skippedNoMatch).toBe(4);
  });

  it("null due_date is skipped (no reminder for unset deadlines)", async () => {
    const adm = adminWithInvoices([invoiceRow({ due_date: null })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(0);
    expect(res.captured.body?.skippedNoMatch).toBe(1);
  });

  it("malformed due_date is skipped (not crash)", async () => {
    const adm = adminWithInvoices([invoiceRow({ due_date: "not-a-date" })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(0);
    expect(res.captured.body?.skippedNoMatch).toBe(1);
  });
});

describe("cron-invoice-reminders — 22h dedup (§15.x)", () => {
  it("skips invoices reminded within the 22h dedup window", async () => {
    // last_reminder_at = 1h ago (well within 22h).
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const adm = adminWithInvoices([invoiceRow({ last_reminder_at: oneHourAgo })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(0);
    expect(res.captured.body?.skippedDeduped).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("fires when last_reminder_at is OLDER than 22h ago", async () => {
    const longAgo = new Date(Date.now() - 23 * 3600_000).toISOString();
    const adm = adminWithInvoices([invoiceRow({ last_reminder_at: longAgo })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.reminded).toBe(1);
    expect(res.captured.body?.skippedDeduped).toBe(0);
  });
});

describe("cron-invoice-reminders — fanout (§15.x)", () => {
  it("marks last_reminder_at on the invoice after sending", async () => {
    const adm = adminWithInvoices([invoiceRow()]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(adm.updateEqMock).toHaveBeenCalledWith("invoice_id", 1);
  });

  it("skips email when client_email is null (push still fires if push secret set)", async () => {
    process.env.PUSH_NOTIFY_SECRET = "push-secret";
    vi.stubGlobal("fetch", vi.fn(async () => ({})) as unknown as typeof fetch);
    const adm = adminWithInvoices([invoiceRow({ client_email: null })]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res.captured.body?.reminded).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("skips email when emailEnabled() is false (push still fires)", async () => {
    emailEnabledMock.mockReturnValue(false);
    process.env.PUSH_NOTIFY_SECRET = "push-secret";
    vi.stubGlobal("fetch", vi.fn(async () => ({})) as unknown as typeof fetch);
    const adm = adminWithInvoices([invoiceRow()]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(res.captured.body?.reminded).toBe(1);
  });

  it("skips push fanout when PUSH_NOTIFY_SECRET is unset (email still fires)", async () => {
    const fetchSpy = vi.fn(async () => ({}));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const adm = adminWithInvoices([invoiceRow()]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(sendEmailMock).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("email send failure does NOT abort the tick (push still runs + last_reminder_at marked)", async () => {
    sendEmailMock.mockRejectedValue(new Error("Resend 4xx"));
    process.env.PUSH_NOTIFY_SECRET = "push-secret";
    const fetchSpy = vi.fn(async () => ({}));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const adm = adminWithInvoices([invoiceRow()]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(fetchSpy).toHaveBeenCalled();
    expect(adm.updateEqMock).toHaveBeenCalled();
    expect(res.captured.body?.reminded).toBe(1);
  });

  it("idempotencyKey includes invoice_id + kind + day so cron retries dedupe at Resend layer", async () => {
    const adm = adminWithInvoices([invoiceRow()]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    const arg = sendEmailMock.mock.calls[0][0];
    expect((arg.idempotencyKey as string)).toMatch(/^reminder:1:upcoming:\d{4}-\d{2}-\d{2}$/);
  });

  it("response shape: scanned + reminded + skippedDeduped + skippedNoMatch + status='ok'", async () => {
    // Mid-day offset for the "sends" row keeps deltaDays pinned at 3
    // (upcoming) regardless of test wall-clock slippage.
    const adm = adminWithInvoices([
      invoiceRow({ invoice_id: 1, due_date: isoMidDayOffset(3) }),                          // sends (upcoming)
      invoiceRow({ invoice_id: 2, due_date: isoMidDayOffset(5) }),                          // skippedNoMatch
      invoiceRow({ invoice_id: 3, due_date: isoMidDayOffset(3), last_reminder_at: new Date().toISOString() }), // skippedDeduped
    ]);
    getSupabaseAdminMock.mockReturnValue(adm.client);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.captured.body?.status).toBe("ok");
    expect(res.captured.body?.scanned).toBe(3);
    expect(res.captured.body?.reminded).toBe(1);
    expect(res.captured.body?.skippedNoMatch).toBe(1);
    expect(res.captured.body?.skippedDeduped).toBe(1);
  });
});
