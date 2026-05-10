import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the web-push npm package BEFORE importing the SUT.
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import { sendPush, webPushConfigured } from "./web-push.js";
import webpush from "web-push";

const sendNotificationMock = (
  webpush as unknown as { sendNotification: ReturnType<typeof vi.fn> }
).sendNotification;
const setVapidDetailsMock = (
  webpush as unknown as { setVapidDetails: ReturnType<typeof vi.fn> }
).setVapidDetails;

const SUB = {
  endpoint: "https://fcm.googleapis.com/test/abc",
  keys: { p256dh: "p", auth: "a" },
};

const PAYLOAD = {
  title: "Test",
  body: "Hello",
  url: "/app",
};

beforeEach(() => {
  sendNotificationMock.mockReset();
  setVapidDetailsMock.mockReset();
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe("webPushConfigured", () => {
  it("returns true when both VAPID env vars are set", () => {
    expect(webPushConfigured()).toBe(true);
  });

  it("returns false when public key is missing", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect(webPushConfigured()).toBe(false);
  });

  it("returns false when private key is missing", () => {
    delete process.env.VAPID_PRIVATE_KEY;
    expect(webPushConfigured()).toBe(false);
  });
});

describe("sendPush", () => {
  it("returns ok=true on a 201 response", async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    const out = await sendPush(SUB, PAYLOAD);
    expect(out).toEqual({ ok: true, gone: false, status: 201 });
  });

  it("classifies 404 as gone (subscription permanently dead)", async () => {
    sendNotificationMock.mockRejectedValue({ statusCode: 404, message: "Not Found" });
    const out = await sendPush(SUB, PAYLOAD);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(true);
    expect(out.status).toBe(404);
  });

  it("classifies 410 as gone (subscription permanently dead)", async () => {
    sendNotificationMock.mockRejectedValue({ statusCode: 410, message: "Gone" });
    const out = await sendPush(SUB, PAYLOAD);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(true);
    expect(out.status).toBe(410);
  });

  it("does NOT classify 500 as gone (transient failure)", async () => {
    sendNotificationMock.mockRejectedValue({ statusCode: 500, message: "Internal" });
    const out = await sendPush(SUB, PAYLOAD);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(false);
    expect(out.status).toBe(500);
  });

  it("does NOT classify 429 as gone (rate-limit, retry later)", async () => {
    sendNotificationMock.mockRejectedValue({ statusCode: 429, message: "Too Many" });
    const out = await sendPush(SUB, PAYLOAD);
    expect(out.gone).toBe(false);
  });

  it("survives a thrown Error without a statusCode", async () => {
    sendNotificationMock.mockRejectedValue(new Error("network down"));
    const out = await sendPush(SUB, PAYLOAD);
    expect(out.ok).toBe(false);
    expect(out.gone).toBe(false);
    expect(out.error).toBe("network down");
  });

  it("forwards the JSON-serialized payload to sendNotification", async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await sendPush(SUB, PAYLOAD);
    const [sub, body] = sendNotificationMock.mock.calls[0] as [unknown, string, unknown];
    expect(sub).toEqual(SUB);
    expect(typeof body).toBe("string");
    expect(JSON.parse(body)).toEqual(PAYLOAD);
  });
});
