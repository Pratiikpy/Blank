import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for ChainSelector. The chain-switch dropdown in the
// Desktop Sidebar + Mobile menu. Critical because:
//   - Wrong-chain switch silently sends txs to the wrong network
//     (USDC on Sepolia is a DIFFERENT contract from USDC on Base
//     Sepolia; an invoice created on one chain isn't readable from
//     the other);
//   - The EOA-vs-AA branching here drives whether MetaMask gets a
//     native chain-switch popup (EOA) or whether the ChainProvider
//     directly updates the activeChainId (AA-only fallback);
//   - The passkey-per-chain indicator labels each option with
//     "passkey ready" / "will set up passkey" so the user knows in
//     advance which chains will drop them into Onboarding.
//
// CRITICAL pins:
//   - Disconnected (no effectiveAddress) -> button disabled +
//     aria-label says "Connect a wallet to switch chains" + click
//     does NOT open the dropdown (regression #323: silent no-op).
//   - Connected (effectiveAddress set, isSmartAccount OR wagmi
//     EOA) -> button enabled + aria-label says "Click to switch"
//     + click toggles dropdown open.
//   - EOA path (isWagmiConnected=true + switchChain available):
//     clicking a non-active chain row calls switchChain({chainId:
//     id}) — NOT setActiveChain directly — because BlankApp's auto-
//     sync useEffect makes wagmi's chain the source of truth; the
//     direct setActiveChain would get reverted on the next render.
//   - AA fallback path (isWagmiConnected=false or no switchChain):
//     clicking calls setActiveChain(id) directly because no wagmi
//     connector is around to trigger the sync; this is the
//     passkey-only mode where no EOA is connected.
//   - Click on the active chain row -> dropdown closes but NO
//     switchChain / setActiveChain call (no-op for re-selection).
//   - Click outside the component (mousedown anywhere outside ref)
//     -> dropdown closes; Escape key -> dropdown closes; both
//     listeners only attached when open=true (event-listener
//     leak prevention).
//   - Passkey-per-chain async lookup via hasPasskey(chainId);
//     'passkey ready' label appears on chains where the user
//     already has a passkey stored locally; 'will set up passkey'
//     label appears on chains where they DON'T (only when
//     isSmartAccount=true so it doesn't appear for EOA users);
//     active chain row always shows just 'Chain ID N' regardless
//     of passkey status (because the user is already on it).
//   - Smart-account footer hint 'Passkeys are per-chain. Go to
//     Smart Wallet to create one on another chain.' appears ONLY
//     when isSmartAccount=true AND passkeyChains.size <
//     CHAIN_ORDER.length (i.e., they're missing a passkey on at
//     least one chain).
//   - aria-haspopup='listbox' + aria-expanded reflects open state
//     + role='listbox' on dropdown + role='option' on each row +
//     aria-selected on active row (accessibility baseline).

const useAccountMock = vi.hoisted(() => vi.fn());
const useSwitchChainMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const hasPasskeyMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useSwitchChain: useSwitchChainMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/passkey", () => ({ hasPasskey: hasPasskeyMock }));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));
vi.mock("@/lib/constants", () => ({
  ETH_SEPOLIA_ID: 11155111,
  BASE_SEPOLIA_ID: 84532,
  CHAINS: {
    11155111: {
      id: 11155111,
      name: "Ethereum Sepolia",
      shortName: "Sepolia",
    },
    84532: {
      id: 84532,
      name: "Base Sepolia",
      shortName: "Base",
    },
  },
}));

import { ChainSelector } from "./ChainSelector";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

const setActiveChainMock = vi.fn();
const switchChainMock = vi.fn();

beforeEach(() => {
  useAccountMock.mockReset();
  useSwitchChainMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  hasPasskeyMock.mockReset();
  setActiveChainMock.mockReset();
  switchChainMock.mockReset();

  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    setActiveChain: setActiveChainMock,
  });
  useEffectiveAddressMock.mockReturnValue({
    effectiveAddress: ME,
    isSmartAccount: false,
  });
  useAccountMock.mockReturnValue({ isConnected: true });
  useSwitchChainMock.mockReturnValue({ switchChain: switchChainMock });
  hasPasskeyMock.mockResolvedValue(false);
});

// ───────────────────────────────────────────────────────────
//  Connected / disconnected gate (#323)
// ───────────────────────────────────────────────────────────

describe("ChainSelector — connected gate #323 (§15.x)", () => {
  it("disconnected (no effectiveAddress) -> button disabled + 'Connect a wallet' aria-label", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      isSmartAccount: false,
    });
    render(<ChainSelector />);
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toContain(
      "Connect a wallet to switch chains",
    );
  });

  it("disconnected click -> dropdown does NOT open (silent no-op)", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      isSmartAccount: false,
    });
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("connected EOA -> button enabled + 'Click to switch' aria-label + click opens dropdown", () => {
    render(<ChainSelector />);
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toContain("Click to switch");
    fireEvent.click(button);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("connected smart-account (no wagmi EOA) -> button still enabled", () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    render(<ChainSelector />);
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  Dropdown rendering + active state
// ───────────────────────────────────────────────────────────

describe("ChainSelector — dropdown rendering (§15.x)", () => {
  it("trigger shows active chain shortName", () => {
    render(<ChainSelector />);
    expect(screen.getByText("Sepolia")).toBeInTheDocument();
  });

  it("active chain (Sepolia) shown with Check icon + aria-selected=true", () => {
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    const sepolia = options.find((o) =>
      o.textContent?.includes("Ethereum Sepolia"),
    )!;
    const base = options.find((o) => o.textContent?.includes("Base Sepolia"))!;
    expect(sepolia.getAttribute("aria-selected")).toBe("true");
    expect(base.getAttribute("aria-selected")).toBe("false");
  });

  it("activeChainId=84532 -> Base Sepolia is active", () => {
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      setActiveChain: setActiveChainMock,
    });
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    const base = options.find((o) => o.textContent?.includes("Base Sepolia"))!;
    expect(base.getAttribute("aria-selected")).toBe("true");
  });

  it("aria-haspopup='listbox' + aria-expanded reflects open state", () => {
    render(<ChainSelector />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});

// ───────────────────────────────────────────────────────────
//  Chain switch — EOA path vs AA fallback
// ───────────────────────────────────────────────────────────

describe("ChainSelector — chain switch dispatch (§15.x)", () => {
  it("EOA path: clicking non-active row calls switchChain({chainId}) NOT setActiveChain", () => {
    useAccountMock.mockReturnValue({ isConnected: true });
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const baseRow = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Base Sepolia"))!;
    fireEvent.click(baseRow);
    expect(switchChainMock).toHaveBeenCalledWith({ chainId: 84532 });
    expect(setActiveChainMock).toHaveBeenCalledTimes(0);
  });

  it("AA fallback (no wagmi connector) -> setActiveChain called directly", () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    useSwitchChainMock.mockReturnValue({ switchChain: switchChainMock });
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const baseRow = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Base Sepolia"))!;
    fireEvent.click(baseRow);
    expect(setActiveChainMock).toHaveBeenCalledWith(84532);
    expect(switchChainMock).toHaveBeenCalledTimes(0);
  });

  it("AA fallback (switchChain undefined) -> setActiveChain called directly", () => {
    useSwitchChainMock.mockReturnValue({ switchChain: undefined });
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const baseRow = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Base Sepolia"))!;
    fireEvent.click(baseRow);
    expect(setActiveChainMock).toHaveBeenCalledWith(84532);
    expect(switchChainMock).toHaveBeenCalledTimes(0);
  });

  it("clicking the ACTIVE chain row -> closes dropdown without dispatch", () => {
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    const sepoliaRow = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Ethereum Sepolia"))!;
    fireEvent.click(sepoliaRow);
    expect(switchChainMock).toHaveBeenCalledTimes(0);
    expect(setActiveChainMock).toHaveBeenCalledTimes(0);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("any row click closes dropdown", () => {
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const baseRow = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Base Sepolia"))!;
    fireEvent.click(baseRow);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Click-outside + Escape
// ───────────────────────────────────────────────────────────

describe("ChainSelector — click-outside + Escape (§15.x)", () => {
  it("mousedown outside ref -> dropdown closes", () => {
    render(
      <div>
        <ChainSelector />
        <button data-testid="outside">Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Network/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape key -> dropdown closes", () => {
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("other keys (e.g. 'a') do NOT close the dropdown", () => {
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(document, { key: "a" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("listeners detached when dropdown closes (no leak after close)", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(document, { key: "Escape" });
    // Closing should detach BOTH mousedown AND keydown listeners
    expect(removeSpy).toHaveBeenCalledWith(
      "mousedown",
      expect.any(Function),
    );
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────
//  Passkey-per-chain labels
// ───────────────────────────────────────────────────────────

describe("ChainSelector — passkey-per-chain labels (§15.x)", () => {
  it("EOA user (not smart-account) -> no 'will set up passkey' hint", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: false,
    });
    hasPasskeyMock.mockResolvedValue(false);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      const baseRow = screen
        .getAllByRole("option")
        .find((o) => o.textContent?.includes("Base Sepolia"))!;
      expect(baseRow.textContent).not.toContain("will set up passkey");
    });
  });

  it("AA user with passkey on Sepolia ONLY -> Base shows 'will set up passkey'", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    hasPasskeyMock.mockImplementation(async (id: number) => id === 11155111);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      const baseRow = screen
        .getAllByRole("option")
        .find((o) => o.textContent?.includes("Base Sepolia"))!;
      expect(baseRow.textContent).toContain("will set up passkey");
    });
  });

  it("AA user with passkey on Base too -> Base shows 'passkey ready' for non-active path", async () => {
    // Active chain is Sepolia; Base has a passkey too
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    hasPasskeyMock.mockResolvedValue(true);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      const baseRow = screen
        .getAllByRole("option")
        .find((o) => o.textContent?.includes("Base Sepolia"))!;
      expect(baseRow.textContent).toContain("passkey ready");
    });
  });

  it("active chain row always shows plain 'Chain ID N' regardless of passkey status", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    hasPasskeyMock.mockResolvedValue(true);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      const sepoliaRow = screen
        .getAllByRole("option")
        .find((o) => o.textContent?.includes("Ethereum Sepolia"))!;
      // Active row: only "Chain ID 11155111", no passkey suffix
      expect(sepoliaRow.textContent).not.toContain("passkey ready");
      expect(sepoliaRow.textContent).not.toContain("will set up passkey");
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Smart-account footer hint
// ───────────────────────────────────────────────────────────

describe("ChainSelector — smart-account footer hint (§15.x)", () => {
  it("isSmartAccount + missing passkey on at least one chain -> footer hint shown", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    // Passkey only on Sepolia
    hasPasskeyMock.mockImplementation(async (id: number) => id === 11155111);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(
        screen.getByText(
          /Passkeys are per-chain\. Go to Smart Wallet to create one on another chain\./,
        ),
      ).toBeInTheDocument();
    });
  });

  it("isSmartAccount + passkeys on ALL chains -> NO footer hint", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
    });
    hasPasskeyMock.mockResolvedValue(true);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(screen.queryByText(/Passkeys are per-chain/)).toBeNull();
  });

  it("EOA user (not smart-account) -> NO footer hint regardless of passkey state", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: false,
    });
    hasPasskeyMock.mockResolvedValue(false);
    render(<ChainSelector />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(screen.queryByText(/Passkeys are per-chain/)).toBeNull();
  });
});
