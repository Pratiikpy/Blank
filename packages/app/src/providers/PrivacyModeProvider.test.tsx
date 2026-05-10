import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import {
  PrivacyModeProvider,
  usePrivacyMode,
} from "./PrivacyModeProvider";

// §15.x test for PrivacyModeProvider. Single source of truth for
// the global "hide balances / mask amounts" toggle. Pre-fix the
// sidebar and Dashboard each held their own useState(true), so
// clicking the sidebar toggle did NOT affect Dashboard masking.

const STORAGE_KEY = "blank_privacy_mode";

beforeEach(() => {
  localStorage.clear();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(PrivacyModeProvider, null, children);
}

describe("PrivacyModeProvider (§15.x)", () => {
  it("usePrivacyMode throws when used outside the provider", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => usePrivacyMode())).toThrow(
      /must be used inside/,
    );
    errSpy.mockRestore();
  });

  it("defaults to ON when no stored value (privacy-first default)", () => {
    const { result } = renderHook(() => usePrivacyMode(), { wrapper });
    expect(result.current.privacyMode).toBe(true);
  });

  it("respects a stored 'true' value", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => usePrivacyMode(), { wrapper });
    expect(result.current.privacyMode).toBe(true);
  });

  it("respects a stored 'false' value (user explicitly opted out)", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const { result } = renderHook(() => usePrivacyMode(), { wrapper });
    expect(result.current.privacyMode).toBe(false);
  });

  it("setPrivacyMode persists to localStorage", () => {
    const { result } = renderHook(() => usePrivacyMode(), { wrapper });
    act(() => {
      result.current.setPrivacyMode(false);
    });
    expect(result.current.privacyMode).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });

  it("toggle() flips the value", () => {
    const { result } = renderHook(() => usePrivacyMode(), { wrapper });
    expect(result.current.privacyMode).toBe(true);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.privacyMode).toBe(false);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.privacyMode).toBe(true);
  });

  it("multiple consumers under the same provider see synchronous updates", () => {
    // Pre-fix bug: sidebar + Dashboard had independent useState
    // copies. Without provider, sidebar toggle didn't reach
    // Dashboard. With provider, toggle in one mount must update
    // every consumer.
    const Wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(PrivacyModeProvider, null, children);
    const { result } = renderHook(
      () => {
        const a = usePrivacyMode();
        const b = usePrivacyMode();
        return { a, b };
      },
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.a.toggle();
    });
    expect(result.current.a.privacyMode).toBe(false);
    expect(result.current.b.privacyMode).toBe(false);
  });
});
