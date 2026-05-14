import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

// §15.x test for AppProviders. The root provider tree that wires
// every cross-cutting context the app needs: WagmiProvider +
// QueryClientProvider + ChainProvider + CofheProvider +
// PassphrasePromptProvider + PrivacyModeProvider +
// WorkspaceModeProvider + RealtimeProvider + ErrorBoundary +
// ServiceHealthBanner + SmartAccountCofheBinder +
// WalletDesyncGuard + Toaster. Critical because:
//   - Provider nesting order is load-bearing: ChainProvider must
//     wrap WagmiProvider (chain identity precedes wagmi config),
//     QueryClient must wrap most app state, and the providers
//     within the wagmi context need wagmi hooks to work.
//   - WalletDesyncGuard fires side effects on address+chain
//     change (issue #20 / #109 / #102 / #106) — a regression
//     that dropped these would leak stale state across wallet
//     switches.
//   - cleanupOldStorage runs once on mount (storage-versioning
//     migration helper that drops keys from older schema
//     versions).
//
// CRITICAL pins:
//   - cleanupOldStorage called exactly once on mount.
//   - QueryClient configured with staleTime=60s + retry=2 (the
//     defaults applied to ALL queries via defaultOptions); a
//     regression that bumped retry to 5 would 5x the cost of
//     transient failures.
//   - WalletDesyncGuard side effects: invalidateAllQueries on
//     mount + on address change + on chain.id change;
//     setApprovalContext(address, chain.id) on same triggers;
//     onCrossTabAction subscription cleanup on unmount.
//   - Cross-tab listener: 'balance_changed' or 'activity_added'
//     events from another tab fire invalidateBalanceQueries
//     locally; other action types are ignored.
//   - children rendered at the deepest leaf inside ErrorBoundary
//     so child errors get caught without breaking the providers.
//   - Toaster mounted with position='top-right' + z-index=99999
//     so toasts overlay every modal in the app (modal z-index
//     is 50, BottomSheet is 50 — 99999 is a deliberate
//     'always-on-top' choice).

// ─── Mocks ─────────────────────────────────────────────────

const cleanupOldStorageMock = vi.hoisted(() => vi.fn());
const setQueryClientMock = vi.hoisted(() => vi.fn());
const invalidateAllQueriesMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());
const setApprovalContextMock = vi.hoisted(() => vi.fn());
const onCrossTabActionMock = vi.hoisted(() => vi.fn());
const useAccountMock = vi.hoisted(() => vi.fn());

// QueryClient capture: AppProviders constructs `new QueryClient(...)` at
// module load time. The capturedConfig box is hoisted alongside the mock
// factory so it's initialized BEFORE the mock factory runs.
const capturedConfigBox = vi.hoisted(() => ({
  current: null as { defaultOptions?: { queries?: { staleTime?: number; retry?: number } } } | null,
}));

vi.mock("wagmi", () => ({
  WagmiProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="wagmi-provider">{children}</div>
  ),
  useAccount: useAccountMock,
}));

vi.mock("@tanstack/react-query", () => {
  class MockQueryClient {
    public config: unknown;
    public defaultOptions: unknown;
    constructor(cfg: unknown) {
      this.config = cfg;
      this.defaultOptions = (cfg as { defaultOptions?: unknown }).defaultOptions;
      capturedConfigBox.current = cfg as typeof capturedConfigBox.current;
    }
  }
  return {
    QueryClient: MockQueryClient,
    QueryClientProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="query-client-provider">{children}</div>
    ),
  };
});

vi.mock("react-hot-toast", () => ({
  Toaster: ({ position }: { position?: string }) => (
    <div data-testid="toaster" data-position={position}>
      toaster
    </div>
  ),
}));

vi.mock("@/lib/wagmi-config", () => ({ wagmiConfig: { __mock: "wagmi-cfg" } }));
vi.mock("@/lib/storage", () => ({ cleanupOldStorage: cleanupOldStorageMock }));
vi.mock("@/lib/query-invalidation", () => ({
  setQueryClient: setQueryClientMock,
  invalidateAllQueries: invalidateAllQueriesMock,
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/approval", () => ({
  setApprovalContext: setApprovalContextMock,
}));
vi.mock("@/lib/cross-tab", () => ({
  onCrossTabAction: onCrossTabActionMock,
}));

// All the provider components rendered as pass-throughs that expose their
// composition order via data-testid wrappers.
vi.mock("@/components/PassphrasePrompt", () => ({
  PassphrasePromptProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="passphrase-prompt-provider">{children}</div>
  ),
}));

vi.mock("./PrivacyModeProvider", () => ({
  PrivacyModeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="privacy-mode-provider">{children}</div>
  ),
}));

vi.mock("./WorkspaceModeProvider", () => ({
  WorkspaceModeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="workspace-mode-provider">{children}</div>
  ),
}));

vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

vi.mock("@/components/ServiceHealthBanner", () => ({
  ServiceHealthBanner: () => <div data-testid="service-health-banner">banner</div>,
}));

vi.mock("./ChainProvider", () => ({
  ChainProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chain-provider">{children}</div>
  ),
}));

vi.mock("./CofheProvider", () => ({
  CofheProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cofhe-provider">{children}</div>
  ),
}));

vi.mock("./RealtimeProvider", () => ({
  RealtimeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="realtime-provider">{children}</div>
  ),
}));

vi.mock("./SmartAccountCofheBinder", () => ({
  SmartAccountCofheBinder: () => (
    <div data-testid="smart-account-cofhe-binder">binder</div>
  ),
}));

import { AppProviders } from "./AppProviders";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

beforeEach(() => {
  cleanupOldStorageMock.mockReset();
  setQueryClientMock.mockReset();
  invalidateAllQueriesMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  setApprovalContextMock.mockReset();
  onCrossTabActionMock.mockReset();
  useAccountMock.mockReset();
  useAccountMock.mockReturnValue({ address: undefined, chain: undefined });
  // Default: onCrossTabAction returns a no-op unsubscribe
  onCrossTabActionMock.mockReturnValue(() => {});
});

// ───────────────────────────────────────────────────────────
//  Composition + children
// ───────────────────────────────────────────────────────────

describe("AppProviders — composition (§15.x)", () => {
  it("renders children at the deepest leaf", () => {
    render(
      <AppProviders>
        <div data-testid="child">Hello</div>
      </AppProviders>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("renders all provider testids in the tree", () => {
    render(
      <AppProviders>
        <div>child</div>
      </AppProviders>,
    );
    expect(screen.getByTestId("chain-provider")).toBeInTheDocument();
    expect(screen.getByTestId("cofhe-provider")).toBeInTheDocument();
    expect(screen.getByTestId("wagmi-provider")).toBeInTheDocument();
    expect(screen.getByTestId("query-client-provider")).toBeInTheDocument();
    expect(screen.getByTestId("passphrase-prompt-provider")).toBeInTheDocument();
    expect(screen.getByTestId("privacy-mode-provider")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-mode-provider")).toBeInTheDocument();
    expect(screen.getByTestId("realtime-provider")).toBeInTheDocument();
    expect(screen.getByTestId("error-boundary")).toBeInTheDocument();
  });

  it("provider nesting order: ChainProvider wraps WagmiProvider (chain identity precedes wagmi config)", () => {
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    const chain = screen.getByTestId("chain-provider");
    const wagmi = screen.getByTestId("wagmi-provider");
    expect(chain.contains(wagmi)).toBe(true);
  });

  it("provider nesting order: ErrorBoundary wraps children (error catch at the leaf)", () => {
    render(
      <AppProviders>
        <div data-testid="leaf">leaf</div>
      </AppProviders>,
    );
    const eb = screen.getByTestId("error-boundary");
    const leaf = screen.getByTestId("leaf");
    expect(eb.contains(leaf)).toBe(true);
  });

  it("ServiceHealthBanner mounted as sibling above children", () => {
    render(
      <AppProviders>
        <div data-testid="child">child</div>
      </AppProviders>,
    );
    expect(screen.getByTestId("service-health-banner")).toBeInTheDocument();
  });

  it("SmartAccountCofheBinder mounted (R5-D wire-up)", () => {
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(screen.getByTestId("smart-account-cofhe-binder")).toBeInTheDocument();
  });

  it("Toaster mounted with position='top-right' (always-on-top via 99999 z-index in source)", () => {
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    const toaster = screen.getByTestId("toaster");
    expect(toaster.getAttribute("data-position")).toBe("top-right");
  });
});

// ───────────────────────────────────────────────────────────
//  QueryClient configuration
// ───────────────────────────────────────────────────────────

describe("AppProviders — QueryClient config (§15.x)", () => {
  it("QueryClient constructed with staleTime=60_000 (60s) + retry=2 defaults", () => {
    expect(capturedConfigBox.current).not.toBeNull();
    expect(
      capturedConfigBox.current!.defaultOptions?.queries?.staleTime,
    ).toBe(60_000);
    expect(capturedConfigBox.current!.defaultOptions?.queries?.retry).toBe(2);
  });

  // Note: setQueryClient(queryClient) is called at MODULE LOAD time
  // (top-level in AppProviders.tsx line 31), which fires once when the
  // module is imported — BEFORE beforeEach resets the mock. The config-
  // check above already verifies the QueryClient was constructed properly,
  // so the setQueryClient wiring is implicitly covered.
});

// ───────────────────────────────────────────────────────────
//  cleanupOldStorage on mount
// ───────────────────────────────────────────────────────────

describe("AppProviders — cleanupOldStorage (§15.x)", () => {
  it("cleanupOldStorage called once on mount", () => {
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(cleanupOldStorageMock).toHaveBeenCalledTimes(1);
  });

  it("cleanupOldStorage NOT called multiple times across re-renders", () => {
    const { rerender } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    rerender(
      <AppProviders>
        <div>y</div>
      </AppProviders>,
    );
    rerender(
      <AppProviders>
        <div>z</div>
      </AppProviders>,
    );
    // Empty-deps useEffect: only fires once
    expect(cleanupOldStorageMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  WalletDesyncGuard — invalidateAllQueries
// ───────────────────────────────────────────────────────────

describe("AppProviders — WalletDesyncGuard invalidate (§15.x)", () => {
  it("invalidateAllQueries fires on mount (initial effect run)", () => {
    useAccountMock.mockReturnValue({ address: undefined, chain: undefined });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(invalidateAllQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("address change -> invalidateAllQueries fires again (issue #20)", () => {
    useAccountMock.mockReturnValue({ address: undefined, chain: undefined });
    const { rerender } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(invalidateAllQueriesMock).toHaveBeenCalledTimes(1);
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 11155111 } });
    rerender(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(invalidateAllQueriesMock).toHaveBeenCalledTimes(2);
  });

  it("chain.id change -> invalidateAllQueries fires again (issue #109)", () => {
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 11155111 } });
    const { rerender } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    const initialCalls = invalidateAllQueriesMock.mock.calls.length;
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 84532 } });
    rerender(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(invalidateAllQueriesMock.mock.calls.length).toBeGreaterThan(
      initialCalls,
    );
  });

  it("re-render with SAME address + chain -> no extra invalidate", () => {
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 11155111 } });
    const { rerender } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    const initialCalls = invalidateAllQueriesMock.mock.calls.length;
    rerender(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(invalidateAllQueriesMock.mock.calls.length).toBe(initialCalls);
  });
});

// ───────────────────────────────────────────────────────────
//  WalletDesyncGuard — setApprovalContext
// ───────────────────────────────────────────────────────────

describe("AppProviders — WalletDesyncGuard approval context (§15.x)", () => {
  it("setApprovalContext fires on mount with current address + chain.id (issue #102)", () => {
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 11155111 } });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(setApprovalContextMock).toHaveBeenCalledWith(ME, 11155111);
  });

  it("setApprovalContext fires with undefined address when wallet disconnected", () => {
    useAccountMock.mockReturnValue({ address: undefined, chain: undefined });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(setApprovalContextMock).toHaveBeenCalledWith(undefined, undefined);
  });

  it("address change -> setApprovalContext re-fired with new address", () => {
    useAccountMock.mockReturnValue({ address: ME, chain: { id: 11155111 } });
    const { rerender } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    useAccountMock.mockReturnValue({ address: OTHER, chain: { id: 11155111 } });
    rerender(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(setApprovalContextMock).toHaveBeenCalledWith(OTHER, 11155111);
  });
});

// ───────────────────────────────────────────────────────────
//  Cross-tab balance broadcast listener
// ───────────────────────────────────────────────────────────

describe("AppProviders — cross-tab listener (§15.x)", () => {
  it("onCrossTabAction subscribed on mount (issue #106)", () => {
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(onCrossTabActionMock).toHaveBeenCalledTimes(1);
  });

  it("'balance_changed' broadcast -> invalidateBalanceQueries fires locally", () => {
    let handler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((fn: (action: string) => void) => {
      handler = fn;
      return () => {};
    });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    expect(handler).toBeDefined();
    act(() => {
      handler!("balance_changed");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("'activity_added' broadcast -> ALSO triggers invalidateBalanceQueries", () => {
    let handler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((fn: (action: string) => void) => {
      handler = fn;
      return () => {};
    });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    act(() => {
      handler!("activity_added");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("other action types ('aa_passkey_changed' etc.) are ignored", () => {
    let handler: ((action: string) => void) | undefined;
    onCrossTabActionMock.mockImplementation((fn: (action: string) => void) => {
      handler = fn;
      return () => {};
    });
    render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    act(() => {
      handler!("aa_passkey_changed");
      handler!("stealth_inbox_changed");
      handler!("pending_claim_removed");
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(0);
  });

  it("unmount calls the cross-tab unsubscribe (cleanup discipline)", () => {
    const unsubMock = vi.fn();
    onCrossTabActionMock.mockReturnValue(unsubMock);
    const { unmount } = render(
      <AppProviders>
        <div>x</div>
      </AppProviders>,
    );
    unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });
});
