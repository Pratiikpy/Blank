import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { ChainProvider, useChain } from "./ChainProvider";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "@/lib/constants";

// §15.x test for ChainProvider. Drives every chain-aware code
// path: contract addresses, RPC endpoint, explorer URL, supabase
// chain_id column. State-leak between consumers OR chain not
// validating against CHAINS = cross-chain accidental routing.

beforeEach(() => {
  localStorage.clear();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(ChainProvider, null, children);
}

describe("ChainProvider (§15.x)", () => {
  it("useChain throws when used outside the provider", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useChain())).toThrow(
      /must be used inside/,
    );
    errSpy.mockRestore();
  });

  it("exposes activeChainId + activeChain + contracts + availableChains", () => {
    const { result } = renderHook(() => useChain(), { wrapper });
    expect(result.current.activeChainId).toBeTypeOf("number");
    expect(result.current.activeChain).toBeDefined();
    expect(result.current.activeChain.id).toBe(result.current.activeChainId);
    expect(result.current.contracts).toBeDefined();
    expect(result.current.availableChains.length).toBeGreaterThanOrEqual(2);
  });

  it("setActiveChain switches between Eth Sepolia and Base Sepolia", () => {
    const { result } = renderHook(() => useChain(), { wrapper });

    act(() => {
      result.current.setActiveChain(ETH_SEPOLIA_ID);
    });
    expect(result.current.activeChainId).toBe(ETH_SEPOLIA_ID);

    act(() => {
      result.current.setActiveChain(BASE_SEPOLIA_ID);
    });
    expect(result.current.activeChainId).toBe(BASE_SEPOLIA_ID);
  });

  it("setActiveChain rejects unsupported chain ids (mainnet=1)", () => {
    const { result } = renderHook(() => useChain(), { wrapper });
    const before = result.current.activeChainId;

    act(() => {
      result.current.setActiveChain(1 as 11155111);
    });
    // Stays on the prior chain — the !(id in CHAINS) guard rejected.
    expect(result.current.activeChainId).toBe(before);
  });

  it("contracts ARE per-chain (different addresses for ETH vs Base)", () => {
    const { result } = renderHook(() => useChain(), { wrapper });

    act(() => {
      result.current.setActiveChain(ETH_SEPOLIA_ID);
    });
    const ethContracts = result.current.contracts;

    act(() => {
      result.current.setActiveChain(BASE_SEPOLIA_ID);
    });
    const baseContracts = result.current.contracts;

    // The active contracts shape changes when chain changes.
    expect(ethContracts.PaymentHub).not.toBe(baseContracts.PaymentHub);
  });

  it("availableChains includes both Eth Sepolia and Base Sepolia", () => {
    const { result } = renderHook(() => useChain(), { wrapper });
    const ids = result.current.availableChains.map((c) => c.id);
    expect(ids).toContain(ETH_SEPOLIA_ID);
    expect(ids).toContain(BASE_SEPOLIA_ID);
  });

  it("multiple consumers under the same provider see synchronous updates", () => {
    const { result } = renderHook(
      () => {
        const a = useChain();
        const b = useChain();
        return { a, b };
      },
      { wrapper },
    );

    act(() => {
      result.current.a.setActiveChain(ETH_SEPOLIA_ID);
    });
    expect(result.current.a.activeChainId).toBe(ETH_SEPOLIA_ID);
    expect(result.current.b.activeChainId).toBe(ETH_SEPOLIA_ID);
  });
});
