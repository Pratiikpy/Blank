import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Mocks BEFORE importing the SUT. Both useAccount + useSmartAccount
// are leaf consumers; we control their return values per test.
vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
}));
vi.mock("./useSmartAccount", () => ({
  useSmartAccount: vi.fn(),
}));

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useAccount } from "wagmi";
import { useSmartAccount } from "./useSmartAccount";

const useAccountMock = useAccount as unknown as ReturnType<typeof vi.fn>;
const useSmartAccountMock = useSmartAccount as unknown as ReturnType<typeof vi.fn>;

const EOA = "0xEEEEeEEeeEEeEEeEEEEEEEEeeeeEeEeeEEEeEeEe";
const SMART = "0x5555555555555555555555555555555555555555";

beforeEach(() => {
  useAccountMock.mockReset();
  useSmartAccountMock.mockReset();
});

describe("useEffectiveAddress (§15.2.1)", () => {
  it("returns the smart-account address when AA is ready", () => {
    useAccountMock.mockReturnValue({ address: EOA });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SMART },
    });

    const { result } = renderHook(() => useEffectiveAddress());
    expect(result.current.effectiveAddress).toBe(SMART);
    expect(result.current.eoa).toBe(EOA);
    expect(result.current.isSmartAccount).toBe(true);
  });

  it("falls back to the EOA when smart-account is not ready", () => {
    useAccountMock.mockReturnValue({ address: EOA });
    useSmartAccountMock.mockReturnValue({
      status: "loading",
      account: null,
    });

    const { result } = renderHook(() => useEffectiveAddress());
    expect(result.current.effectiveAddress).toBe(EOA);
    expect(result.current.isSmartAccount).toBe(false);
  });

  it("falls back to EOA when smart-account is ready but account is null", () => {
    useAccountMock.mockReturnValue({ address: EOA });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: null,
    });

    const { result } = renderHook(() => useEffectiveAddress());
    expect(result.current.effectiveAddress).toBe(EOA);
    expect(result.current.isSmartAccount).toBe(false);
  });

  it("returns undefined when neither EOA nor smart-account is connected", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    useSmartAccountMock.mockReturnValue({
      status: "idle",
      account: null,
    });

    const { result } = renderHook(() => useEffectiveAddress());
    expect(result.current.effectiveAddress).toBeUndefined();
    expect(result.current.isSmartAccount).toBe(false);
  });

  it("exposes raw eoa + smartAccount alongside the resolved effective address", () => {
    // Some callers (EOA-only ETH balance, AA admin tabs) need the
    // pre-resolution values explicitly. Pin the return shape.
    useAccountMock.mockReturnValue({ address: EOA });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SMART },
    });

    const { result } = renderHook(() => useEffectiveAddress());
    expect(result.current.eoa).toBe(EOA);
    expect(result.current.smartAccount.account?.address).toBe(SMART);
  });
});
