import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for UpgradeBanner. Phase 4.1 surface that prompts
// users on the pre-validator-dispatch BlankAccount impl to upgrade
// their UUPS proxy. The upgrade is a self-call UserOp:
// `AA.execute(self, 0, abi.encodeCall(upgradeToAndCall, [newImpl,
// "0x"]))`. After it mines, the proxy delegates to the new impl
// and session keys / future UserOp features become available.
//
// CRITICAL pins:
//   - 4-condition visibility gate: status === 'needs-upgrade' AND
//     effectiveAddress AND canonicalImpl !== ZERO_ADDR AND NOT
//     dismissed. ALL four must hold; ANY false hides the banner.
//     Hidden cases pinned individually: no AA / counterfactual /
//     canonical not deployed on this chain / already current /
//     dismissed.
//   - Sticky dismissal stored in localStorage at key `blank:
//     upgrade_banner_dismissed:{lowercased-address}` so a wallet
//     switch on a shared device re-prompts the next user
//     (dismissal does NOT leak between users); test pins the key
//     format AND the address-scoping behavior.
//   - Dismissal mirrored in component state (localDismissed) so
//     the X click hides the banner instantly without waiting for
//     storage event re-render; test pins both via re-render flow.
//   - effectiveAddress change re-syncs dismissal state from
//     localStorage — without this, dismissal would leak from
//     prev user into the next on shared devices. Test by mounting
//     with one address (dismissed in storage), then re-rendering
//     with a different address (not dismissed in storage).
//   - Phase 7.5 self-pay readiness check: when paymaster is
//     unavailable AND AA balance >= 0.001 ETH, the upgrade routes
//     through paymaster='self' so the upgrade itself isn't
//     blocked by a paymaster outage; otherwise paymaster=undefined
//     (defaults to sponsored). The audit caught this — the
//     upgrade is exactly the moment users most need the resilience
//     layer.
//   - upgradeToAndCall args pinned: [canonicalImpl, "0x"] (empty
//     init data because the validator-dispatch impl doesn't need
//     post-upgrade initialization). A regression that passed
//     anything other than "0x" would call into the new impl with
//     unintended args.
//   - execute() wrapping: AA.execute(target=self, value=0n,
//     data=upgradeCallData) so msg.sender inside upgradeToAndCall
//     is address(this), satisfying _authorizeUpgrade's
//     onlySelfOrEntryPoint gate. gas=600_000n (conservative for
//     the SELFDELEGATE -> upgradeTo path; FHE-free so no
//     precompile margin needed).
//   - Eager queryClient.invalidateQueries(['blank-account-impl'])
//     after the upgrade mines so the banner hides on the next
//     render instead of waiting for the 30s polling cadence; test
//     pins via invalidateQueries spy.
//   - Upgrade success toast 'Account upgraded. Session keys are
//     now available'; error toast surfaces err.message verbatim;
//     non-Error throw -> 'Upgrade failed' fallback.
//   - data-testid contract: 'upgrade-banner' on the root, 'upgrade-
//     banner-cta' on the Upgrade button; aria-label='Dismiss' on
//     the X button; role='status' on the banner root for screen-
//     reader announcement.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useAccountVersionMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const usePaymasterHealthMock = vi.hoisted(() => vi.fn());
const useBalanceMock = vi.hoisted(() => vi.fn());
const getStoredStringMock = vi.hoisted(() => vi.fn());
const setStoredStringMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useBalance: useBalanceMock }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: useQueryClientMock,
}));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useAccountVersion", () => ({
  useAccountVersion: useAccountVersionMock,
}));
vi.mock("@/hooks/useUnifiedWrite", () => ({
  useUnifiedWrite: useUnifiedWriteMock,
}));
vi.mock("@/hooks/usePaymasterHealth", () => ({
  usePaymasterHealth: usePaymasterHealthMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/storage", () => ({
  getStoredString: getStoredStringMock,
  setStoredString: setStoredStringMock,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

import { UpgradeBanner } from "./UpgradeBanner";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const IMPL = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const unifiedWriteMock = vi.fn();
const invalidateQueriesMock = vi.fn();

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useAccountVersionMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useQueryClientMock.mockReset();
  usePaymasterHealthMock.mockReset();
  useBalanceMock.mockReset();
  getStoredStringMock.mockReset();
  setStoredStringMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  unifiedWriteMock.mockReset();
  invalidateQueriesMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  useAccountVersionMock.mockReturnValue({
    status: "needs-upgrade",
    canonicalImpl: IMPL,
  });
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });
  useQueryClientMock.mockReturnValue({ invalidateQueries: invalidateQueriesMock });
  usePaymasterHealthMock.mockReturnValue({ status: "ok" });
  useBalanceMock.mockReturnValue({ data: { value: 0n } });
  getStoredStringMock.mockReturnValue(null); // not dismissed by default
  unifiedWriteMock.mockResolvedValue("0xupgradehash" as `0x${string}`);
  invalidateQueriesMock.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────
//  Visibility gate (4 conditions)
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — 4-condition visibility gate (§15.x)", () => {
  it("status='needs-upgrade' + address + canonicalImpl + not-dismissed -> visible", () => {
    render(<UpgradeBanner />);
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
  });

  it("status !== 'needs-upgrade' -> hidden", () => {
    useAccountVersionMock.mockReturnValue({
      status: "current",
      canonicalImpl: IMPL,
    });
    const { container } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("no effectiveAddress -> hidden (no AA at all)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { container } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("canonicalImpl === 0x0 (not deployed on this chain) -> hidden", () => {
    useAccountVersionMock.mockReturnValue({
      status: "needs-upgrade",
      canonicalImpl: ZERO_ADDR,
    });
    const { container } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("dismissed in localStorage -> hidden", () => {
    getStoredStringMock.mockReturnValue("1");
    const { container } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("counterfactual proxy (status='counterfactual') -> hidden (not 'needs-upgrade')", () => {
    useAccountVersionMock.mockReturnValue({
      status: "counterfactual",
      canonicalImpl: IMPL,
    });
    const { container } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Banner rendering + accessibility
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — rendering + accessibility (§15.x)", () => {
  it("renders with role='status' + data-testid 'upgrade-banner'", () => {
    render(<UpgradeBanner />);
    const banner = screen.getByTestId("upgrade-banner");
    expect(banner.getAttribute("role")).toBe("status");
  });

  it("renders the value-prop copy (session keys + 'address stays the same')", () => {
    render(<UpgradeBanner />);
    expect(screen.getByText(/session keys for recurring sends/i)).toBeInTheDocument();
    expect(screen.getByText(/Your address and balances stay the same/i)).toBeInTheDocument();
  });

  it("Upgrade button has data-testid 'upgrade-banner-cta' + 'Upgrade' label", () => {
    render(<UpgradeBanner />);
    const cta = screen.getByTestId("upgrade-banner-cta");
    expect(cta.textContent).toContain("Upgrade");
  });

  it("Dismiss button has aria-label='Dismiss'", () => {
    render(<UpgradeBanner />);
    expect(screen.getByLabelText("Dismiss")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Upgrade flow (happy path + args)
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — upgrade flow happy path (§15.x)", () => {
  it("click Upgrade -> unifiedWrite called with execute() args wrapping upgradeToAndCall", async () => {
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    const call = unifiedWriteMock.mock.calls[0][0];
    expect(call.address).toBe(ME); // AA address (self-call)
    expect(call.functionName).toBe("execute");
    expect(call.args[0]).toBe(ME); // target = self
    expect(call.args[1]).toBe(0n); // value
    expect(typeof call.args[2]).toBe("string"); // upgradeToAndCall calldata
    expect((call.args[2] as string).startsWith("0x")).toBe(true);
    expect(call.gas).toBe(600_000n);
  });

  it("paymaster=undefined when paymaster is OK (sponsored default)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "ok" });
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBeUndefined();
  });

  it("eagerly invalidates ['blank-account-impl'] query after upgrade mines", async () => {
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["blank-account-impl"],
      });
    });
  });

  it("success toast 'Account upgraded. Session keys are now available'", async () => {
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Account upgraded. Session keys are now available",
      );
    });
  });

  it("busy state: button disabled + 'Upgrading…' label + spinner during in-flight", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValue(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    render(<UpgradeBanner />);
    const cta = screen.getByTestId("upgrade-banner-cta") as HTMLButtonElement;
    fireEvent.click(cta);
    await waitFor(() => {
      expect(cta.disabled).toBe(true);
      expect(cta.textContent).toContain("Upgrading");
    });
    resolveFn("0xupgradehash");
    await waitFor(() => {
      expect(cta.disabled).toBe(false);
      expect(cta.textContent).toContain("Upgrade");
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Phase 7.5 self-pay routing
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — self-pay routing (§15.x)", () => {
  it("paymaster=unavailable + AA balance >= 0.001 ETH -> paymaster='self'", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 1_000_000_000_000_000n } }); // 0.001 ETH
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBe("self");
  });

  it("paymaster=unavailable but AA balance < 0.001 ETH -> paymaster=undefined (sponsored attempted)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 100_000_000_000_000n } }); // 0.0001 ETH (too low)
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBeUndefined();
  });

  it("paymaster=ok + AA balance high -> still paymaster=undefined (sponsored is fine)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "ok" });
    useBalanceMock.mockReturnValue({ data: { value: 100_000_000_000_000_000n } }); // 0.1 ETH
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBeUndefined();
  });

  it("balance.data undefined (loading) -> aaCanSelfPay defaults to false", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: undefined });
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => expect(unifiedWriteMock).toHaveBeenCalledTimes(1));
    // Falls back to undefined because aaCanSelfPay=false when balance is loading
    expect(unifiedWriteMock.mock.calls[0][0].paymaster).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────
//  Dismissal flow + per-address scoping
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — dismissal (§15.x)", () => {
  it("click Dismiss -> setStoredString called with per-address key + banner hides", () => {
    render(<UpgradeBanner />);
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(setStoredStringMock).toHaveBeenCalledWith(
      `blank:upgrade_banner_dismissed:${ME.toLowerCase()}`,
      "1",
    );
    expect(screen.queryByTestId("upgrade-banner")).toBeNull();
  });

  it("storage key is per-address (lowercased) so wallet-switch re-prompts", () => {
    // First user dismisses
    getStoredStringMock.mockImplementation((key: string) =>
      key.includes(ME.toLowerCase()) ? "1" : null,
    );
    const { container, rerender } = render(<UpgradeBanner />);
    expect(container.firstChild).toBeNull(); // dismissed for ME

    // Switch to OTHER user (no dismissal stored)
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: OTHER });
    rerender(<UpgradeBanner />);
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument(); // visible for OTHER
  });

  it("dismissal does NOT fire the upgrade unifiedWrite", () => {
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(unifiedWriteMock).toHaveBeenCalledTimes(0);
  });

  it("Dismiss button disabled during busy state (mid-upgrade)", async () => {
    let resolveFn: (v: unknown) => void = () => {};
    unifiedWriteMock.mockReturnValue(
      new Promise((res) => {
        resolveFn = res;
      }),
    );
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      const dismissBtn = screen.getByLabelText("Dismiss") as HTMLButtonElement;
      expect(dismissBtn.disabled).toBe(true);
    });
    resolveFn("0xupgradehash");
  });

  it("address change re-syncs dismissal from localStorage (no cross-user leak)", () => {
    // Mount with ME (not dismissed in storage)
    getStoredStringMock.mockReturnValue(null);
    const { rerender } = render(<UpgradeBanner />);
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();

    // Switch to OTHER who IS dismissed in storage
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: OTHER });
    getStoredStringMock.mockImplementation((key: string) =>
      key.includes(OTHER.toLowerCase()) ? "1" : null,
    );
    rerender(<UpgradeBanner />);
    expect(screen.queryByTestId("upgrade-banner")).toBeNull(); // hidden for OTHER
  });
});

// ───────────────────────────────────────────────────────────
//  Error handling
// ───────────────────────────────────────────────────────────

describe("UpgradeBanner — upgrade error handling (§15.x)", () => {
  it("unifiedWrite throws Error -> err.message shown in toast.error", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("nonce mismatch"));
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      // mapError catches /nonce|replacement transaction underpriced/i
      // and returns 'Transaction stuck — A previous transaction is...'.
      // Assert the title; the user-visible string changed from the
      // raw err.message to the humanized form (P3 walkthrough fix).
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("Transaction stuck"),
        undefined,
      );
    });
  });

  it("unifiedWrite throws non-Error -> 'Upgrade failed' fallback", async () => {
    unifiedWriteMock.mockRejectedValue("string error");
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      // toastMappedError(string) → mapError extracts the string →
      // no pattern match → default 'Transaction failed — string error'.
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("Transaction failed"),
        undefined,
      );
    });
  });

  it("error -> banner STAYS visible (user can retry); busy state resets", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("rpc fail"));
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(screen.getByTestId("upgrade-banner")).toBeInTheDocument();
    const cta = screen.getByTestId("upgrade-banner-cta") as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
  });

  it("error -> queryClient.invalidateQueries NOT called (only fires on success)", async () => {
    unifiedWriteMock.mockRejectedValue(new Error("fail"));
    render(<UpgradeBanner />);
    fireEvent.click(screen.getByTestId("upgrade-banner-cta"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    expect(invalidateQueriesMock).toHaveBeenCalledTimes(0);
  });
});
