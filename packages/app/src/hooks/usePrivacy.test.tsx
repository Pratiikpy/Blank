import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { STORAGE_KEYS } from "@/lib/storage";

// §15.x test for usePrivacy. Pin the seconds-to-ms expiration
// conversion (line 60-61 of the source), the 1-hour isExpiringSoon
// threshold, and the localStorage-backed sharedPermits CRUD with
// case-insensitive address normalization.

const activePermitMock = vi.hoisted(() => vi.fn());
const navigateToCreateMock = vi.hoisted(() => vi.fn());
const useAccountMock = vi.hoisted(() => vi.fn());
const useDisconnectMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  default: vi.fn(),
}));

vi.mock("@/lib/cofhe-shim", () => ({
  useCofheActivePermit: activePermitMock,
  useCofheNavigateToCreatePermit: () => navigateToCreateMock,
}));

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useDisconnect: useDisconnectMock,
}));

vi.mock("react-hot-toast", () => {
  const toast = Object.assign(toastMock.default, {
    success: toastMock.success,
    error: toastMock.error,
  });
  return { default: toast };
});

import { usePrivacy } from "./usePrivacy";

const ME = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbBBbBBBbBBBBbbBbBBBBbbbbBBBBBBBBBbbBbBb";

const NOW_MS = 1_700_000_000_000; // arbitrary fixed "now"
const NOW_SEC = NOW_MS / 1000;

beforeEach(() => {
  localStorage.clear();
  activePermitMock.mockReset();
  navigateToCreateMock.mockReset();
  useAccountMock.mockReset();
  useDisconnectMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.default.mockReset();

  useAccountMock.mockReturnValue({ address: ME });
  useDisconnectMock.mockReturnValue({ disconnect: vi.fn() });
  activePermitMock.mockReturnValue(null);

  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});

describe("usePrivacy — permit state (§15.x)", () => {
  it("hasPermit=false when active permit is null", () => {
    activePermitMock.mockReturnValue(null);
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.hasPermit).toBe(false);
    expect(result.current.permitExpiresAt).toBeNull();
  });

  it("hasPermit=false when activePermitData.isValid is false", () => {
    activePermitMock.mockReturnValue({
      isValid: false,
      permit: { expiration: NOW_SEC + 86_400 },
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.hasPermit).toBe(false);
  });

  it("hasPermit=true when activePermitData.isValid is true", () => {
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: NOW_SEC + 86_400 },
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.hasPermit).toBe(true);
  });

  it("permitExpiresAt converts SDK seconds to UI milliseconds", () => {
    const expirationSec = NOW_SEC + 3600;
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: expirationSec },
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.permitExpiresAt).toBe(expirationSec * 1000);
  });

  it("isExpiringSoon=true when permit is < 1 hour away (but not yet expired)", () => {
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: NOW_SEC + 30 * 60 }, // 30 min away
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.isExpiringSoon).toBe(true);
    expect(result.current.isExpired).toBe(false);
  });

  it("isExpiringSoon=false when permit is > 1 hour away", () => {
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: NOW_SEC + 2 * 3600 }, // 2 hours
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.isExpiringSoon).toBe(false);
  });

  it("isExpired=true when permit expiration <= now", () => {
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: NOW_SEC - 60 },
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.isExpired).toBe(true);
    // And isExpiringSoon must be false when already past expiration.
    expect(result.current.isExpiringSoon).toBe(false);
  });

  it("permitCreatedAt is null (SDK doesn't expose creation time)", () => {
    activePermitMock.mockReturnValue({
      isValid: true,
      permit: { expiration: NOW_SEC + 86_400 },
    });
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.permitCreatedAt).toBeNull();
  });
});

describe("usePrivacy — sharedPermits CRUD (§15.x)", () => {
  it("starts with empty sharedPermits", () => {
    const { result } = renderHook(() => usePrivacy());
    expect(result.current.sharedPermits).toEqual([]);
  });

  it("sharePermit normalizes target address to lowercase before storing", async () => {
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.sharePermit(BOB.toUpperCase(), "full", 24);
    });
    expect(result.current.sharedPermits).toHaveLength(1);
    expect(result.current.sharedPermits[0].address).toBe(BOB.toLowerCase());
  });

  it("sharePermit replaces an existing share for the same target (no duplicates)", async () => {
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.sharePermit(BOB, "full", 24);
      await result.current.sharePermit(BOB, "balance-proof", 48);
    });
    expect(result.current.sharedPermits).toHaveLength(1);
    expect(result.current.sharedPermits[0].accessLevel).toBe("balance-proof");
  });

  it("sharePermit encodes the correct expiresAt window (hours -> ms)", async () => {
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.sharePermit(BOB, "full", 24);
    });
    const expectedExpiry = NOW_MS + 24 * 3600 * 1000;
    expect(result.current.sharedPermits[0].expiresAt).toBe(expectedExpiry);
  });

  it("revokePermit filters out the target (case-insensitive)", async () => {
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.sharePermit(BOB, "full", 24);
    });
    expect(result.current.sharedPermits).toHaveLength(1);

    act(() => {
      result.current.revokePermit(BOB.toUpperCase());
    });
    expect(result.current.sharedPermits).toHaveLength(0);
  });

  it("filters out EXPIRED shared permits on initial load", async () => {
    // Pre-seed localStorage with one expired + one active share.
    const expired = {
      address: BOB.toLowerCase(),
      accessLevel: "full",
      expiresAt: NOW_MS - 1000, // already expired
      createdAt: NOW_MS - 86_400_000,
    };
    const active = {
      address: "0xCccCcCcccCcccCccccCcccCccCcCcccCcCccccCC".toLowerCase(),
      accessLevel: "balance-proof",
      expiresAt: NOW_MS + 86_400_000,
      createdAt: NOW_MS - 1000,
    };
    localStorage.setItem(
      STORAGE_KEYS.privacy(ME),
      JSON.stringify({ sharedPermits: [expired, active] }),
    );

    const { result } = renderHook(() => usePrivacy());
    // loadSharedPermits runs synchronously inside useState's initializer,
    // so the filtered result is available without waitFor.
    expect(result.current.sharedPermits).toHaveLength(1);
    expect(result.current.sharedPermits[0].address.toLowerCase()).toBe(active.address);
  });
});

describe("usePrivacy — createPermit (§15.x)", () => {
  it("no-ops when address is null", async () => {
    useAccountMock.mockReturnValue({ address: undefined });
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.createPermit();
    });
    expect(navigateToCreateMock).not.toHaveBeenCalled();
  });

  it("calls navigateToCreate + success toast on the happy path", async () => {
    navigateToCreateMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.createPermit();
    });
    expect(navigateToCreateMock).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("surfaces an error toast (not throw) when navigateToCreate rejects", async () => {
    navigateToCreateMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => usePrivacy());
    await act(async () => {
      await result.current.createPermit();
    });
    expect(toastMock.error).toHaveBeenCalledWith("user rejected");
  });
});
