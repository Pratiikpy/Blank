import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendEmail,
  emailEnabled,
  EmailNotConfiguredError,
} from "./resend.js";

// §15.x server-side test for the Resend wrapper. Pin the
// configured-required guard, the request-body shape, and the
// non-2xx error handling.

const ARGS = {
  to: "alice@example.com",
  subject: "Test",
  html: "<p>hello</p>",
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "key-test";
  process.env.EMAIL_FROM = "Blank <noreply@blank.app>";
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  vi.unstubAllGlobals();
});

function mockFetchOk(body: unknown = { id: "msg-123" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("emailEnabled", () => {
  it("returns true when both env vars set", () => {
    expect(emailEnabled()).toBe(true);
  });

  it("returns false when RESEND_API_KEY missing", () => {
    delete process.env.RESEND_API_KEY;
    expect(emailEnabled()).toBe(false);
  });

  it("returns false when EMAIL_FROM missing", () => {
    delete process.env.EMAIL_FROM;
    expect(emailEnabled()).toBe(false);
  });
});

describe("sendEmail", () => {
  it("throws EmailNotConfiguredError when RESEND_API_KEY missing", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail(ARGS)).rejects.toThrow(EmailNotConfiguredError);
  });

  it("posts to /emails with the expected body shape on success", async () => {
    const fetch = mockFetchOk();
    const out = await sendEmail(ARGS);
    expect(out).toEqual({ id: "msg-123" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.resend.com");
    expect(url).toContain("/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key-test");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("Blank <noreply@blank.app>");
    expect(body.to).toEqual(["alice@example.com"]);
    expect(body.subject).toBe("Test");
    expect(body.html).toBe("<p>hello</p>");
  });

  it("normalizes a single-string to array on the to field", async () => {
    const fetch = mockFetchOk();
    await sendEmail({ ...ARGS, to: "single@example.com" });
    const init = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["single@example.com"]);
  });

  it("preserves an array recipient", async () => {
    const fetch = mockFetchOk();
    await sendEmail({ ...ARGS, to: ["a@x.com", "b@x.com"] });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
  });

  it("includes Idempotency-Key header when provided", async () => {
    const fetch = mockFetchOk();
    await sendEmail({ ...ARGS, idempotencyKey: "inv-7-2026-05-10" });
    const init = fetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("inv-7-2026-05-10");
  });

  it("renames attachments.contentType to content_type for Resend's API", async () => {
    const fetch = mockFetchOk();
    await sendEmail({
      ...ARGS,
      attachments: [
        { filename: "invoice.pdf", content: "BASE64==", contentType: "application/pdf" },
      ],
    });
    const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.attachments[0]).toEqual({
      filename: "invoice.pdf",
      content: "BASE64==",
      content_type: "application/pdf",
    });
  });

  it("throws on non-2xx with the response status + body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => '{"message":"validation failed"}',
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    await expect(sendEmail(ARGS)).rejects.toThrow(/Resend send failed \(422\)/);
  });
});
