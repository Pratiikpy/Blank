import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
// react is used implicitly via JSX


// Mock cofhe-shim BEFORE importing the SUT.
vi.mock("@/lib/cofhe-shim", () => ({
  _setActiveChainForShim: vi.fn(),
  _resetSdkForChainChange: vi.fn(),
}));

import { CofheProvider } from "./CofheProvider";
import { ChainProvider, useChain } from "./ChainProvider";
import {
  _setActiveChainForShim,
  _resetSdkForChainChange,
} from "@/lib/cofhe-shim";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "@/lib/constants";

const setShimMock = _setActiveChainForShim as unknown as ReturnType<typeof vi.fn>;
const resetSdkMock = _resetSdkForChainChange as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setShimMock.mockReset();
  resetSdkMock.mockReset();
});

describe("CofheProvider (§15.x)", () => {
  it("calls _setActiveChainForShim + _resetSdkForChainChange on mount", () => {
    render(
      <ChainProvider>
        <CofheProvider>
          <div>child</div>
        </CofheProvider>
      </ChainProvider>,
    );
    expect(setShimMock).toHaveBeenCalledTimes(1);
    expect(resetSdkMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires both functions when activeChainId changes (chain switch)", () => {
    let switchTo: ((id: typeof ETH_SEPOLIA_ID | typeof BASE_SEPOLIA_ID) => void) | null = null;
    function Trigger() {
      const { setActiveChain } = useChain();
      switchTo = setActiveChain;
      return null;
    }

    render(
      <ChainProvider>
        <CofheProvider>
          <Trigger />
        </CofheProvider>
      </ChainProvider>,
    );
    expect(setShimMock).toHaveBeenCalledTimes(1);

    act(() => {
      switchTo!(BASE_SEPOLIA_ID);
    });
    expect(setShimMock).toHaveBeenCalledTimes(2);
    expect(setShimMock).toHaveBeenLastCalledWith(BASE_SEPOLIA_ID);
    expect(resetSdkMock).toHaveBeenCalledTimes(2);

    act(() => {
      switchTo!(ETH_SEPOLIA_ID);
    });
    expect(setShimMock).toHaveBeenCalledTimes(3);
    expect(setShimMock).toHaveBeenLastCalledWith(ETH_SEPOLIA_ID);
  });

  it("renders children unchanged (no DOM wrapping)", () => {
    const { getByText } = render(
      <ChainProvider>
        <CofheProvider>
          <div>cofhe-child-marker</div>
        </CofheProvider>
      </ChainProvider>,
    );
    expect(getByText("cofhe-child-marker")).toBeDefined();
  });
});
