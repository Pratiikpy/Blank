import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import {
  WorkspaceModeProvider,
  useWorkspaceMode,
} from "./WorkspaceModeProvider";
import { setMode as persistMode } from "@/lib/workspace-mode";

// §15.x test for the WorkspaceModeProvider context. Drives the
// nav-registry filter (which screens show in the sidebar
// depending on freelancer / business / privacy / full mode);
// state-leak between consumers means a Settings change doesn't
// re-render the sidebar.

beforeEach(() => {
  // Reset workspace-mode storage for each test.
  localStorage.clear();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(WorkspaceModeProvider, null, children);
}

describe("WorkspaceModeProvider (§15.x)", () => {
  it("useWorkspaceMode throws when used outside the provider", () => {
    // Suppress the React error-boundary warning for this case.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useWorkspaceMode())).toThrow(
      /must be used inside/,
    );
    errSpy.mockRestore();
  });

  it("initial mode comes from storage (default)", () => {
    const { result } = renderHook(() => useWorkspaceMode(), { wrapper });
    // Default workspace mode is "full" per workspace-mode.ts.
    expect(result.current.mode).toBe("full");
  });

  it("setMode updates the context value (same-tab subscription)", () => {
    const { result } = renderHook(() => useWorkspaceMode(), { wrapper });
    act(() => {
      result.current.setMode("freelancer");
    });
    expect(result.current.mode).toBe("freelancer");
  });

  it("multiple consumers under the same provider see the same mode", () => {
    const { result: a } = renderHook(() => useWorkspaceMode(), { wrapper });
    const { result: b } = renderHook(() => useWorkspaceMode(), { wrapper });

    act(() => {
      a.current.setMode("business");
    });

    // Both consumers should reflect the change because the same-tab
    // CustomEvent path notifies every subscriber. (This test validates
    // the cross-mount notification, NOT shared React-context across
    // separate ProviderTrees.)
    expect(a.current.mode).toBe("business");
    expect(b.current.mode).toBe("business");
  });

  it("external storage changes propagate to the context", () => {
    const { result } = renderHook(() => useWorkspaceMode(), { wrapper });
    expect(result.current.mode).toBe("full");

    // Simulate a Settings screen calling persistMode directly (e.g.
    // from a non-React code path that bypasses setMode).
    act(() => {
      persistMode("privacy");
    });
    expect(result.current.mode).toBe("privacy");
  });
});
