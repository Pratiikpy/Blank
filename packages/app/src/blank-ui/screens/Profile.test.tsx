import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Profile screen. Pins:
//   - passkey-blank-page guard (`!address` -> null)
//   - audit #313 cache-purge BEFORE disconnect ordering (mirrors
//     Settings; this is the OTHER screen that exposes sign-out)
//   - audit Top-28 #23 balance-permit-CTA branch: when balance
//     handle exists but isn't decrypted (permit missing/expired),
//     show "Create a permit to view your balance" -> /app/privacy.
//     Without this branch the user stares at "Decrypting…" forever
//     and never recovers without a hard reload.
//   - 4-way encrypted-balance display matrix: hidden ($••••••.••),
//     revealed+decrypted+value (${formatted}), revealed+decrypted
//     but no value ($0.00), revealed+has-handle-but-not-decrypted
//     (permit CTA)
//   - menu routing table (4 entries, all internal to /app/*)

const useNavigateMock = vi.hoisted(() => vi.fn());
const useAccountMock = vi.hoisted(() => vi.fn());
const useDisconnectMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEncryptedBalanceMock = vi.hoisted(() => vi.fn());
const clearAllAddressScopesMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));
vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useDisconnect: useDisconnectMock,
}));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));
vi.mock("@/hooks/useEncryptedBalance", () => ({
  useEncryptedBalance: useEncryptedBalanceMock,
}));
vi.mock("@/lib/storage", () => ({
  clearAllAddressScopes: clearAllAddressScopesMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import Profile from "./Profile";

const ADDR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

let writeTextMock: ReturnType<typeof vi.fn>;
let disconnectMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useNavigateMock.mockReset();
  useAccountMock.mockReset();
  useDisconnectMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useEncryptedBalanceMock.mockReset();
  clearAllAddressScopesMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ADDR });
  useAccountMock.mockReturnValue({ address: ADDR, isConnected: true });

  disconnectMock = vi.fn();
  useDisconnectMock.mockReturnValue({ disconnect: disconnectMock });

  useChainMock.mockReturnValue({ activeChain: { id: 11155111, name: "Ethereum Sepolia" } });

  // Default: no handle, no decryption.
  useEncryptedBalanceMock.mockReturnValue({
    formatted: null,
    isDecrypted: false,
    hasBalance: false,
  });

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Profile — passkey-blank-page guard (§15.x)", () => {
  it("returns null when no effective address", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("Loading your account...");
  });

  it("renders the page chrome when effective address present", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("Profile");
    expect(container.textContent).toContain("Manage your account and privacy");
  });
});

describe("Profile — address display (§15.x)", () => {
  it("avatar shows first 2 hex chars after 0x, uppercased", () => {
    const { container } = render(<Profile />);
    // Address is 0xAbCdEf... so slice(2,4)='Ab', uppercased='AB'.
    const avatar = container.querySelector(".bg-gradient-to-br");
    expect(avatar?.textContent).toBe("AB");
  });

  it("renders the truncated address as the profile title", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
  });

  it("@-handle uses first 6 hex chars lowercased", () => {
    const { container } = render(<Profile />);
    // 0xAbCdEf... slice(2,8)='AbCdEf', lowercased='abcdef'.
    expect(container.textContent).toContain("@abcdef");
  });

  it("full address rendered in the Wallet Address card", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain(ADDR);
  });
});

describe("Profile — encrypted balance display matrix (§15.x)", () => {
  it("hidden state shows masked '$••••••.••' (default)", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("••••••.••");
  });

  it("reveal button has aria-label 'Reveal balance' when hidden", () => {
    const { getByLabelText } = render(<Profile />);
    expect(getByLabelText("Reveal balance")).toBeDefined();
  });

  it("clicking reveal flips aria-label to 'Hide balance'", () => {
    const { getByLabelText } = render(<Profile />);
    fireEvent.click(getByLabelText("Reveal balance"));
    expect(getByLabelText("Hide balance")).toBeDefined();
  });

  it("revealed + decrypted + value → renders $<formatted> exact", () => {
    useEncryptedBalanceMock.mockReturnValue({
      formatted: "1,234.56",
      isDecrypted: true,
      hasBalance: true,
    });
    const { getByLabelText, container } = render(<Profile />);
    fireEvent.click(getByLabelText("Reveal balance"));
    expect(container.textContent).toContain("$1,234.56");
  });

  it("revealed + decrypted + null formatted → renders '$0.00'", () => {
    useEncryptedBalanceMock.mockReturnValue({
      formatted: null,
      isDecrypted: true,
      hasBalance: false,
    });
    const { getByLabelText, container } = render(<Profile />);
    fireEvent.click(getByLabelText("Reveal balance"));
    expect(container.textContent).toContain("$0.00");
  });

  it("CRITICAL audit Top-28 #23: revealed + hasBalance + !isDecrypted → permit CTA (not stuck on Decrypting…)", () => {
    useEncryptedBalanceMock.mockReturnValue({
      formatted: null,
      isDecrypted: false,
      hasBalance: true,
    });
    const { getByLabelText, container } = render(<Profile />);
    fireEvent.click(getByLabelText("Reveal balance"));
    expect(container.textContent).toContain("Create a permit to view your balance");
  });

  it("permit CTA click navigates to /app/privacy", () => {
    useEncryptedBalanceMock.mockReturnValue({
      formatted: null,
      isDecrypted: false,
      hasBalance: true,
    });
    const { getByLabelText, getByText } = render(<Profile />);
    fireEvent.click(getByLabelText("Reveal balance"));
    fireEvent.click(getByText("Create a permit to view your balance"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/privacy");
  });

  it("hidden state does NOT show permit CTA even when hasBalance && !isDecrypted (guarded by balanceRevealed)", () => {
    useEncryptedBalanceMock.mockReturnValue({
      formatted: null,
      isDecrypted: false,
      hasBalance: true,
    });
    const { container } = render(<Profile />);
    expect(container.textContent).not.toContain("Create a permit to view your balance");
    expect(container.textContent).toContain("••••••.••");
  });

  it("FHE Active pill + active chain name rendered next to balance", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("FHE Active");
    expect(container.textContent).toContain("Ethereum Sepolia");
  });

  it("chain pill falls back to 'Unknown chain' when activeChain null", () => {
    useChainMock.mockReturnValue({ activeChain: null });
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("Unknown chain");
  });
});

describe("Profile — copy address (§15.x)", () => {
  it("clicking Copy writes address + 'Address copied' toast", async () => {
    const { getByLabelText } = render(<Profile />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(ADDR);
    expect(toastSuccessMock).toHaveBeenCalledWith("Address copied");
  });

  it("button label flips to 'Copied' after copy", async () => {
    const { getByLabelText, container } = render(<Profile />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Copied");
  });

  it("'Copied' reverts after 2s timeout", async () => {
    vi.useFakeTimers();
    const { getByLabelText, container } = render(<Profile />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Copied");
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).not.toContain("Copied");
  });

  it("clipboard rejection → 'Failed to copy' toast (not silent)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    const { getByLabelText } = render(<Profile />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy");
  });
});

describe("Profile — menu routing (§15.x)", () => {
  it("renders 4 menu items: Wallet & Keys, Contacts, Privacy Settings, Settings", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("Wallet & Keys");
    expect(container.textContent).toContain("Contacts");
    expect(container.textContent).toContain("Privacy Settings");
    // The "Settings" label appears twice (heading + menu); rely on the
    // adjacent subtitle to confirm the menu row.
    expect(container.textContent).toContain("Preferences and notifications");
  });

  it("Wallet & Keys → /app/privacy", () => {
    const { getByText } = render(<Profile />);
    fireEvent.click(getByText("Wallet & Keys"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/privacy");
  });

  it("Contacts → /app/contacts", () => {
    const { getByText } = render(<Profile />);
    fireEvent.click(getByText("Contacts"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/contacts");
  });

  it("Privacy Settings → /app/privacy", () => {
    const { getByText } = render(<Profile />);
    fireEvent.click(getByText("Privacy Settings"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/privacy");
  });

  it("Settings (menu row) → /app/settings", () => {
    const { getByText } = render(<Profile />);
    fireEvent.click(getByText("Preferences and notifications"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/settings");
  });
});

describe("Profile — About section (§15.x)", () => {
  it("renders Version '1.0.0' + chain name + 'FHE Active'", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("1.0.0");
    expect(container.textContent).toContain("FHE Active");
    expect(container.textContent).toContain("Ethereum Sepolia");
  });
});

describe("Profile — sign-out flow (audit #313) (§15.x)", () => {
  it("CRITICAL: clearAllAddressScopes(address) runs BEFORE disconnect", () => {
    const order: string[] = [];
    clearAllAddressScopesMock.mockImplementation(() => { order.push("clearScopes"); });
    disconnectMock.mockImplementation(() => { order.push("disconnect"); });
    useNavigateMock.mockImplementation(() => { order.push("navigate"); });

    const { getByLabelText } = render(<Profile />);
    fireEvent.click(getByLabelText("Disconnect wallet"));

    expect(order).toEqual(["clearScopes", "disconnect", "navigate"]);
    expect(clearAllAddressScopesMock).toHaveBeenCalledWith(ADDR);
  });

  it("navigates to '/' with { replace: true }", () => {
    const { getByLabelText } = render(<Profile />);
    fireEvent.click(getByLabelText("Disconnect wallet"));
    expect(useNavigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("Sign Out button label + icon present", () => {
    const { container } = render(<Profile />);
    expect(container.textContent).toContain("Sign Out");
  });
});
