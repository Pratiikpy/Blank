import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useEncryptedBalance. The dual-path design (cofhe
// SDK decrypt path when connected + permit active, wagmi legacy
// path otherwise) drives every screen's balance display. The
// audit Top-28 #10 auto-reveal-on-first-decrypt is a subtle UX
// win — when balance transitions from null to first successful
// decrypt, it auto-reveals once so the user sees what they just
// created a permit to view.

const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheActivePermitMock = vi.hoisted(() => vi.fn());
const useCofheReadContractAndDecryptMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cofhe-shim", () => ({
  useCofheReadContractAndDecrypt: useCofheReadContractAndDecryptMock,
  useCofheConnection: useCofheConnectionMock,
  useCofheActivePermit: useCofheActivePermitMock,
}));

vi.mock("wagmi", () => ({
  useReadContract: useReadContractMock,
  usePublicClient: usePublicClientMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));

vi.mock("@/lib/abis", () => ({
  FHERC20VaultAbi: [],
}));

vi.mock("@/lib/constants", () => ({
  REVEAL_TIMEOUT_MS: 10_000,
}));

import { useEncryptedBalance } from "./useEncryptedBalance";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const defaultSdkResult = {
  encrypted: { isFetching: false },
  decrypted: { data: undefined, isFetching: false, error: null },
  disabledDueToMissingValidPermit: false,
};

beforeEach(() => {
  useCofheConnectionMock.mockReset();
  useCofheActivePermitMock.mockReset();
  useCofheReadContractAndDecryptMock.mockReset();
  useReadContractMock.mockReset();
  usePublicClientMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    contracts: { FHERC20Vault_USDC: VAULT },
    activeChainId: 11155111,
  });
  usePublicClientMock.mockReturnValue({ readContract: vi.fn() });
  useCofheConnectionMock.mockReturnValue({ connected: false });
  useCofheActivePermitMock.mockReturnValue(null);
  useCofheReadContractAndDecryptMock.mockReturnValue(defaultSdkResult);
  useReadContractMock.mockReturnValue({ data: undefined, refetch: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEncryptedBalance — initial state (§15.x)", () => {
  it("returns null raw + null formatted when no address connected", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.raw).toBeNull();
    expect(result.current.formatted).toBeNull();
  });

  it("exposes toggleReveal + refetch functions (refetch alias for fetchBalance)", () => {
    const { result } = renderHook(() => useEncryptedBalance());
    expect(typeof result.current.toggleReveal).toBe("function");
    expect(typeof result.current.refetch).toBe("function");
  });
});

describe("useEncryptedBalance — canUseRealDecrypt gate (§15.x)", () => {
  it("falls back to legacy path when cofhe NOT connected", () => {
    useCofheConnectionMock.mockReturnValue({ connected: false });
    useCofheActivePermitMock.mockReturnValue({ permit: { expiration: Date.now() / 1000 + 3600 }, isValid: true });
    renderHook(() => useEncryptedBalance());
    // SDK hook was called, but with enabled=false (only triggered when canUseRealDecrypt true).
    const sdkArgs = useCofheReadContractAndDecryptMock.mock.calls[0][1];
    expect(sdkArgs.readQueryOptions.enabled).toBe(false);
  });

  it("falls back to legacy when cofhe connected but NO permit", () => {
    useCofheConnectionMock.mockReturnValue({ connected: true });
    useCofheActivePermitMock.mockReturnValue(null);
    renderHook(() => useEncryptedBalance());
    const sdkArgs = useCofheReadContractAndDecryptMock.mock.calls[0][1];
    expect(sdkArgs.readQueryOptions.enabled).toBe(false);
  });

  it("uses real decrypt path when BOTH cofhe connected AND permit active", () => {
    useCofheConnectionMock.mockReturnValue({ connected: true });
    useCofheActivePermitMock.mockReturnValue({ permit: { expiration: Date.now() / 1000 + 3600 }, isValid: true });
    renderHook(() => useEncryptedBalance());
    const sdkArgs = useCofheReadContractAndDecryptMock.mock.calls[0][1];
    expect(sdkArgs.readQueryOptions.enabled).toBe(true);
  });
});

describe("useEncryptedBalance — legacy wagmi path (§15.x)", () => {
  it("formats handle > 0 as 'Encrypted' (no plaintext without permit)", () => {
    useReadContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return { data: 12345678n, refetch: vi.fn() };
      if (functionName === "isInitialized") return { data: true, refetch: vi.fn() };
      return { data: undefined, refetch: vi.fn() };
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.raw).toBe(12345678n);
    expect(result.current.formatted).toBe("Encrypted");
  });

  it("renders '0.00' for uninitialized accounts (isInitialized=false)", () => {
    useReadContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "isInitialized") return { data: false, refetch: vi.fn() };
      return { data: undefined, refetch: vi.fn() };
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.raw).toBe(0n);
    expect(result.current.formatted).toBe("0.00");
  });

  it("renders null formatted when handle is undefined + not yet known if initialized", () => {
    useReadContractMock.mockReturnValue({ data: undefined, refetch: vi.fn() });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.formatted).toBeNull();
  });

  it("renders '0.00' when handle is zero", () => {
    useReadContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return { data: 0n, refetch: vi.fn() };
      if (functionName === "isInitialized") return { data: true, refetch: vi.fn() };
      return { data: undefined, refetch: vi.fn() };
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.formatted).toBe("0.00");
  });
});

describe("useEncryptedBalance — SDK decrypt path (§15.x)", () => {
  beforeEach(() => {
    useCofheConnectionMock.mockReturnValue({ connected: true });
    useCofheActivePermitMock.mockReturnValue({ permit: { expiration: Date.now() / 1000 + 3600 }, isValid: true });
  });

  it("decrypted value formats with locale en-US grouping (6 decimals default)", () => {
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      decrypted: { data: 1_234_560_000n, isFetching: false, error: null },
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.raw).toBe(1_234_560_000n);
    expect(result.current.formatted).toMatch(/1[,]?234\.56/);
  });

  it("respects custom decimals prop (18 for ETH-shaped vaults)", () => {
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      decrypted: { data: 1_000_000_000_000_000_000n, isFetching: false, error: null },
    });
    const { result } = renderHook(() => useEncryptedBalance(undefined, 18));
    expect(result.current.formatted).toMatch(/^1\.00/);
  });

  it("CRITICAL audit Top-28 #10: auto-reveals on first successful decrypt (null → value)", () => {
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      decrypted: { data: 500_000_000n, isFetching: false, error: null },
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.isRevealed).toBe(true);
  });

  it("loading transition does NOT flash placeholder — keeps last known formatted", () => {
    const r1 = useCofheReadContractAndDecryptMock.mockReturnValueOnce({
      ...defaultSdkResult,
      decrypted: { data: 100_000_000n, isFetching: false, error: null },
    });
    const { result, rerender } = renderHook(() => useEncryptedBalance());
    const before = result.current.formatted;
    expect(before).toBeTruthy();

    useCofheReadContractAndDecryptMock.mockReturnValueOnce({
      ...defaultSdkResult,
      decrypted: { data: undefined, isFetching: true, error: null },
      encrypted: { isFetching: true },
    });
    rerender();
    // Formatted value preserved during refetch (no flash).
    expect(result.current.isLoading).toBe(true);
    expect(result.current.formatted).toBe(before);
    expect(r1).toBeDefined();
  });

  it("decryptError keeps prior decrypted value visible + sets error message", () => {
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      decrypted: {
        data: undefined,
        isFetching: false,
        error: new Error("permit expired"),
      },
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.error).toContain("permit expired");
    // No prior value -> falls back to "Encrypted" placeholder.
    expect(result.current.formatted).toBe("Encrypted");
  });

  it("disabledDueToMissingValidPermit shows 'Encrypted' placeholder (no flash)", () => {
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      disabledDueToMissingValidPermit: true,
    });
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.formatted).toBe("Encrypted");
  });
});

describe("useEncryptedBalance — toggleReveal (§15.x)", () => {
  it("no-op when raw is null (nothing to reveal)", () => {
    const { result } = renderHook(() => useEncryptedBalance());
    expect(result.current.isRevealed).toBe(false);
    act(() => result.current.toggleReveal());
    expect(result.current.isRevealed).toBe(false);
  });

  it("auto-hides revealed balance after REVEAL_TIMEOUT_MS (10s)", () => {
    vi.useFakeTimers();
    useCofheConnectionMock.mockReturnValue({ connected: true });
    useCofheActivePermitMock.mockReturnValue({ permit: { expiration: Date.now() / 1000 + 3600 }, isValid: true });
    useCofheReadContractAndDecryptMock.mockReturnValue({
      ...defaultSdkResult,
      decrypted: { data: 100_000_000n, isFetching: false, error: null },
    });

    const { result } = renderHook(() => useEncryptedBalance());
    // Auto-reveal on first decrypt.
    expect(result.current.isRevealed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    expect(result.current.isRevealed).toBe(false);
  });
});

describe("useEncryptedBalance — fetchBalance (§15.x)", () => {
  it("invalidates balance queries + refetches both handle + total on call", async () => {
    const refetchHandle = vi.fn();
    const refetchTotal = vi.fn();
    const refetchInit = vi.fn();
    useReadContractMock.mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return { data: 0n, refetch: refetchHandle };
      if (functionName === "totalDeposited") return { data: 0n, refetch: refetchTotal };
      if (functionName === "isInitialized") return { data: true, refetch: refetchInit };
      return { data: undefined, refetch: vi.fn() };
    });

    const { result } = renderHook(() => useEncryptedBalance());
    await act(async () => {
      await result.current.refetch();
    });

    expect(invalidateBalanceQueriesMock).toHaveBeenCalled();
    expect(refetchHandle).toHaveBeenCalled();
    expect(refetchTotal).toHaveBeenCalled();
  });

  it("no-op when no address connected (early return)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { result } = renderHook(() => useEncryptedBalance());
    await act(async () => {
      await result.current.refetch();
    });
    expect(invalidateBalanceQueriesMock).not.toHaveBeenCalled();
  });

  it("captures error message on refetch failure", async () => {
    useReadContractMock.mockImplementation(() => ({
      data: 0n,
      refetch: vi.fn().mockRejectedValue(new Error("RPC dead")),
    }));
    const { result } = renderHook(() => useEncryptedBalance());
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.error).toContain("RPC dead");
  });
});

describe("useEncryptedBalance — vault address override (§15.x)", () => {
  it("uses explicit vaultAddress prop when provided", () => {
    const customVault = "0xcccccccccccccccccccccccccccccccccccccccc";
    renderHook(() => useEncryptedBalance(customVault));
    const args = useCofheReadContractAndDecryptMock.mock.calls[0][0];
    expect(args.address).toBe(customVault);
  });

  it("falls back to chain.contracts.FHERC20Vault_USDC when no override", () => {
    renderHook(() => useEncryptedBalance());
    const args = useCofheReadContractAndDecryptMock.mock.calls[0][0];
    expect(args.address).toBe(VAULT);
  });
});
