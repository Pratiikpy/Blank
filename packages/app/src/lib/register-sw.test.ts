import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for the service-worker registration shim. Four
// early-return branches + the happy path. All four early-returns
// must NOT call `navigator.serviceWorker.register` — getting any
// of them wrong shows up as console spam (or worse: an https-only
// register call from http: that the browser rejects on every load).

// Silence log.warn — the swallowed-error test exercises log.warn,
// and we want the test runner output clean.
vi.mock("./log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { registerServiceWorker } from "./register-sw";

const ORIG_LOCATION = window.location;
const ORIG_SW = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function setLocation(protocol: string, hostname: string) {
  Object.defineProperty(window, "location", {
    value: { ...ORIG_LOCATION, protocol, hostname },
    writable: true,
    configurable: true,
  });
}

function stubSW(register: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register },
    writable: true,
    configurable: true,
  });
}

function clearSW() {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
}

beforeEach(() => {
  setLocation("https:", "example.com");
});

afterEach(() => {
  // Restore navigator.serviceWorker exactly as found.
  if (ORIG_SW) {
    Object.defineProperty(navigator, "serviceWorker", ORIG_SW);
  } else {
    clearSW();
  }
  Object.defineProperty(window, "location", {
    value: ORIG_LOCATION,
    writable: true,
    configurable: true,
  });
});

describe("registerServiceWorker (§15.x)", () => {
  it("no-ops when navigator.serviceWorker is missing", () => {
    clearSW();
    const addSpy = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    // Should NOT attach a load listener if SW isn't available.
    expect(addSpy.mock.calls.find((c) => c[0] === "load")).toBeUndefined();
  });

  it("no-ops on plain http: (non-localhost) without trying to register", () => {
    setLocation("http:", "example.com");
    const register = vi.fn(async () => ({}));
    stubSW(register);
    const addSpy = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    expect(addSpy.mock.calls.find((c) => c[0] === "load")).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("DOES register on http://localhost (dev server is exempt)", () => {
    setLocation("http:", "localhost");
    const register = vi.fn(async () => ({}));
    stubSW(register);
    const addSpy = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    const loadCall = addSpy.mock.calls.find((c) => c[0] === "load");
    expect(loadCall).toBeDefined();
  });

  it("registers on https: when serviceWorker is available", () => {
    setLocation("https:", "example.com");
    const register = vi.fn(async () => ({}));
    stubSW(register);
    const addSpy = vi.spyOn(window, "addEventListener");

    registerServiceWorker();

    // Listener attached but register not called yet (deferred to load).
    const loadCall = addSpy.mock.calls.find((c) => c[0] === "load");
    expect(loadCall).toBeDefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("calls navigator.serviceWorker.register('/sw.js', { scope: '/' }) when load fires", () => {
    setLocation("https:", "example.com");
    const register = vi.fn(async () => ({}));
    stubSW(register);

    let loadHandler: (() => void) | null = null;
    vi.spyOn(window, "addEventListener").mockImplementation((evt, h) => {
      if (evt === "load") loadHandler = h as () => void;
    });

    registerServiceWorker();

    expect(loadHandler).not.toBeNull();
    loadHandler!();

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("registration failure does not throw (swallowed via .catch + log.warn)", async () => {
    setLocation("https:", "example.com");
    // Force registration to reject — the catch must absorb it without
    // bubbling. We capture the load handler and invoke it manually so
    // we can await the promise it kicks off.
    const register = vi.fn(async () => {
      throw new Error("boom");
    });
    stubSW(register);

    let loadHandler: (() => void) | null = null;
    vi.spyOn(window, "addEventListener").mockImplementation((evt, h) => {
      if (evt === "load") loadHandler = h as () => void;
    });

    registerServiceWorker();
    // Call the load handler; it returns void but kicks off a promise
    // we need to flush so the .catch runs before the test ends.
    expect(() => loadHandler!()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    // No assertion needed beyond "no unhandled rejection" — the test
    // would surface that as a failure on its own.
  });
});
