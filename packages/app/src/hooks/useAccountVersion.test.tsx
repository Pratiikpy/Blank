import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// §15.x test for useAccountVersion. The 6-state status ladder
// (no-account / no-canonical / not-deployed / unknown / current /
// needs-upgrade) is the load-bearing surface; only "needs-upgrade"
// shows the upgrade banner, everything else stays silent. A regression
// that flips "current" → "needs-upgrade" would prompt every user to
// upgrade on every load.

const getCodeMock = vi.hoisted(() => vi.fn());
const getStorageAtMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: () => ({
    getCode: getCodeMock,
    getStorageAt: getStorageAtMock,
  }),
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

import { useAccountVersion } from "./useAccountVersion";

const PROXY_ADDR = "0xCcccCccCCCCcCCCcCccccCcCcccCCCcCCCcCCCCc";
const CANONICAL_IMPL = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_IMPL = "0xbbBBbBBbbBBBBbBBbBBbBBbBbbBbbBBBbBbbBBBb";
const ZERO = "0x0000000000000000000000000000000000000000";

function slot32(addr: string) {
  // 32-byte slot: 12 leading zero bytes + 20-byte address.
  return `0x${"00".repeat(12)}${addr.slice(2)}` as `0x${string}`;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getCodeMock.mockReset();
  getStorageAtMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();

  // Sensible defaults: smart account at PROXY_ADDR + canonical impl set.
  useEffectiveAddressMock.mockReturnValue({
    effectiveAddress: PROXY_ADDR,
    isSmartAccount: true,
  });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { BlankAccount_Impl_v041: CANONICAL_IMPL },
  });
});

describe("useAccountVersion — status ladder (§15.x)", () => {
  it("returns 'no-account' when user is on EOA (not smart account)", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: "0xeoa0000000000000000000000000000000000000",
      isSmartAccount: false,
    });
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    expect(result.current.status).toBe("no-account");
    expect(getCodeMock).not.toHaveBeenCalled();
  });

  it("returns 'no-account' when effectiveAddress is null", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      isSmartAccount: true,
    });
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    expect(result.current.status).toBe("no-account");
  });

  it("returns 'no-canonical' when BlankAccount_Impl_v041 is not deployed on chain", () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: {},
    });
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    expect(result.current.status).toBe("no-canonical");
    expect(getCodeMock).not.toHaveBeenCalled();
  });

  it("returns 'not-deployed' when the proxy has no code yet (counterfactual)", async () => {
    getCodeMock.mockResolvedValue("0x");
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("not-deployed"));
    expect(getStorageAtMock).not.toHaveBeenCalled();
  });

  it("returns 'current' when impl slot equals canonical impl", async () => {
    getCodeMock.mockResolvedValue("0xabcdef");
    getStorageAtMock.mockResolvedValue(slot32(CANONICAL_IMPL));
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("current"));
    expect(result.current.currentImpl?.toLowerCase()).toBe(CANONICAL_IMPL.toLowerCase());
  });

  it("returns 'needs-upgrade' when impl slot differs from canonical", async () => {
    getCodeMock.mockResolvedValue("0xabcdef");
    getStorageAtMock.mockResolvedValue(slot32(OLD_IMPL));
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("needs-upgrade"));
    expect(result.current.currentImpl?.toLowerCase()).toBe(OLD_IMPL.toLowerCase());
  });

  it("treats impl-vs-canonical comparison as case-insensitive", async () => {
    getCodeMock.mockResolvedValue("0xabcdef");
    // Stored impl is the same address as canonical but with different
    // checksum casing — must still resolve to "current".
    getStorageAtMock.mockResolvedValue(slot32(CANONICAL_IMPL.toUpperCase()));
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("current"));
  });

  it("returns 'unknown' when impl slot reads zero (uninitialized proxy)", async () => {
    getCodeMock.mockResolvedValue("0xabcdef");
    getStorageAtMock.mockResolvedValue(slot32(ZERO));
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe("unknown");
    expect(result.current.currentImpl).toBeNull();
  });

  it("returns 'unknown' when storage read returns null/undefined", async () => {
    getCodeMock.mockResolvedValue("0xabcdef");
    getStorageAtMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe("unknown");
  });

  it("exposes the canonical impl address from useChain.contracts", () => {
    const { result } = renderHook(() => useAccountVersion(), { wrapper });
    expect(result.current.canonicalImpl).toBe(CANONICAL_IMPL);
  });
});
