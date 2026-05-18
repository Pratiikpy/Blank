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
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/hooks/useUnifiedWrite", () => ({
  useUnifiedWrite: useUnifiedWriteMock,
}));
vi.mock("@/lib/abis", () => ({
  BlankAccountAbi: [],
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

const NEW_IMPL = "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
const OLD_IMPL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const ZERO_IMPL = "0x0000000000000000000000000000000000000000";

let readContractMock: ReturnType<typeof vi.fn>;
let getBalanceMock: ReturnType<typeof vi.fn>;
let getStorageAtMock: ReturnType<typeof vi.fn>;
let unifiedWriteMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

function implAsSlot(addr: string): string {
  // EIP-1967 stores the impl address right-aligned in a 32-byte slot.
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: SMART_ACCOUNT });
  useChainMock.mockReturnValue({
    activeChain: {
      id: 11155111,
      name: "Ethereum Sepolia",
      explorerUrl: "https://sepolia.etherscan.io",
    },
    // Default: gas-wallet impl NOT deployed (zero address). Tests that
    // exercise the upgrade prompt override per case.
    contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: ZERO_IMPL },
  });

  readContractMock = vi.fn().mockResolvedValue(0n);
  getBalanceMock = vi.fn().mockResolvedValue(0n);
  // Default: getStorageAt returns the OLD impl as a 32-byte slot. Tests
  // that need a "match" or a counterfactual account override.
  getStorageAtMock = vi.fn().mockResolvedValue(implAsSlot(OLD_IMPL));
  usePublicClientMock.mockReturnValue({
    readContract: readContractMock,
    getBalance: getBalanceMock,
    getStorageAt: getStorageAtMock,
  });

  unifiedWriteMock = vi.fn().mockResolvedValue("0xtxhash");
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });

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
      getStorageAt: getStorageAtMock,
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
      getStorageAt: getStorageAtMock,
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
      getStorageAt: getStorageAtMock,
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
      getStorageAt: getStorageAtMock,
    });
    const { findByText } = render(<GasWalletPanel />);
    expect(await findByText(/Couldn't read balance/i)).toBeDefined();
  });
});

describe("GasWalletPanel — §1.13 self-upgrade prompt", () => {
  it("dormant when BlankAccount_Impl_gasWallet is 0x0 (impl not deployed yet)", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: ZERO_IMPL },
    });
    const { findByTestId, queryByLabelText } = render(<GasWalletPanel />);
    await findByTestId("gas-wallet-address");
    expect(queryByLabelText("Account upgrade available")).toBeNull();
  });

  it("dormant when proxy already points at the new impl (current === expected)", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    getStorageAtMock.mockResolvedValue(implAsSlot(NEW_IMPL));
    const { findByTestId, queryByLabelText } = render(<GasWalletPanel />);
    await findByTestId("gas-wallet-address");
    // Wait one tick to make sure the read resolves.
    await new Promise((r) => setTimeout(r, 30));
    expect(queryByLabelText("Account upgrade available")).toBeNull();
  });

  it("dormant for counterfactual accounts (proxy not yet deployed — slot is zero)", async () => {
    // Pre-fix: every first-time user saw the upgrade banner BEFORE their
    // first UserOp had deployed the proxy. `eth_getStorageAt` on an
    // undeployed contract returns a zeroed 32-byte slot, which
    // `normalizeImplFromSlot` would convert to "0x0000…0000" (not null).
    // The upgradeAvailable check filtered `currentImpl !== null` but NOT
    // `currentImpl !== ZERO_ADDRESS`, so the banner rendered. Found while
    // running wave4 02-p2p-payments against a fresh persona — the React
    // re-render loop on this banner also caused "Maximum update depth
    // exceeded" warnings that jammed the test. Pin the fix here.
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    // Zeroed slot — what counterfactual proxies return.
    getStorageAtMock.mockResolvedValue(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    const { findByTestId, queryByLabelText } = render(<GasWalletPanel />);
    await findByTestId("gas-wallet-address");
    await new Promise((r) => setTimeout(r, 30));
    expect(queryByLabelText("Account upgrade available")).toBeNull();
  });

  it("VISIBLE when impl is deployed AND proxy points at older impl", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    getStorageAtMock.mockResolvedValue(implAsSlot(OLD_IMPL));
    const { findByLabelText } = render(<GasWalletPanel />);
    expect(await findByLabelText("Account upgrade available")).toBeDefined();
  });

  it("CTA click fires upgradeToAndCall(newImpl, '0x') via unifiedWrite", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    getStorageAtMock.mockResolvedValue(implAsSlot(OLD_IMPL));
    const { findByLabelText } = render(<GasWalletPanel />);
    const btn = await findByLabelText("Upgrade smart account to gas-wallet implementation");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unifiedWriteMock).toHaveBeenCalled();
    const args = unifiedWriteMock.mock.calls[0][0];
    expect(args.address).toBe(SMART_ACCOUNT);
    expect(args.functionName).toBe("upgradeToAndCall");
    expect(args.args[0]).toBe(NEW_IMPL);
    expect(args.args[1]).toBe("0x");
  });

  it("upgrade success -> toast.success + refresh", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    getStorageAtMock.mockResolvedValue(implAsSlot(OLD_IMPL));
    const { findByLabelText } = render(<GasWalletPanel />);
    const btn = await findByLabelText("Upgrade smart account to gas-wallet implementation");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    const msg = toastSuccessMock.mock.calls[0][0];
    expect(msg).toMatch(/upgraded/i);
  });

  it("upgrade failure -> toast.error with the failure reason", async () => {
    useChainMock.mockReturnValue({
      activeChain: {
        id: 11155111,
        name: "Ethereum Sepolia",
        explorerUrl: "https://sepolia.etherscan.io",
      },
      contracts: { EntryPoint: ENTRY_POINT, BlankAccount_Impl_gasWallet: NEW_IMPL },
    });
    getStorageAtMock.mockResolvedValue(implAsSlot(OLD_IMPL));
    unifiedWriteMock.mockRejectedValue(new Error("user rejected"));
    const { findByLabelText } = render(<GasWalletPanel />);
    const btn = await findByLabelText("Upgrade smart account to gas-wallet implementation");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
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
