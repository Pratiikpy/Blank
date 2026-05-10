import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for the 3 dynamic-route dispatchers (push/[action],
// email/[kind], cron/[job]). All three follow the same shape: read
// the dynamic segment from req.query, look up a handler via dynamic
// import, fall through to 404 when the slug is unknown.
//
// These shims exist because Vercel Hobby caps Serverless Functions
// at 12 per deployment, so multiple jobs are consolidated under one
// dynamic route. A regression that broke routing (wrong query-key
// lookup, case-sensitivity drift) would silently 404 every cron.

// We point the dispatchers at fake handler modules below. Each
// matched slug forwards to the corresponding mock; unknown slugs
// must NOT call any mock.

const pushSubscribeHandler = vi.hoisted(() => vi.fn());
const pushNotifyHandler = vi.hoisted(() => vi.fn());
const emailInvoiceHandler = vi.hoisted(() => vi.fn());
const emailRequestHandler = vi.hoisted(() => vi.fn());
const cronReconcileHandler = vi.hoisted(() => vi.fn());
const cronInvoiceRemindersHandler = vi.hoisted(() => vi.fn());
const cronPaymasterMonitorHandler = vi.hoisted(() => vi.fn());
const cronScheduledSendsTickHandler = vi.hoisted(() => vi.fn());

vi.mock("../api/_lib/jobs/push-subscribe.js", () => ({ default: pushSubscribeHandler }));
vi.mock("../api/_lib/jobs/push-notify.js", () => ({ default: pushNotifyHandler }));
vi.mock("../api/_lib/jobs/email-invoice.js", () => ({ default: emailInvoiceHandler }));
vi.mock("../api/_lib/jobs/email-request.js", () => ({ default: emailRequestHandler }));
vi.mock("../api/_lib/jobs/cron-reconcile-tick.js", () => ({ default: cronReconcileHandler }));
vi.mock("../api/_lib/jobs/cron-invoice-reminders.js", () => ({ default: cronInvoiceRemindersHandler }));
vi.mock("../api/_lib/jobs/cron-paymaster-monitor.js", () => ({ default: cronPaymasterMonitorHandler }));
vi.mock("../api/_lib/jobs/cron-scheduled-sends-tick.js", () => ({ default: cronScheduledSendsTickHandler }));

import pushDispatcher from "./push/[action].js";
import emailDispatcher from "./email/[kind].js";
import cronDispatcher from "./cron/[job].js";

function makeReq(query: Record<string, unknown> = {}) {
  return { query, headers: {}, body: {} };
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
  pushSubscribeHandler.mockReset();
  pushNotifyHandler.mockReset();
  emailInvoiceHandler.mockReset();
  emailRequestHandler.mockReset();
  cronReconcileHandler.mockReset();
  cronInvoiceRemindersHandler.mockReset();
  cronPaymasterMonitorHandler.mockReset();
  cronScheduledSendsTickHandler.mockReset();
});

describe("/api/push/[action] dispatcher (§15.x)", () => {
  it("routes 'subscribe' to push-subscribe handler", async () => {
    const req = makeReq({ action: "subscribe" });
    const res = makeRes();
    await pushDispatcher(req, res);
    expect(pushSubscribeHandler).toHaveBeenCalledTimes(1);
    expect(pushSubscribeHandler).toHaveBeenCalledWith(req, res);
    expect(pushNotifyHandler).not.toHaveBeenCalled();
  });

  it("routes 'notify' to push-notify handler", async () => {
    const req = makeReq({ action: "notify" });
    const res = makeRes();
    await pushDispatcher(req, res);
    expect(pushNotifyHandler).toHaveBeenCalledTimes(1);
    expect(pushSubscribeHandler).not.toHaveBeenCalled();
  });

  it("returns 404 with the slug echoed in error for unknown action", async () => {
    const res = makeRes();
    await pushDispatcher(makeReq({ action: "unsubscribe-typo" }), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("unsubscribe-typo");
    expect(pushSubscribeHandler).not.toHaveBeenCalled();
    expect(pushNotifyHandler).not.toHaveBeenCalled();
  });

  it("returns 404 (with '(empty)' marker) when action is missing entirely", async () => {
    const res = makeRes();
    await pushDispatcher(makeReq(), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("(empty)");
  });

  it("dispatcher is case-sensitive (audit-relevant: 'Subscribe' must NOT match 'subscribe')", async () => {
    const res = makeRes();
    await pushDispatcher(makeReq({ action: "Subscribe" }), res);
    expect(res.captured.status).toBe(404);
    expect(pushSubscribeHandler).not.toHaveBeenCalled();
  });
});

describe("/api/email/[kind] dispatcher (§15.x)", () => {
  it("routes 'invoice' to email-invoice handler", async () => {
    const req = makeReq({ kind: "invoice" });
    const res = makeRes();
    await emailDispatcher(req, res);
    expect(emailInvoiceHandler).toHaveBeenCalledTimes(1);
    expect(emailRequestHandler).not.toHaveBeenCalled();
  });

  it("routes 'request' to email-request handler", async () => {
    const req = makeReq({ kind: "request" });
    const res = makeRes();
    await emailDispatcher(req, res);
    expect(emailRequestHandler).toHaveBeenCalledTimes(1);
    expect(emailInvoiceHandler).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown kind", async () => {
    const res = makeRes();
    await emailDispatcher(makeReq({ kind: "reminder-typo" }), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("reminder-typo");
  });

  it("returns 404 (with '(empty)' marker) when kind is missing", async () => {
    const res = makeRes();
    await emailDispatcher(makeReq(), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("(empty)");
  });
});

describe("/api/cron/[job] dispatcher (§15.x)", () => {
  it("routes 'reconcile-tick' to cron-reconcile-tick handler", async () => {
    const req = makeReq({ job: "reconcile-tick" });
    const res = makeRes();
    await cronDispatcher(req, res);
    expect(cronReconcileHandler).toHaveBeenCalledTimes(1);
  });

  it("routes 'invoice-reminders' to cron-invoice-reminders handler", async () => {
    const req = makeReq({ job: "invoice-reminders" });
    const res = makeRes();
    await cronDispatcher(req, res);
    expect(cronInvoiceRemindersHandler).toHaveBeenCalledTimes(1);
  });

  it("routes 'paymaster-monitor' to cron-paymaster-monitor handler", async () => {
    const req = makeReq({ job: "paymaster-monitor" });
    const res = makeRes();
    await cronDispatcher(req, res);
    expect(cronPaymasterMonitorHandler).toHaveBeenCalledTimes(1);
  });

  it("routes 'scheduled-sends-tick' to cron-scheduled-sends-tick handler", async () => {
    const req = makeReq({ job: "scheduled-sends-tick" });
    const res = makeRes();
    await cronDispatcher(req, res);
    expect(cronScheduledSendsTickHandler).toHaveBeenCalledTimes(1);
  });

  it("only ONE handler fires per dispatch (no double-routing)", async () => {
    const req = makeReq({ job: "reconcile-tick" });
    const res = makeRes();
    await cronDispatcher(req, res);
    expect(cronReconcileHandler).toHaveBeenCalledTimes(1);
    // The other 3 must remain at 0.
    expect(cronInvoiceRemindersHandler).not.toHaveBeenCalled();
    expect(cronPaymasterMonitorHandler).not.toHaveBeenCalled();
    expect(cronScheduledSendsTickHandler).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown job slug", async () => {
    const res = makeRes();
    await cronDispatcher(makeReq({ job: "renamed-job" }), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("renamed-job");
  });

  it("returns 404 (with '(empty)' marker) when job is missing", async () => {
    const res = makeRes();
    await cronDispatcher(makeReq(), res);
    expect(res.captured.status).toBe(404);
    expect((res.captured.body?.error as string)).toContain("(empty)");
  });
});
