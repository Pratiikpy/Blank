import { describe, it, expect, vi } from "vitest";
import { log, registerLogSink } from "./log";

// §15.x lib test for the structured logger. The §3.21 migration
// routed ~131 console.* sites across 28 files through this module
// so any regression in entry shape or sink fan-out has wide blast
// radius. Pin: every entry has level + event + ISO timestamp;
// Error args produce error-shape; object args produce context-shape;
// a throwing sink does NOT break sibling sinks.

describe("log", () => {
  it("dispatches log.info with level=info and event=name", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    log.info("test.info.event", { foo: "bar" });

    // Find the entry our sink received (other sinks may have been
    // registered earlier — find by event name).
    const matches = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .filter((e) => e?.event === "test.info.event");
    expect(matches.length).toBe(1);
    expect(matches[0].level).toBe("info");
    expect(matches[0].event).toBe("test.info.event");
    expect(matches[0].context).toEqual({ foo: "bar" });
  });

  it("includes an ISO-8601 ts on every entry", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    log.info("test.ts.event");
    const entry = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .find((e) => e?.event === "test.ts.event");
    expect(entry).toBeDefined();
    expect(entry!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(entry!.ts as string)).not.toThrow();
  });

  it("Error arg lands in entry.error with name + message + stack", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    const err = new TypeError("boom");
    log.error("test.error.event", err);

    const entry = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .find((e) => e?.event === "test.error.event");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("error");
    expect(entry!.error).toBeDefined();
    expect(entry!.error!.name).toBe("TypeError");
    expect(entry!.error!.message).toBe("boom");
    expect(entry!.error!.stack).toBeDefined();
    expect(entry!.context).toBeUndefined();
  });

  it("object arg lands in entry.context (NOT entry.error)", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    log.warn("test.warn.event", { txHash: "0xabc", count: 3 });

    const entry = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .find((e) => e?.event === "test.warn.event");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("warn");
    expect(entry!.context).toEqual({ txHash: "0xabc", count: 3 });
    expect(entry!.error).toBeUndefined();
  });

  it("debug level routes correctly", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    log.debug("test.debug.event", { a: 1 });

    const entry = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .find((e) => e?.event === "test.debug.event");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("debug");
  });

  it("a throwing sink does NOT break sibling sinks", () => {
    const throwingSink = vi.fn((_entry: unknown): void => {
      throw new Error("sink-broke");
    });
    const goodSink = vi.fn();
    registerLogSink(throwingSink);
    registerLogSink(goodSink);

    expect(() => log.info("test.sinkfanout.event")).not.toThrow();

    // Both sinks must still have been called for this event.
    const throwingHit = throwingSink.mock.calls.some(
      (call) => (call[0] as { event?: string } | undefined)?.event === "test.sinkfanout.event",
    );
    const goodHit = goodSink.mock.calls.some(
      (call) => (call[0] as { event?: string } | undefined)?.event === "test.sinkfanout.event",
    );
    expect(throwingHit).toBe(true);
    expect(goodHit).toBe(true);
  });

  it("non-Error non-object arg (string, number) lands neither in context nor error", () => {
    const sink = vi.fn();
    registerLogSink(sink);
    log.info("test.scalar.event", "just a string");

    const entry = sink.mock.calls
      .map(([e]) => e as { level?: string; event?: string; ts?: string; context?: unknown; error?: { name: string; message: string; stack?: string } })
      .find((e) => e?.event === "test.scalar.event");
    expect(entry).toBeDefined();
    expect(entry!.context).toBeUndefined();
    expect(entry!.error).toBeUndefined();
  });
});
