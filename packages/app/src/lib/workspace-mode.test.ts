import { describe, it, expect, beforeEach } from "vitest";
import {
  type WorkspaceMode,
  WORKSPACE_MODES,
  getMode,
  setMode,
  subscribe,
} from "./workspace-mode";

describe("workspace-mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("getMode returns 'full' when nothing is stored", () => {
    expect(getMode()).toBe("full");
  });

  it("getMode rejects garbage in localStorage and falls back to default", () => {
    window.localStorage.setItem("blank_workspace_mode", "wizard");
    expect(getMode()).toBe("full");
  });

  it("setMode persists each valid mode and getMode reads it back", () => {
    for (const m of WORKSPACE_MODES) {
      setMode(m);
      expect(getMode()).toBe(m);
    }
  });

  it("setMode is idempotent — same value doesn't fire subscribers", () => {
    setMode("freelancer");
    let calls = 0;
    const off = subscribe(() => {
      calls++;
    });
    setMode("freelancer"); // no-op
    setMode("freelancer"); // no-op
    expect(calls).toBe(0);
    off();
  });

  it("subscribe fires on same-tab change", () => {
    const seen: WorkspaceMode[] = [];
    const off = subscribe((m) => seen.push(m));
    setMode("freelancer");
    setMode("business");
    setMode("privacy");
    expect(seen).toEqual(["freelancer", "business", "privacy"]);
    off();
  });

  it("unsubscribe stops further notifications", () => {
    let calls = 0;
    const off = subscribe(() => {
      calls++;
    });
    setMode("freelancer");
    expect(calls).toBe(1);
    off();
    setMode("business");
    expect(calls).toBe(1);
  });

  it("setMode rejects invalid values silently (no throw, no persist)", () => {
    setMode("freelancer");
    // @ts-expect-error — verifying runtime guard
    setMode("hacker");
    expect(getMode()).toBe("freelancer");
  });
});
