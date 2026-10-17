import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// UpgradeBanner: one-click UUPS upgrade to the newest BlankAccount
// implementation on the chain. The upgrade is a self-call UserOp:
//   AA.execute(self, 0, abi.encodeCall(upgradeToAndCall, [newImpl, "0x"]))
//
// Pins:
//   - Visibility: status === 'needs-upgrade' AND effectiveAddress AND
//     canonicalImpl !== 0x0 AND not dismissed for this (address, impl).
//   - Dismissal key is scoped per lowercased address AND per target impl,
//     so a wallet switch or a newer implementation prompts again.
//   - BlankPaymaster never sponsors calls into the account, so the upgrade
//     always goes paymaster='self' and the button stays disabled until the
//     account's EntryPoint deposit + ETH covers SELF_PAID_SETTINGS_OP_WEI.
//     The banner says so and links to the gas wallet.
//   - upgradeToAndCall args [canonicalImpl, "0x"], wrapped in
//     execute(self, 0n, data), gas 600_000n.
//   - On success both the impl query and the gas-funds query are invalidated.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useAccountVersionMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useAccountGasFundsMock = vi.hoisted(() => vi.fn());
const getStoredStringMock = vi.hoisted(() => vi.fn());
const setStoredStringMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQueryClient: useQueryClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("@/hooks/useAccountVersion", () => ({ useAccountVersion: useAccountVersionMock }));
vi.mock("@/hooks/useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/hooks/useAccountGasFunds", () => ({
  useAccountGasFunds: useAccountGasFundsMock,
  SELF_PAID_SETTINGS_OP_WEI: 2_700_000_000_000_000n,
}));
vi.mock("@/lib/storage", () => ({
  getStoredString: getStoredStringMock,
  setStoredString: setStoredStringMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import { UpgradeBanner } from "./UpgradeBanner";

const ME = "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const IMPL = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ENOUGH = 3_000_000_000_000_000n;

const unifiedWriteMock = vi.fn();
const invalidateQueriesMock = vi.fn();

function renderBanner() {
  return render(
    <MemoryRouter>
      <UpgradeBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useAccountVersionMock.mockReturnValue({ status: "needs-upgrade", canonicalImpl: IMPL });
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });
  useQueryClientMock.mockReturnValue({ invalidateQueries: invalidateQueriesMock });
  useAccountGasFundsMock.mockReturnValue({ totalWei: ENOUGH });
  getStoredStringMock.mockReturnValue(null);
  unifiedWriteMock.mockResolvedValue("0xupgradehash");
  invalidateQueriesMock.mockResolvedValue(undefined);
});

describe("UpgradeBanner — visibility", () => {
  it("needs-upgrade + address + impl + not dismissed -> visible", () => {
    renderBanner();
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
    expect(screen.getByTestId("upgrade-banner").getAttribute("role")).toBe("status");
  });

  it.each([
    ["current", IMPL],
    ["not-deployed", IMPL],
    ["no-canonical", IMPL],
    ["needs-upgrade", ZERO_ADDR],
  ])("status=%s impl=%s -> hidden", (status, impl) => {
    useAccountVersionMock.mockReturnValue({ status, canonicalImpl: impl });
    const { container } = renderBanner();
    expect(container.querySelector("[data-testid='upgrade-banner']")).toBeNull();
  });

  it("no effectiveAddress -> hidden", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { container } = renderBanner();
    expect(container.querySelector("[data-testid='upgrade-banner']")).toBeNull();
  });

  it("dismissed for this address + impl -> hidden", () => {
    getStoredStringMock.mockImplementation((k: string) =>
      k === `blank:upgrade_banner_dismissed:${ME.toLowerCase()}:${IMPL}` ? "1" : null,
    );
    const { container } = renderBanner();
    expect(container.querySelector("[data-testid='upgrade-banner']")).toBeNull();
  });

  it("a dismissal for an older impl does not hide the prompt for a newer one", () => {
    getStoredStringMock.mockImplementation((k: string) =>
      k.endsWith(":0xdddddddddddddddddddddddddddddddddddddddd") ? "1" : null,
    );
    renderBanner();
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
  });
});

describe("UpgradeBanner — copy", () => {
  it("states what changes and what stays the same", () => {
    renderBanner();
    expect(screen.getByText(/Security update for your smart wallet/)).toBeInTheDocument();
    expect(screen.getByText(/bound to this account and this chain/)).toBeInTheDocument();
    expect(screen.getByText(/address, balances and\s+passkey stay the same/)).toBeInTheDocument();
  });

  it("says the upgrade pays its own gas", () => {
    renderBanner();
    expect(screen.getByTestId("upgrade-banner-gas").textContent).toMatch(/not sponsored/);
  });
});

describe("UpgradeBanner — self-paid gas gate", () => {
  it("insufficient gas -> CTA disabled + 'Add gas' link to the wallet screen", () => {
    useAccountGasFundsMock.mockReturnValue({ totalWei: 1n });
    renderBanner();
    expect((screen.getByTestId("upgrade-banner-cta") as HTMLButtonElement).disabled).toBe(true);
    const link = screen.getByText("Add gas").closest("a");
    expect(link?.getAttribute("href")).toBe("/app/wallet");
  });

  it("gas balance still loading -> CTA disabled", () => {
    useAccountGasFundsMock.mockReturnValue({ totalWei: null });
    renderBanner();
    expect((screen.getByTestId("upgrade-banner-cta") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("upgrade-banner-gas").textContent).toMatch(/Checking/);
  });

  it("enough gas -> CTA enabled", () => {
    renderBanner();
    expect((screen.getByTestId("upgrade-banner-cta") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("UpgradeBanner — upgrade", () => {
  it("unifiedWrite: execute(self, 0, upgradeToAndCall(impl, 0x)), self-paid, 600k gas", async () => {
    renderBanner();
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.address).toBe(ME);
    expect(call.functionName).toBe("execute");
    expect(call.args[0]).toBe(ME);
    expect(call.args[1]).toBe(0n);
    // upgradeToAndCall selector 0x4f1ef286 + impl
    expect(call.args[2].slice(0, 10)).toBe("0x4f1ef286");
    expect(call.args[2].toLowerCase()).toContain(IMPL.slice(2));
    expect(call.paymaster).toBe("self");
    expect(call.gas).toBe(600_000n);
  });

  it("success: invalidates the impl and gas-funds queries + success toast", async () => {
    renderBanner();
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["blank-account-impl"] });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["account-gas-funds"] });
  });

  it("failure: error toast, banner stays, no invalidation", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("Your smart wallet has no gas for this."));
    renderBanner();
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
  });

  it("busy: label 'Upgrading…' while in flight", async () => {
    let resolve!: (v: string) => void;
    unifiedWriteMock.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    renderBanner();
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(screen.getByTestId("upgrade-banner-cta").textContent).toContain("Upgrading"));
    resolve("0xh");
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
  });
});

describe("UpgradeBanner — dismissal", () => {
  it("Dismiss stores a per-address, per-impl key and hides the banner", () => {
    renderBanner();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(setStoredStringMock).toHaveBeenCalledWith(
      `blank:upgrade_banner_dismissed:${ME.toLowerCase()}:${IMPL}`,
      "1",
    );
    expect(screen.queryByTestId("upgrade-banner")).toBeNull();
    expect(unifiedWriteMock).not.toHaveBeenCalled();
  });

  it("address change re-reads dismissal (no cross-user leak)", () => {
    getStoredStringMock.mockImplementation((k: string) => (k.includes(ME.toLowerCase()) ? "1" : null));
    const { rerender } = renderBanner();
    expect(screen.queryByTestId("upgrade-banner")).toBeNull();
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: OTHER });
    rerender(
      <MemoryRouter>
        <UpgradeBanner />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
  });
});
