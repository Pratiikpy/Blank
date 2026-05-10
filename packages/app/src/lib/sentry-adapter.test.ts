import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for the Sentry adapter. Pin the DSN gate (no telemetry
// when DSN is missing), the init config shape, the idempotency guard
// (second call no-ops), and the log-sink mapping: error -> capture-
// Exception, warn -> captureMessage with level="warning" (Sentry's
// vocabulary, not our "warn"), and every entry -> addBreadcrumb.

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
}));

vi.mock("@sentry/react", () => sentryMock);

const sinkRegistry = vi.hoisted(() => ({ sink: null as null | ((e: unknown) => void) }));

vi.mock("./log", () => ({
  registerLogSink: vi.fn((s: (e: unknown) => void) => {
    sinkRegistry.sink = s;
  }),
}));

beforeEach(async () => {
  vi.resetModules();
  sentryMock.init.mockReset();
  sentryMock.captureException.mockReset();
  sentryMock.captureMessage.mockReset();
  sentryMock.addBreadcrumb.mockReset();
  sinkRegistry.sink = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initSentry — DSN gate", () => {
  it("no-ops when VITE_SENTRY_DSN is unset", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { initSentry } = await import("./sentry-adapter");
    initSentry();
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(sinkRegistry.sink).toBeNull();
  });

  it("calls Sentry.init with the DSN + tracing integration when DSN is set", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@sentry.test/1");
    const { initSentry } = await import("./sentry-adapter");
    initSentry();
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
    const cfg = sentryMock.init.mock.calls[0][0];
    expect(cfg.dsn).toBe("https://abc@sentry.test/1");
    expect(cfg.tracesSampleRate).toBe(0.1);
    expect(cfg.sendDefaultPii).toBe(false);
    expect(Array.isArray(cfg.integrations)).toBe(true);
    expect(sentryMock.browserTracingIntegration).toHaveBeenCalled();
  });

  it("is idempotent — second init call within the same module is a no-op", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@sentry.test/1");
    const { initSentry } = await import("./sentry-adapter");
    initSentry();
    initSentry();
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
  });
});

describe("log sink mapping (error / warn / info / debug)", () => {
  beforeEach(async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@sentry.test/1");
    const { initSentry } = await import("./sentry-adapter");
    initSentry();
    expect(sinkRegistry.sink).not.toBeNull();
  });

  it("error entry with an Error -> captureException with name + message preserved", () => {
    sinkRegistry.sink!({
      level: "error",
      event: "relay.timeout",
      ts: new Date().toISOString(),
      error: { name: "TimeoutError", message: "rpc hung", stack: "at boom" },
    });
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentryMock.captureException.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("rpc hung");
    expect((err as Error).name).toBe("TimeoutError");
    expect(ctx.tags.event).toBe("relay.timeout");
  });

  it("error entry without an Error field -> still captureException using event as message", () => {
    sinkRegistry.sink!({
      level: "error",
      event: "stray.error",
      ts: new Date().toISOString(),
    });
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    const err = sentryMock.captureException.mock.calls[0][0];
    expect((err as Error).message).toBe("stray.error");
  });

  it("warn entry -> captureMessage with level='warning' (Sentry vocab)", () => {
    sinkRegistry.sink!({
      level: "warn",
      event: "supabase.insertActivity",
      ts: new Date().toISOString(),
      context: { err: "duplicate key" },
    });
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = sentryMock.captureMessage.mock.calls[0];
    expect(msg).toBe("supabase.insertActivity");
    expect(ctx.level).toBe("warning");
    expect(ctx.tags.event).toBe("supabase.insertActivity");
    expect(ctx.extra).toEqual({ err: "duplicate key" });
  });

  it("info entry -> no captureMessage / no captureException, ONLY a breadcrumb", () => {
    sinkRegistry.sink!({
      level: "info",
      event: "tx.send",
      ts: new Date().toISOString(),
    });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(sentryMock.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("debug entry -> breadcrumb-only too (cheap, attached to next error)", () => {
    sinkRegistry.sink!({
      level: "debug",
      event: "cofhe.permit.refresh",
      ts: new Date().toISOString(),
    });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(sentryMock.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("every entry adds a breadcrumb with the right category + mapped level", () => {
    const isoTs = "2026-05-11T00:00:00.000Z";
    sinkRegistry.sink!({
      level: "warn",
      event: "rpc.retry",
      ts: isoTs,
      context: { attempt: 2 },
    });
    expect(sentryMock.addBreadcrumb).toHaveBeenCalledTimes(1);
    const bc = sentryMock.addBreadcrumb.mock.calls[0][0];
    expect(bc.category).toBe("rpc.retry");
    expect(bc.level).toBe("warning");
    expect(bc.data).toEqual({ attempt: 2 });
    // timestamp is unix seconds (not ms).
    expect(bc.timestamp).toBe(new Date(isoTs).getTime() / 1000);
  });

  it("breadcrumb level passthrough for info ('info' stays 'info')", () => {
    sinkRegistry.sink!({
      level: "info",
      event: "tx.send",
      ts: new Date().toISOString(),
    });
    expect(sentryMock.addBreadcrumb.mock.calls[0][0].level).toBe("info");
  });

  it("breadcrumb level passthrough for error ('error' stays 'error')", () => {
    sinkRegistry.sink!({
      level: "error",
      event: "boom",
      ts: new Date().toISOString(),
    });
    expect(sentryMock.addBreadcrumb.mock.calls[0][0].level).toBe("error");
  });
});
