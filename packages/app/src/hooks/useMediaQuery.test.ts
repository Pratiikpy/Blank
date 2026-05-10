import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery";

// §15.2.1 hook test for the media-query primitive. Drives every
// mobile-vs-desktop branch in the UI; misclassification means
// nav-bar layout, modal sizing, and bottom-sheet vs. side-panel
// pick the wrong shape.

interface MqlMock {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

let listeners: Array<(e: { matches: boolean }) => void>;
let currentMatch: boolean;

function makeMatchMedia(initialMatch: boolean) {
  currentMatch = initialMatch;
  listeners = [];
  return vi.fn((_query: string): MqlMock => ({
    get matches() {
      return currentMatch;
    },
    addEventListener: vi.fn((_event, handler) => {
      listeners.push(handler as (e: { matches: boolean }) => void);
    }),
    removeEventListener: vi.fn((_event, handler) => {
      listeners = listeners.filter((h) => h !== handler);
    }),
  }));
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", makeMatchMedia(false));
  // jsdom defines window but not matchMedia by default; stub on window too.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: window.matchMedia,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaQuery (§15.2.1)", () => {
  it("returns the initial matches value from matchMedia", () => {
    vi.stubGlobal("matchMedia", makeMatchMedia(true));
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(true);
  });

  it("returns false when query does not match initially", () => {
    vi.stubGlobal("matchMedia", makeMatchMedia(false));
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(false);
  });

  it("flips when the matchMedia listener fires (responsive breakpoint crossed)", () => {
    vi.stubGlobal("matchMedia", makeMatchMedia(false));
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(false);

    act(() => {
      currentMatch = true;
      for (const handler of listeners) handler({ matches: true });
    });
    expect(result.current).toBe(true);

    act(() => {
      currentMatch = false;
      for (const handler of listeners) handler({ matches: false });
    });
    expect(result.current).toBe(false);
  });

  it("removes the listener on unmount (no leaks across re-mount)", () => {
    const mq = makeMatchMedia(false);
    vi.stubGlobal("matchMedia", mq);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(listeners.length).toBe(1);
    unmount();
    expect(listeners.length).toBe(0);
  });
});
