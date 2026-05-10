import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for GlobalCounter. Pins the 4-state UI (not-connected /
// chain-mismatch / loading / loaded) and the chain-tabs that switch
// between Sepolia and Base Sepolia counters. Each chain has its own
// PaymentReceipts contract + cofhe network, so we cannot aggregate
// them in one read — getting the tab routing wrong would silently
// display one chain's volume against another chain's label.

const useAccountMock = vi.hoisted(() => vi.fn());
const useChainIdMock = vi.hoisted(() => vi.fn());
const useSwitchChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useChainHookMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheDecryptForViewMock = vi.hoisted(() => vi.fn());
const setActiveChainMock = vi.hoisted(() => vi.fn());
const switchChainMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useChainId: useChainIdMock,
  useSwitchChain: useSwitchChainMock,
  usePublicClient: usePublicClientMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainHookMock,
}));

vi.mock("@/lib/cofhe-shim", () => ({
  useCofheConnection: useCofheConnectionMock,
  useCofheDecryptForView: useCofheDecryptForViewMock,
}));

vi.mock("@/lib/abis", () => ({
  PaymentReceiptsAbi: [],
}));

vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), error: vi.fn() },
}));

// Stub out the imported CSS file (vitest doesn't process CSS).
vi.mock("./global-counter.css", () => ({}));

import { GlobalCounter } from "./GlobalCounter";

const ETH_SEPOLIA = {
  id: 11155111,
  name: "Ethereum Sepolia",
  shortName: "Sepolia",
};
const BASE_SEPOLIA = {
  id: 84532,
  name: "Base Sepolia",
  shortName: "Base Sepolia",
};

const PR_ADDR = "0xpaymentReceiptsAddress00000000000000000000";

const readContractMock = vi.fn();
const decryptForViewMock = vi.fn();

beforeEach(() => {
  useAccountMock.mockReset();
  useChainIdMock.mockReset();
  useSwitchChainMock.mockReset();
  usePublicClientMock.mockReset();
  useChainHookMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheDecryptForViewMock.mockReset();
  setActiveChainMock.mockReset();
  switchChainMock.mockReset();
  readContractMock.mockReset();
  decryptForViewMock.mockReset();

  // Sane defaults: connected, on the right chain, cofhe ready.
  useAccountMock.mockReturnValue({ isConnected: true });
  useChainIdMock.mockReturnValue(11155111);
  useSwitchChainMock.mockReturnValue({ switchChain: switchChainMock });
  useChainHookMock.mockReturnValue({
    activeChain: ETH_SEPOLIA,
    activeChainId: 11155111,
    contracts: { PaymentReceipts: PR_ADDR },
    availableChains: [ETH_SEPOLIA, BASE_SEPOLIA],
    setActiveChain: setActiveChainMock,
  });
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheDecryptForViewMock.mockReturnValue({ decryptForView: decryptForViewMock });
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GlobalCounter — 4-state UI (§15.x)", () => {
  it("shows 'Connect to view live counter' when wallet not connected", () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    const { container } = render(<GlobalCounter />);
    expect(container.textContent).toContain("Connect to view live counter");
    // Should NOT call decrypt when not connected.
    expect(decryptForViewMock).not.toHaveBeenCalled();
  });

  it("shows 'Switch wallet to <chain>' when wallet chain != active chain", () => {
    useChainIdMock.mockReturnValue(84532); // wallet on Base
    useChainHookMock.mockReturnValue({
      activeChain: ETH_SEPOLIA, // active tab on Sepolia
      activeChainId: 11155111,
      contracts: { PaymentReceipts: PR_ADDR },
      availableChains: [ETH_SEPOLIA, BASE_SEPOLIA],
      setActiveChain: setActiveChainMock,
    });
    const { container } = render(<GlobalCounter />);
    expect(container.textContent).toContain("Switch wallet to Ethereum Sepolia");
    // Should NOT call decrypt during chain mismatch.
    expect(decryptForViewMock).not.toHaveBeenCalled();
  });

  it("renders a 'Switch wallet' CTA button when chain mismatched", () => {
    useChainIdMock.mockReturnValue(84532);
    useChainHookMock.mockReturnValue({
      activeChain: ETH_SEPOLIA,
      activeChainId: 11155111,
      contracts: { PaymentReceipts: PR_ADDR },
      availableChains: [ETH_SEPOLIA, BASE_SEPOLIA],
      setActiveChain: setActiveChainMock,
    });
    const { container } = render(<GlobalCounter />);
    const cta = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Switch wallet"),
    );
    expect(cta).toBeDefined();
    fireEvent.click(cta!);
    expect(switchChainMock).toHaveBeenCalledWith({ chainId: 11155111 });
  });

  it("shows formatted volume + tx count when decrypt resolves", async () => {
    // 1.5M USDC in 6-decimal handle units.
    readContractMock.mockResolvedValue(1n);
    decryptForViewMock.mockImplementation(async (_handle: bigint) => {
      // First call: volume. Second call: tx count.
      if (decryptForViewMock.mock.calls.length === 1) return 1_500_000_000_000n; // $1.5M
      return 42n;
    });

    const { container } = render(<GlobalCounter />);
    await act(async () => {
      // Flush the refresh microtasks.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Source uses toLocaleString(undefined, ...) which is locale-aware.
    // Assert on a locale-agnostic shape: a "$" + digits + ".00" sequence.
    expect(container.textContent).toMatch(/\$[\d,]+\.00/);
    // Ends with .00 (the 2-decimal format).
    expect(container.textContent).toContain(".00");
    expect(container.textContent).toContain("42");
  });

  it("shows the spinner while loading + connected + same chain (initial state)", () => {
    // readContract never resolves — keeps loading=true.
    readContractMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<GlobalCounter />);
    // Loader2 is the lucide spin icon — has the .animate-spin class.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("GlobalCounter — chain tabs (§15.x)", () => {
  it("renders one tab per available chain when multiple chains supported", () => {
    const { container } = render(<GlobalCounter />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toBe("Sepolia");
    expect(tabs[1].textContent).toBe("Base Sepolia");
  });

  it("active tab gets aria-selected=true", () => {
    const { container } = render(<GlobalCounter />);
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a non-active tab calls setActiveChain with that chainId", () => {
    const { container } = render(<GlobalCounter />);
    const baseSepoliaTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === "Base Sepolia") as HTMLElement;
    fireEvent.click(baseSepoliaTab);
    expect(setActiveChainMock).toHaveBeenCalledWith(84532);
  });

  it("clicking the ALREADY-active tab is a no-op (no setActiveChain call)", () => {
    const { container } = render(<GlobalCounter />);
    const sepoliaTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent === "Sepolia") as HTMLElement;
    fireEvent.click(sepoliaTab);
    expect(setActiveChainMock).not.toHaveBeenCalled();
  });

  it("hides the chain-tab row when only ONE chain is supported", () => {
    useChainHookMock.mockReturnValue({
      activeChain: ETH_SEPOLIA,
      activeChainId: 11155111,
      contracts: { PaymentReceipts: PR_ADDR },
      availableChains: [ETH_SEPOLIA],
      setActiveChain: setActiveChainMock,
    });
    const { container } = render(<GlobalCounter />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});

describe("GlobalCounter — copy + accessibility (§15.x)", () => {
  it("section has an aria-label='Live encrypted volume'", () => {
    const { container } = render(<GlobalCounter />);
    const section = container.querySelector("section");
    expect(section?.getAttribute("aria-label")).toBe("Live encrypted volume");
  });

  it("includes the chain name in the volume + tx-count labels", () => {
    const { container } = render(<GlobalCounter />);
    expect(container.textContent).toContain("Encrypted USDC moved on Ethereum Sepolia");
    expect(container.textContent).toContain("Receipts issued on Ethereum Sepolia");
  });

  it("includes the FHE.allowGlobal explainer copy + verifiability claim", () => {
    const { container } = render(<GlobalCounter />);
    expect(container.textContent).toContain("FHE.allowGlobal");
    expect(container.textContent).toContain("verify the total without learning any individual amount");
  });

  it("appends 'Connect a wallet to see live data' hint when not connected", () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    const { container } = render(<GlobalCounter />);
    expect(container.textContent).toContain("Connect a wallet to see live data");
  });
});
