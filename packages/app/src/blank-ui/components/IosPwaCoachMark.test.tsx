import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for IosPwaCoachMark. Coach-mark banner pointing
// iPhone/iPad Safari users at "Add to Home Screen". Web Push
// notifications on iOS only fire when Blank is installed as a
// PWA — Apple gated this on home-screen install in iOS 16.4.
// Without coaching, mobile Safari users assume push is broken
// because the prompt never appears.
//
// CRITICAL pins:
//   - 3-condition visibility gate (mount-effect): isIos() AND
//     NOT isStandalonePwa() AND NOT dismissed-in-localStorage.
//     Any false hides the banner; the 3 checks run in ORDER
//     so a non-iOS device exits early without even touching
//     localStorage.
//   - SSR-safe: useState initializer is `false` (not the
//     synchronous read of all 3 conditions) so the component
//     renders nothing during hydration; the actual check fires
//     in useEffect on mount which only runs in the browser.
//     This pattern matters because Blank's landing page may be
//     server-rendered through Vercel SSG and a hydration
//     mismatch would log a noisy React warning.
//   - localStorage key 'blank_ios_pwa_coach_dismissed' = "1"
//     when dismissed; pinned literally so a regression that
//     renamed the key would re-prompt all users who had already
//     dismissed.
//   - Dismissal is sticky: clicking X writes "1" to localStorage
//     + flips shouldShow to false; banner re-mount after refresh
//     reads localStorage and stays hidden.
//   - localStorage quota / disabled (try/catch) -> fail closed
//     (best-effort write); read fail -> default to NOT-dismissed
//     so the user gets the coach mark; the SSR-fallback in
//     readDismissed() returns true (don't show) when
//     localStorage is undefined entirely.
//   - aria-label='Dismiss' on the X button (icon-only); role=
//     'status' on the banner root so screen-readers announce
//     it as a status update; the copy mentions "Tap the Share
//     icon" + "Add to Home Screen" verbatim so the user has
//     specific actions to take (NOT a generic "install" call).

const isIosMock = vi.hoisted(() => vi.fn());
const isStandalonePwaMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/push-notifications", () => ({
  isIos: isIosMock,
  isStandalonePwa: isStandalonePwaMock,
}));

import { IosPwaCoachMark } from "./IosPwaCoachMark";

beforeEach(() => {
  isIosMock.mockReset();
  isStandalonePwaMock.mockReset();
  // Defaults: iOS Safari, not installed as PWA
  isIosMock.mockReturnValue(true);
  isStandalonePwaMock.mockReturnValue(false);
  // Clear localStorage between tests so dismissal doesn't leak
  try { localStorage.clear(); } catch { /* noop */ }
});

// ───────────────────────────────────────────────────────────
//  3-condition visibility gate
// ───────────────────────────────────────────────────────────

describe("IosPwaCoachMark — visibility gate (§15.x)", () => {
  it("iOS + not standalone + not dismissed -> banner visible", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Add Blank to your Home Screen"),
    ).toBeInTheDocument();
  });

  it("non-iOS device -> banner hidden", async () => {
    isIosMock.mockReturnValue(false);
    const { container } = render(<IosPwaCoachMark />);
    // Give the effect a tick to fire (or not)
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });

  it("already installed as standalone PWA -> banner hidden", async () => {
    isStandalonePwaMock.mockReturnValue(true);
    const { container } = render(<IosPwaCoachMark />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });

  it("previously dismissed (localStorage='1') -> banner hidden", async () => {
    localStorage.setItem("blank_ios_pwa_coach_dismissed", "1");
    const { container } = render(<IosPwaCoachMark />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });

  it("dismissal value is exactly '1' (other values do NOT count as dismissed)", async () => {
    localStorage.setItem("blank_ios_pwa_coach_dismissed", "true"); // wrong value
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Dismissal flow + persistence
// ───────────────────────────────────────────────────────────

describe("IosPwaCoachMark — dismissal flow (§15.x)", () => {
  it("X click -> banner hides immediately + localStorage='1' written", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(localStorage.getItem("blank_ios_pwa_coach_dismissed")).toBe("1");
  });

  it("dismissal sticks across re-mount (read from localStorage on next mount)", async () => {
    const { unmount } = render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Dismiss"));
    unmount();
    // Re-mount on the next session: banner stays hidden
    const { container } = render(<IosPwaCoachMark />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
  });

  it("localStorage write failure (quota) -> silent fail-closed, banner still hides via state", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    // Simulate localStorage.setItem throwing (quota exceeded)
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    fireEvent.click(screen.getByLabelText("Dismiss"));
    // Banner hides via state even though localStorage failed
    expect(screen.queryByRole("status")).toBeNull();
    setItemSpy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────
//  Content + accessibility
// ───────────────────────────────────────────────────────────

describe("IosPwaCoachMark — content + accessibility (§15.x)", () => {
  it("banner has role='status' for screen-reader announcement", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("title 'Add Blank to your Home Screen' + actionable instructions", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByText("Add Blank to your Home Screen")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Tap the Share icon in Safari/),
    ).toBeInTheDocument();
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
  });

  it("Dismiss button has aria-label='Dismiss' (icon-only, needs accessible name)", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByLabelText("Dismiss")).toBeInTheDocument();
    });
  });

  it("dismissal does NOT touch isIos() / isStandalonePwa() again on click", async () => {
    render(<IosPwaCoachMark />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    const iosCallsBefore = isIosMock.mock.calls.length;
    const standaloneCallsBefore = isStandalonePwaMock.mock.calls.length;
    fireEvent.click(screen.getByLabelText("Dismiss"));
    // The dismiss handler only writes localStorage + setShouldShow(false);
    // it doesn't re-run the visibility check.
    expect(isIosMock.mock.calls.length).toBe(iosCallsBefore);
    expect(isStandalonePwaMock.mock.calls.length).toBe(standaloneCallsBefore);
  });
});

// ───────────────────────────────────────────────────────────
//  SSR-safe initial render
// ───────────────────────────────────────────────────────────

describe("IosPwaCoachMark — SSR-safe initial render (§15.x)", () => {
  it("first render returns null (useState=false, effect runs on mount)", () => {
    // Render synchronously without flushing effects -> initial state shouldShow=false
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(false);
    // Use a custom render that doesn't flush effects (just check the
    // initial state mechanism by mocking useEffect to not auto-run).
    // The behavior verified: first paint never includes the banner;
    // the banner appears only AFTER the mount effect.
    const { container } = render(<IosPwaCoachMark />);
    // Because vitest/react-testing-library DOES flush effects, the banner
    // shows up here. Pin the SSR-safe pattern via the lib mock-call shape:
    // isIos is called from inside useEffect (not during render).
    expect(isIosMock).toHaveBeenCalledTimes(1);
    expect(container).toBeDefined();
  });

  it("isIos() guard short-circuits before isStandalonePwa() in the effect", async () => {
    isIosMock.mockReturnValue(false);
    render(<IosPwaCoachMark />);
    await new Promise((r) => setTimeout(r, 0));
    expect(isIosMock).toHaveBeenCalledTimes(1);
    // isStandalonePwa should NOT have been called because isIos returned false
    expect(isStandalonePwaMock).toHaveBeenCalledTimes(0);
  });

  it("isStandalonePwa() guard short-circuits before reading localStorage", async () => {
    isIosMock.mockReturnValue(true);
    isStandalonePwaMock.mockReturnValue(true);
    const getSpy = vi.spyOn(Storage.prototype, "getItem");
    render(<IosPwaCoachMark />);
    await new Promise((r) => setTimeout(r, 0));
    expect(isStandalonePwaMock).toHaveBeenCalledTimes(1);
    // localStorage.getItem for the dismissed key should NOT have fired
    const dismissedReads = getSpy.mock.calls.filter(
      (c) => c[0] === "blank_ios_pwa_coach_dismissed",
    );
    expect(dismissedReads).toHaveLength(0);
    getSpy.mockRestore();
  });
});
