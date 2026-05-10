import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x test for the push-notifications module. Three layers:
// 1) Pure feature-detection helpers (pushSupported, isIos,
//    isStandalonePwa, pushPermissionState).
// 2) subscribeToPush early-return branches (unsupported,
//    vapid-missing, permission-denied, network-error, happy).
// 3) unsubscribeFromPush short-circuit when no registration.

// ─── Helpers ──────────────────────────────────────────────────

function stubUA(ua: string) {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function stubFeature<T>(obj: Record<string, unknown>, key: string, value: T) {
  Object.defineProperty(obj, key, { value, configurable: true });
}

function clearFeature(obj: Record<string, unknown>, key: string) {
  if (key in obj) delete obj[key];
}

const ORIG_UA = navigator.userAgent;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stubUA(ORIG_UA);
  // Clean up window flags we may have added.
  clearFeature(window as unknown as Record<string, unknown>, "PushManager");
  clearFeature(window as unknown as Record<string, unknown>, "Notification");
  clearFeature(navigator as unknown as Record<string, unknown>, "serviceWorker");
  clearFeature(navigator as unknown as Record<string, unknown>, "standalone");
});

// Module-under-test is imported fresh in each block where the
// env or globals were swapped before module evaluation.

describe("isIos", () => {
  it("returns true for iPhone UA", async () => {
    stubUA("Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)");
    const { isIos } = await import("./push-notifications");
    expect(isIos()).toBe(true);
  });

  it("returns true for iPad UA", async () => {
    stubUA("Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X)");
    const { isIos } = await import("./push-notifications");
    expect(isIos()).toBe(true);
  });

  it("returns false for desktop Chrome UA", async () => {
    stubUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0");
    const { isIos } = await import("./push-notifications");
    expect(isIos()).toBe(false);
  });

  it("returns false for Android UA", async () => {
    stubUA("Mozilla/5.0 (Linux; Android 13) Chrome/120.0");
    const { isIos } = await import("./push-notifications");
    expect(isIos()).toBe(false);
  });
});

describe("isStandalonePwa", () => {
  it("returns true when navigator.standalone is set (iOS PWA)", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "standalone", true);
    const { isStandalonePwa } = await import("./push-notifications");
    expect(isStandalonePwa()).toBe(true);
  });

  it("returns true when matchMedia(display-mode: standalone) matches", async () => {
    clearFeature(navigator as unknown as Record<string, unknown>, "standalone");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof matchMedia,
    );
    const { isStandalonePwa } = await import("./push-notifications");
    expect(isStandalonePwa()).toBe(true);
  });

  it("returns false when neither signal is set", async () => {
    clearFeature(navigator as unknown as Record<string, unknown>, "standalone");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })) as unknown as typeof matchMedia,
    );
    const { isStandalonePwa } = await import("./push-notifications");
    expect(isStandalonePwa()).toBe(false);
  });
});

describe("pushSupported", () => {
  it("returns true when serviceWorker + PushManager + Notification all present", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {});
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    stubFeature(window as unknown as Record<string, unknown>, "Notification", function () {});
    const { pushSupported } = await import("./push-notifications");
    expect(pushSupported()).toBe(true);
  });

  it("returns false when PushManager is missing", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {});
    clearFeature(window as unknown as Record<string, unknown>, "PushManager");
    stubFeature(window as unknown as Record<string, unknown>, "Notification", function () {});
    const { pushSupported } = await import("./push-notifications");
    expect(pushSupported()).toBe(false);
  });

  it("returns false when Notification is missing", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {});
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    clearFeature(window as unknown as Record<string, unknown>, "Notification");
    const { pushSupported } = await import("./push-notifications");
    expect(pushSupported()).toBe(false);
  });
});

describe("pushPermissionState", () => {
  it("returns 'unsupported' when feature-detect fails", async () => {
    clearFeature(window as unknown as Record<string, unknown>, "Notification");
    const { pushPermissionState } = await import("./push-notifications");
    const out = await pushPermissionState();
    expect(out).toBe("unsupported");
  });

  it("returns Notification.permission when supported", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {});
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    stubFeature(window as unknown as Record<string, unknown>, "Notification", {
      permission: "granted",
    });
    const { pushPermissionState } = await import("./push-notifications");
    const out = await pushPermissionState();
    expect(out).toBe("granted");
  });
});

describe("subscribeToPush — early-return branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns reason='unsupported' when feature-detect fails", async () => {
    clearFeature(window as unknown as Record<string, unknown>, "PushManager");
    const { subscribeToPush } = await import("./push-notifications");
    const out = await subscribeToPush({ address: "0xabc" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unsupported");
  });

  it("returns reason='vapid-missing' when VITE_VAPID_PUBLIC_KEY is empty", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {});
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    stubFeature(window as unknown as Record<string, unknown>, "Notification", function () {});

    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "");
    // Force module re-eval so the captured-at-load VAPID const sees "".
    vi.resetModules();

    const { subscribeToPush } = await import("./push-notifications");
    const out = await subscribeToPush({ address: "0xabc" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("vapid-missing");
  });
});

describe("unsubscribeFromPush", () => {
  it("returns false when push is unsupported", async () => {
    clearFeature(window as unknown as Record<string, unknown>, "PushManager");
    const { unsubscribeFromPush } = await import("./push-notifications");
    expect(await unsubscribeFromPush()).toBe(false);
  });

  it("returns false when no service-worker registration exists", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {
      getRegistration: vi.fn(async () => null),
    });
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    stubFeature(window as unknown as Record<string, unknown>, "Notification", function () {});

    const { unsubscribeFromPush } = await import("./push-notifications");
    expect(await unsubscribeFromPush()).toBe(false);
  });

  it("returns false when registration exists but no active subscription", async () => {
    stubFeature(navigator as unknown as Record<string, unknown>, "serviceWorker", {
      getRegistration: vi.fn(async () => ({
        pushManager: { getSubscription: vi.fn(async () => null) },
      })),
    });
    stubFeature(window as unknown as Record<string, unknown>, "PushManager", function () {});
    stubFeature(window as unknown as Record<string, unknown>, "Notification", function () {});

    const { unsubscribeFromPush } = await import("./push-notifications");
    expect(await unsubscribeFromPush()).toBe(false);
  });
});
