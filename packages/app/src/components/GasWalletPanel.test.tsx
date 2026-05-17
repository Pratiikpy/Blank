import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";

// §15.x test for GasWalletPanel. Pinned invariants:
//   • Copy CTA writes the smart-account address to clipboard
//   • Live deposit balance fetched from EntryPoint.balanceOf, refreshed
//     every 10s + on Refresh click
//   • Idle balance fetched via publicClient.getBalance
//   • Auto-refresh interval is exactly 10s (REFRESH_INTERVAL_MS)
//   • "Self-paying mode active" badge appears when deposit > 0
//   • No address connected → "Connect a wallet…" empty state
//   • Read failure surfaces the raw error message inline, no toast spam

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));
vi.mock("wagmi", () => ({
  usePublicClient: usePublicClientMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { GasWalletPanel } from "./GasWalletPanel";

const SMART_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

let readContractMock: ReturnType<typeof vi.fn>;
let getBalanceMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART_ACCOUNT });
  useChainMock.mockReturnValue({
    activeChain: {
      id: 11155111,
      name: "Ethereum Sepolia",
      explorerUrl: "https://sepolia.etherscan.io",
    },
    contracts: { EntryPoint: ENTRY_POINT },
  });

  readContractMock = vi.fn().mockResolvedValue(0n);
  getBalanceMock = vi.fn().mockResolvedValue(0n);
  usePublicClientMock.mockReturnValue({
    readContract: readContractMock,
    getBalance: getBalanceMock,
  });

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
});

describe("GasWalletPanel — empty state", () => {
  it("renders 'Connect a wallet' when effectiveAddress is undefined", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<GasWalletPanel />);
    expect(container.textContent).toContain("Connect a wallet");
  });
});

describe("GasWalletPanel — copy address", () => {
  it("renders the smart-account address verbatim (full address, not truncated)", async () => {
    const { findByTestId } = render(<GasWalletPanel />);
    const el = await findByTestId("gas-wallet-address");
    expect(el.textContent).toBe(SMART_ACCOUNT);
  });

  it("Copy button writes the full address + success toast", async () => {
    const { findByLabelText } = render(<GasWalletPanel />);
    const btn = await findByLabelText("Copy smart-account address");
    fireEvent.click(btn);
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    expect(writeTextMock).toHaveBeenCalledWith(SMART_ACCOUNT);
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    const msg = toastSuccessMock.mock.calls[0][0];
    expect(msg).toMatch(/copied/i);
    expect(msg).toMatch(/any wallet|exchange/i);
  });

  it("clipboard rejection -> toast.error fallback (no crash)", async () => {
    writeTextMock = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    const { findByLabelText } = render(<GasWalletPanel />);
    const btn = await findByLabelText("Copy smart-account address");
    fireEvent.click(btn);
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
  });
});

describe("GasWalletPanel — live balance read", () => {
  it("reads EntryPoint.balanceOf(smartAccount) on mount", async () => {
    render(<GasWalletPanel />);
    await waitFor(() => expect(readContractMock).toHaveBeenCalled());
    const args = readContractMock.mock.calls[0][0];
    expect(args.address).toBe(ENTRY_POINT);
    expect(args.functionName).toBe("balanceOf");
    expect(args.args).toEqual([SMART_ACCOUNT]);
  });

  it("formats deposit balance as ETH (1 ETH = 1e18 wei)", async () => {
    readContractMock = vi.fn().mockResolvedValue(1_000_000_000_000_000_000n);
    getBalanceMock = vi.fn().mockResolvedValue(0n);
    usePublicClientMock.mockReturnValue({
      readContract: readContractMock,
      getBalance: getBalanceMock,
    });
    const { findByTestId } = render(<GasWalletPanel />);
    const deposit = await findByTestId("gas-wallet-deposit");
    await waitFor(() => expect(deposit.textContent).toContain("1 ETH"));
  });

  it("renders BOTH deposit + idle balances in their own slots", async () => {
    readContractMock = vi.fn().mockResolvedValue(500_000_000_000_000_000n); // 0.5 ETH deposit
    getBalanceMock = vi.fn().mockResolvedValue(200_000_000_000_000_000n); // 0.2 ETH idle
    usePublicClientMock.mockReturnValue({
      readContract: readContractMock,
      getBalance: getBalanceMock,
    });
    const { findByTestId } = render(<GasWalletPanel />);
    await waitFor(async () => {
      expect((await findByTestId("gas-wallet-deposit")).textContent).toContain("0.5 ETH");
      expect((await findByTestId("gas-wallet-idle")).textContent).toContain("0.2 ETH");
    });
  });

  it("'Self-paying mode active' badge appears when deposit > 0", async () => {
    readContractMock = vi.fn().mockResolvedValue(1n); // any non-zero
    usePublicClientMock.mockReturnValue({
      readContract: readContractMock,
      getBalance: getBalanceMock,
    });
    const { findByText } = render(<GasWalletPanel />);
    await findByText(/Self-paying mode/i);
  });

  it("badge does NOT appear when deposit is zero", async () => {
    const { container, findByTestId } = render(<GasWalletPanel />);
    await findByTestId("gas-wallet-deposit");
    expect(container.textContent).not.toContain("Self-paying mode");
  });
});

describe("GasWalletPanel — refresh", () => {
  it("Refresh button re-reads balance", async () => {
    const { findByLabelText } = render(<GasWalletPanel />);
    await waitFor(() => expect(readContractMock).toHaveBeenCalled());
    const before = readContractMock.mock.calls.length;
    const btn = await findByLabelText("Refresh gas balance");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(readContractMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("auto-refreshes every 10 seconds", async () => {
    vi.useFakeTimers();
    render(<GasWalletPanel />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = readContractMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(readContractMock.mock.calls.length).toBeGreaterThan(before);
    vi.useRealTimers();
  });

  it("read failure shows inline error, no crash", async () => {
    readContractMock = vi.fn().mockRejectedValue(new Error("RPC down"));
    usePublicClientMock.mockReturnValue({
      readContract: readContractMock,
      getBalance: getBalanceMock,
    });
    const { findByText } = render(<GasWalletPanel />);
    expect(await findByText(/Couldn't read balance/i)).toBeDefined();
  });
});

describe("GasWalletPanel — explorer link", () => {
  it("links to {explorerUrl}/address/{smartAccount} with tabnabbing guard", async () => {
    const { findByLabelText } = render(<GasWalletPanel />);
    const link = (await findByLabelText("View account on explorer")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `https://sepolia.etherscan.io/address/${SMART_ACCOUNT}`,
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
