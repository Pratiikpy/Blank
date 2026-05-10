import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock react-hot-toast BEFORE importing the SUT so the test verifies
// requireShieldedBalance's return value AND that it fires the toast
// only on the blocked branch.
vi.mock("react-hot-toast", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { requireShieldedBalance } from "./shield-check";
import toast from "react-hot-toast";

const toastErrorMock = (toast as unknown as { error: ReturnType<typeof vi.fn> }).error;

beforeEach(() => {
  toastErrorMock.mockReset();
});

describe("requireShieldedBalance", () => {
  it("returns false (not blocked) when hasBalance is true", () => {
    expect(requireShieldedBalance(true)).toBe(false);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("returns true (blocked) and fires toast when hasBalance is false", () => {
    expect(requireShieldedBalance(false)).toBe(true);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it("returns true (blocked) and fires toast when hasBalance is undefined (still loading)", () => {
    // Treating "loading" as "blocked" is intentional: a user who hits
    // a shield-required action before the balance has loaded should
    // see the prompt to shield, not silently proceed with a call
    // that may revert.
    expect(requireShieldedBalance(undefined)).toBe(true);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it("toast message guides the user to the right place", () => {
    requireShieldedBalance(false);
    const [msg] = toastErrorMock.mock.calls[0] as [string];
    expect(msg).toContain("shield");
    expect(msg).toContain("Dashboard");
  });
});
