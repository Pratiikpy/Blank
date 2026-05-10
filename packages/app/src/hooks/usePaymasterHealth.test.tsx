import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// §15.x test for usePaymasterHealth. The 4-state status ladder
// (healthy / degraded / unavailable / unknown) is the load-bearing
// surface; SendConfirm + Dashboard banner both branch on it. A
// regression that collapses fail/warn into a single boolean would
// silently let the AA31 revert surface mid-payment.

const readContractMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: () => ({ readContract: readContractMock }),
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("@/lib/userop", () => ({
  ENTRYPOINT_ABI: [],
  ENTRYPOINT_V08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
}));

import { usePaymasterHealth } from "./usePaymasterHealth";

const PAYMASTER_ADDR = "0xbBbbbBBbBbBbbbBBBBBBBBbbbBbbbBbbbbBBBBbb";

function wrapper({ children }: { children: React.ReactNode }) {
  // Disable retries so an error state shows immediately instead of
  // waiting for the 2-retry default.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  readContractMock.mockReset();
  useChainMock.mockReset();
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { BlankPaymaster: PAYMASTER_ADDR },
  });
});

describe("usePaymasterHealth — status ladder (§15.x)", () => {
  it("returns 'unavailable' when BlankPaymaster is not configured for the active chain", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: {},
    });
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    expect(result.current.configured).toBe(false);
    expect(result.current.status).toBe("unavailable");
    expect(readContractMock).not.toHaveBeenCalled();
  });

  it("returns 'healthy' when deposit >= MIN_DEPOSIT_WEI (default 5e16)", async () => {
    readContractMock.mockResolvedValue(60_000_000_000_000_000n); // 0.06 ETH
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("healthy"));
    expect(result.current.depositWei).toBe(60_000_000_000_000_000n);
  });

  it("returns 'degraded' when FAIL_DEPOSIT_WEI <= deposit < MIN_DEPOSIT_WEI (default 1e16..5e16)", async () => {
    readContractMock.mockResolvedValue(30_000_000_000_000_000n); // 0.03 ETH
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("degraded"));
  });

  it("returns 'unavailable' when deposit < FAIL_DEPOSIT_WEI (default <1e16)", async () => {
    readContractMock.mockResolvedValue(5_000_000_000_000_000n); // 0.005 ETH
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("MIN threshold boundary: deposit === MIN_DEPOSIT_WEI is 'healthy' (not 'degraded')", async () => {
    // Strict `<` in `depositWei < MIN_DEPOSIT_WEI` means equal == healthy.
    readContractMock.mockResolvedValue(50_000_000_000_000_000n);
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("healthy"));
  });

  it("FAIL threshold boundary: deposit === FAIL_DEPOSIT_WEI is 'degraded' (not 'unavailable')", async () => {
    readContractMock.mockResolvedValue(10_000_000_000_000_000n);
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("degraded"));
  });

  it("returns 'unknown' while loading (depositWei is null + no error)", async () => {
    // A never-resolving promise keeps the query in flight indefinitely.
    readContractMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    expect(result.current.depositWei).toBeNull();
    expect(result.current.status).toBe("unknown");
    expect(result.current.isLoading).toBe(true);
  });

  it("exposes the warn + fail thresholds so callers can render contextual UI", async () => {
    readContractMock.mockResolvedValue(60_000_000_000_000_000n);
    const { result } = renderHook(() => usePaymasterHealth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("healthy"));
    expect(result.current.warnThresholdWei).toBe(50_000_000_000_000_000n);
    expect(result.current.failThresholdWei).toBe(10_000_000_000_000_000n);
  });
});
