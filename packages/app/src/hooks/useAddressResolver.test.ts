import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/address-resolver", () => ({
  resolveName: vi.fn(),
  lookupName: vi.fn(),
  looksLikeEnsName: vi.fn(),
}));

import { useResolveName, useLookupName } from "./useAddressResolver";
import { resolveName, lookupName, looksLikeEnsName } from "@/lib/address-resolver";

const resolveNameMock = resolveName as unknown as ReturnType<typeof vi.fn>;
const lookupNameMock = lookupName as unknown as ReturnType<typeof vi.fn>;
const looksLikeEnsNameMock = looksLikeEnsName as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  resolveNameMock.mockReset();
  lookupNameMock.mockReset();
  looksLikeEnsNameMock.mockReset();
});

describe("useResolveName (§15.x)", () => {
  it("does NOT fire the resolver when the input doesn't look like an ENS name", () => {
    looksLikeEnsNameMock.mockReturnValue(false);
    renderHook(() => useResolveName("0xabc"), { wrapper });
    expect(resolveNameMock).not.toHaveBeenCalled();
  });

  it("does NOT fire when input is null or empty", () => {
    looksLikeEnsNameMock.mockReturnValue(false);
    renderHook(() => useResolveName(null), { wrapper });
    expect(resolveNameMock).not.toHaveBeenCalled();
  });

  it("fires the resolver when input looks like an ENS name", async () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    resolveNameMock.mockResolvedValue("0xabc1234567890abcdef1234567890abcdef12345678");

    const { result } = renderHook(() => useResolveName("alice.eth"), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toBe("0xabc1234567890abcdef1234567890abcdef12345678");
    });
    expect(resolveNameMock).toHaveBeenCalledTimes(1);
    expect(resolveNameMock).toHaveBeenCalledWith("alice.eth");
  });

  it("trims whitespace before resolution", async () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    resolveNameMock.mockResolvedValue("0x" + "0".repeat(40));

    renderHook(() => useResolveName("  alice.eth  "), { wrapper });
    await waitFor(() => expect(resolveNameMock).toHaveBeenCalled());
    expect(resolveNameMock).toHaveBeenCalledWith("alice.eth");
  });
});

describe("useLookupName (§15.x)", () => {
  it("does NOT fire when address is null/undefined", () => {
    renderHook(() => useLookupName(null), { wrapper });
    expect(lookupNameMock).not.toHaveBeenCalled();
  });

  it("does NOT fire on a malformed address", () => {
    // isAddress("0xnope") returns false; query stays disabled.
    renderHook(() => useLookupName("0xnope" as `0x${string}`), { wrapper });
    expect(lookupNameMock).not.toHaveBeenCalled();
  });

  it("fires when address is well-formed", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
    lookupNameMock.mockResolvedValue("alice.eth");
    const { result } = renderHook(() => useLookupName(addr), { wrapper });
    await waitFor(() => expect(result.current.data).toBe("alice.eth"));
    expect(lookupNameMock).toHaveBeenCalledWith(addr);
  });
});
