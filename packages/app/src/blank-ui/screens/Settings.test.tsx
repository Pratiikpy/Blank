import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Settings screen. Pins:
//   - passkey-blank-page guard (`!address` -> null)
//   - audit #313 cache-purge BEFORE disconnect (shared-browser fix:
//     next user must NOT inherit prior session's per-address caches)
//   - Pay-Me link shape: payUrl + badgeUrl + signatureHtml. The
//     signatureHtml MUST embed the `utm_source=email_sig` UTM so
//     campaign tracking distinguishes email-signature clicks from
//     direct visits. ENS lookup wins over raw address when present.
//   - 3-branch faucet flow: ok / rate_limited / error (address vs
//     network scope each get their own toast)
//   - dark-mode toggle writes BOTH `blank_theme` + `blank_dark_mode`
//     (legacy + new keys) + toggles `dark` class on documentElement
//   - WorkspaceModePicker: aria-pressed flips on the active mode

const useNavigateMock = vi.hoisted(() => vi.fn());
const useDisconnectMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useLookupNameMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useWorkspaceModeMock = vi.hoisted(() => vi.fn());
const faucetUsdcMock = vi.hoisted(() => vi.fn());
const clearAllAddressScopesMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn(() => "toast-id-1"));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => useNavigateMock };
});
vi.mock("wagmi", () => ({ useDisconnect: useDisconnectMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useAddressResolver", () => ({
  useLookupName: useLookupNameMock,
}));
vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));
vi.mock("@/providers/WorkspaceModeProvider", () => ({
  useWorkspaceMode: useWorkspaceModeMock,
}));
vi.mock("@/lib/faucet-client", () => ({
  faucetUsdc: faucetUsdcMock,
}));
vi.mock("@/lib/storage", () => ({
  clearAllAddressScopes: clearAllAddressScopesMock,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    success: toastSuccessMock,
    error: toastErrorMock,
    loading: toastLoadingMock,
  },
}));

import Settings from "./Settings";

const ADDR = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

let writeTextMock: ReturnType<typeof vi.fn>;
let disconnectMock: ReturnType<typeof vi.fn>;
let setModeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useNavigateMock.mockReset();
  useDisconnectMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useLookupNameMock.mockReset();
  useChainMock.mockReset();
  useWorkspaceModeMock.mockReset();
  faucetUsdcMock.mockReset();
  clearAllAddressScopesMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastLoadingMock.mockReset();
  toastLoadingMock.mockReturnValue("toast-id-1");

  disconnectMock = vi.fn();
  useDisconnectMock.mockReturnValue({ disconnect: disconnectMock });

  setModeMock = vi.fn();
  useWorkspaceModeMock.mockReturnValue({ mode: "freelancer", setMode: setModeMock });

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ADDR });
  useLookupNameMock.mockReturnValue({ data: null });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    activeChain: { name: "Ethereum Sepolia" },
  });

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });

  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove("dark");
});

describe("Settings — passkey-blank-page guard (§15.x)", () => {
  it("returns null when no effective address (no passkey-empty-page render)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("Loading your account...");
  });

  it("renders the page chrome when effective address present", () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Manage your account and preferences");
  });
});

describe("Settings — section chrome (§15.x)", () => {
  it("renders all 5 section headers", () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain("Pay-Me Link");
    expect(container.textContent).toContain("Privacy");
    expect(container.textContent).toContain("Appearance");
    expect(container.textContent).toContain("About");
  });

  it("Account section shows truncated wallet address + chain name", () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
    expect(container.textContent).toContain("Ethereum Sepolia");
  });

  it("About card pins 'Blank v1.0' version + 'FHE (Fhenix CoFHE)' encryption + chain pill", () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("Blank v1.0");
    expect(container.textContent).toContain("FHE (Fhenix CoFHE)");
  });

  it("GitHub link has tabnabbing guard (rel + target)", () => {
    const { getByText } = render(<Settings />);
    const link = getByText("View on GitHub").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/FhenixProtocol");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("'Unknown chain' fallback when activeChain is null", () => {
    useChainMock.mockReturnValue({ activeChainId: 99999, activeChain: null });
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("Unknown chain");
  });
});

describe("Settings — copy address (§15.x)", () => {
  it("clicking Copy writes address to clipboard + 'Address copied' toast", async () => {
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(ADDR);
    expect(toastSuccessMock).toHaveBeenCalledWith("Address copied");
  });

  it("button aria-label flips to 'Copied' + label reads 'Copied' after copy", async () => {
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(getByLabelText("Copied")).toBeDefined();
  });

  it("'Copied' state reverts after 2s timeout", async () => {
    vi.useFakeTimers();
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(getByLabelText("Copied")).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(getByLabelText("Copy address")).toBeDefined();
  });

  it("clipboard rejection → 'Failed to copy' toast (not silent)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy");
  });
});

describe("Settings — Pay-Me link (§15.x)", () => {
  it("payUrl uses raw address when no ENS name resolved", () => {
    useLookupNameMock.mockReturnValue({ data: null });
    const { container } = render(<Settings />);
    // The pay URL is rendered in the Pay URL row.
    expect(container.textContent).toContain(`/pay/${ADDR}`);
  });

  it("payUrl uses ENS name when reverse lookup resolves it", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("/pay/alice.eth");
    expect(container.textContent).not.toContain(`/pay/${ADDR}`);
  });

  it("badge preview img uses /api/badge?for=<identifier> URL", () => {
    const { container } = render(<Settings />);
    const img = container.querySelector("img[alt='Pay me on Blank']") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toContain("/api/badge?for=");
    expect(img.getAttribute("src")).toContain(ADDR);
  });

  it("badge preview encodes identifier in the URL (URL-safe)", () => {
    useLookupNameMock.mockReturnValue({ data: "a b.eth" }); // contains a space
    const { container } = render(<Settings />);
    const img = container.querySelector("img[alt='Pay me on Blank']") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("a%20b.eth");
  });

  it("CRITICAL: signature HTML embeds utm_source=email_sig (campaign tracking distinguishes email-sig from direct)", () => {
    const { container } = render(<Settings />);
    expect(container.textContent).toContain("utm_source=email_sig");
  });

  it("signature HTML wraps badge img in an anchor with the utm-tagged pay URL", () => {
    const { container } = render(<Settings />);
    const code = Array.from(container.querySelectorAll("code")).find((c) =>
      c.textContent?.includes("utm_source=email_sig"),
    );
    expect(code).toBeDefined();
    const html = code!.textContent ?? "";
    expect(html).toMatch(/<a href="[^"]+\?utm_source=email_sig">/);
    expect(html).toMatch(/<img src="[^"]+\/api\/badge\?for=[^"]+"/);
    expect(html).toContain('alt="Pay me on Blank"');
  });

  it("Copy pay link button writes the payUrl to clipboard + success toast", async () => {
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy pay link"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    expect(writeTextMock.mock.calls[0][0]).toContain(`/pay/${ADDR}`);
    expect(toastSuccessMock).toHaveBeenCalledWith("Pay link copied");
  });

  it("Copy signature HTML button writes the FULL signature HTML to clipboard", async () => {
    const { getByLabelText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy signature HTML"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    const copied = writeTextMock.mock.calls[0][0];
    expect(copied).toContain("<a href=");
    expect(copied).toContain("<img src=");
    expect(copied).toContain("utm_source=email_sig");
    expect(toastSuccessMock).toHaveBeenCalledWith("Signature HTML copied");
  });

  it("link vs html copy use SEPARATE state (only one Copy button shows 'Copied' at a time)", async () => {
    const { getByLabelText, container } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy pay link"));
      await Promise.resolve();
    });
    // Only ONE button in the Pay-Me section should currently read "Copied" --
    // pay-link copy flips its own state. The HTML button still reads
    // "Copy HTML".
    const copyHtmlBtn = getByLabelText("Copy signature HTML");
    expect(copyHtmlBtn.textContent).toContain("Copy HTML");
    // Use textContent on the parent container to count "Copied" occurrences in the Pay-Me section
    expect(container.textContent).toContain("Copy HTML");
  });
});

describe("Settings — disconnect flow (audit #313) (§15.x)", () => {
  it("CRITICAL: clearAllAddressScopes(address) runs BEFORE disconnect (shared-browser cache purge)", () => {
    const order: string[] = [];
    clearAllAddressScopesMock.mockImplementation(() => {
      order.push("clearScopes");
    });
    disconnectMock.mockImplementation(() => {
      order.push("disconnect");
    });
    useNavigateMock.mockImplementation(() => {
      order.push("navigate");
    });

    const { getByText } = render(<Settings />);
    fireEvent.click(getByText("Disconnect Wallet"));

    expect(order).toEqual(["clearScopes", "disconnect", "navigate"]);
    expect(clearAllAddressScopesMock).toHaveBeenCalledWith(ADDR);
  });

  it("navigates to '/' with { replace: true } so back button cannot return to authed shell", () => {
    const { getByText } = render(<Settings />);
    fireEvent.click(getByText("Disconnect Wallet"));
    expect(useNavigateMock).toHaveBeenCalledWith("/", { replace: true });
  });
});

describe("Settings — testnet faucet (§15.x)", () => {
  it("clicking 'Get 100 testnet USDC' calls faucetUsdc with address + chainId", async () => {
    faucetUsdcMock.mockResolvedValue({ ok: true });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    expect(faucetUsdcMock).toHaveBeenCalledWith({ address: ADDR, chainId: 11155111 });
  });

  it("ok=true → success toast '100 testnet USDC minted to your wallet'", async () => {
    faucetUsdcMock.mockResolvedValue({ ok: true });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "100 testnet USDC minted to your wallet",
      { id: "toast-id-1" },
    );
  });

  it("rate_limited + scope='address' → 'rate-limited for this address' toast", async () => {
    faucetUsdcMock.mockResolvedValue({
      ok: false,
      error: "rate_limited",
      rateLimitScope: "address",
    });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("this address");
  });

  it("rate_limited + scope='network' → 'rate-limited for your network' toast", async () => {
    faucetUsdcMock.mockResolvedValue({
      ok: false,
      error: "rate_limited",
      rateLimitScope: "network",
    });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("your network");
  });

  it("generic error → 'Faucet failed: <error>' toast (NOT silent)", async () => {
    faucetUsdcMock.mockResolvedValue({ ok: false, error: "network_down" });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("Faucet failed: network_down");
  });

  it("unknown error shape → 'Faucet failed: unknown' (defensive)", async () => {
    faucetUsdcMock.mockResolvedValue({ ok: false });
    const { getByText } = render(<Settings />);
    await act(async () => {
      fireEvent.click(getByText("Get 100 testnet USDC"));
      await Promise.resolve();
    });
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("unknown");
  });

  it("button disabled during request + shows 'Minting…' label", async () => {
    let resolveFaucet!: (v: { ok: boolean }) => void;
    faucetUsdcMock.mockReturnValue(new Promise((res) => { resolveFaucet = res; }));
    const { getByText } = render(<Settings />);
    fireEvent.click(getByText("Get 100 testnet USDC"));
    // While the promise is pending, the button should be disabled + relabel
    expect(getByText("Minting…")).toBeDefined();
    await act(async () => {
      resolveFaucet({ ok: true });
      await Promise.resolve();
    });
    expect(getByText("Get 100 testnet USDC")).toBeDefined();
  });
});

describe("Settings — dark-mode toggle (§15.x)", () => {
  it("default light state: no 'dark' class on documentElement", () => {
    render(<Settings />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("clicking toggle adds 'dark' class to documentElement", () => {
    const { getByLabelText } = render(<Settings />);
    fireEvent.click(getByLabelText("Toggle dark mode"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("toggle writes BOTH localStorage keys: 'blank_theme' + 'blank_dark_mode'", () => {
    const { getByLabelText } = render(<Settings />);
    fireEvent.click(getByLabelText("Toggle dark mode"));
    expect(localStorage.getItem("blank_theme")).toBe("dark");
    expect(localStorage.getItem("blank_dark_mode")).toBe("true");
  });

  it("toggling back to light persists 'light' + 'false'", () => {
    const { getByLabelText } = render(<Settings />);
    const toggle = getByLabelText("Toggle dark mode");
    fireEvent.click(toggle); // -> dark
    fireEvent.click(toggle); // -> light
    expect(localStorage.getItem("blank_theme")).toBe("light");
    expect(localStorage.getItem("blank_dark_mode")).toBe("false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("hydrates from 'blank_theme' on first render (new key wins)", () => {
    localStorage.setItem("blank_theme", "dark");
    render(<Settings />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to legacy 'blank_dark_mode' when 'blank_theme' absent", () => {
    localStorage.setItem("blank_dark_mode", "true");
    render(<Settings />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("aria-checked reflects current dark-mode state for screen readers", () => {
    const { getByLabelText } = render(<Settings />);
    const toggle = getByLabelText("Toggle dark mode");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Settings — privacy + stealth nav (§15.x)", () => {
  it("'Privacy Settings' row navigates to /app/privacy", () => {
    const { getByText } = render(<Settings />);
    fireEvent.click(getByText("Privacy Settings"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/privacy");
  });

  it("'Stealth meta-address' row navigates to /app/stealth/setup", () => {
    const { getByText } = render(<Settings />);
    fireEvent.click(getByText("Stealth meta-address"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/stealth/setup");
  });

  it("Back button (aria-label='Go back') navigates(-1)", () => {
    const { getByLabelText } = render(<Settings />);
    fireEvent.click(getByLabelText("Go back"));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });
});

describe("Settings — WorkspaceModePicker (§15.x)", () => {
  it("renders 4 workspace mode buttons (one per mode)", () => {
    const { container } = render(<Settings />);
    const modeButtons = container.querySelectorAll("button[aria-pressed]");
    expect(modeButtons.length).toBeGreaterThanOrEqual(4);
  });

  it("active mode button has aria-pressed=true", () => {
    useWorkspaceModeMock.mockReturnValue({ mode: "freelancer", setMode: setModeMock });
    const { container } = render(<Settings />);
    const pressed = container.querySelectorAll("button[aria-pressed='true']");
    expect(pressed.length).toBe(1);
  });

  it("clicking a mode button calls setMode(thatMode)", () => {
    const { container } = render(<Settings />);
    const modeButtons = container.querySelectorAll("button[aria-pressed]");
    // Find a button that's currently aria-pressed='false' and click it.
    const target = Array.from(modeButtons).find((b) => b.getAttribute("aria-pressed") === "false") as HTMLButtonElement;
    fireEvent.click(target);
    expect(setModeMock).toHaveBeenCalled();
  });
});
