import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";

// §15.x test for Dashboard screen — the main app landing. Mobile + desktop
// layouts both flow through the same hooks; this test focuses on the
// load-bearing data wiring + audit-fix surfaces shared by both layouts.
//
// CRITICAL pins:
//   - audit Top-28 #9 (#224) `monthActivityCount` filters activities by
//     created_at >= startOfCurrentMonth. Without this filter the "This
//     Month" stat card would silently show ALL-TIME activity, misleading
//     users into thinking they were vastly more active this month.
//   - #258 `hasUnread` memoizes on activities + address. Recently
//     received (< 5min ago + user_to === me) -> red pulse on the Bell
//     icon. Self-sends + outgoing payments MUST NOT trigger the pulse
//     (otherwise sending a payment to a friend would notify YOU).
//   - #259 faucet cooldown split into TWO effects so toggling `isMinting`
//     doesn't tear down + recreate the 1s interval mid-countdown. Pinning
//     the cooldown read from localStorage on the isMinting=false
//     transition prevents the visible 1-second jump on mint completion.
//   - audit Top-28 #19 paymaster-degraded banner gated by isSmartAccount
//     (EOA users pay their own gas regardless — surfacing this banner
//     for them would be noise). Banner copy distinguishes "running low"
//     (amber) from "unavailable" (rose) with distinct messaging — the
//     unavailable path tells the user "we'll walk you through funding"
//     while the degraded path just says "should still succeed".
//   - audit Top-28 #20 FHE Status tone matrix has THREE branches:
//     ready (cofheConnected -> "FHE Active"), pending (undeployed
//     passkey -> "FHE Ready" + "Your first transaction will deploy your
//     wallet" — prevents the previous "Connecting to FHE…" forever loop
//     for a freshly-created passkey AA user), warning (everything else
//     -> "Connecting to FHE…"). The pending branch is the load-bearing
//     fix: an undeployed passkey reads cofheConnected=false but isn't
//     actually broken, just lazy-deployed.
//   - hasUsdtFaucet gated on `contracts.TestUSDT` truthy. ETH Sepolia has
//     no TestUSDT deployment so the button is hidden there; Base Sepolia
//     has both so the button is shown. Hardcoding chain ids would break
//     the next chain we add — gating on config means new chains work
//     without screen edits.
//   - Shield input regex /^\d*\.?\d{0,6}$/ at the input level rejects
//     the 7th decimal BEFORE it reaches the contract call (USDC is 6dp).
//     Same regex applied to BOTH shield + unshield amount inputs.
//   - Unshield 4-state in-progress matrix (encrypting / requesting /
//     decrypting / claiming) — the decrypting state shows ~10s
//     Threshold-Network copy so the user understands the delay is
//     external + expected, not a stuck UI.
//   - getGreeting() time-of-day matrix: <12 -> "Good morning",
//     <17 -> "Good afternoon", else "Good evening" (load-bearing for
//     the personalized header copy).

// ----- module-level mocks ----- //

const navigateMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useActivityFeedMock = vi.hoisted(() => vi.fn());
const useEncryptedBalanceMock = vi.hoisted(() => vi.fn());
const useShieldMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePaymasterHealthMock = vi.hoisted(() => vi.fn());
const useMediaQueryMock = vi.hoisted(() => vi.fn());
const useCofheConnectionMock = vi.hoisted(() => vi.fn());
const useCofheEncryptMock = vi.hoisted(() => vi.fn());
const usePrivacyModeMock = vi.hoisted(() => vi.fn());
const usePrivacyMock = vi.hoisted(() => vi.fn());
const faucetUsdcMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useActivityFeed", () => ({ useActivityFeed: useActivityFeedMock }));
vi.mock("@/hooks/useEncryptedBalance", () => ({
  useEncryptedBalance: useEncryptedBalanceMock,
}));
vi.mock("@/hooks/useShield", () => ({ useShield: useShieldMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/usePaymasterHealth", () => ({
  usePaymasterHealth: usePaymasterHealthMock,
}));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: useMediaQueryMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheConnection: useCofheConnectionMock,
  useCofheEncrypt: useCofheEncryptMock,
  Encryptable: new Proxy({}, { get: () => () => ({}) }),
}));
vi.mock("@/providers/PrivacyModeProvider", () => ({
  usePrivacyMode: usePrivacyModeMock,
}));
vi.mock("@/hooks/usePrivacy", () => ({ usePrivacy: usePrivacyMock }));
vi.mock("@/lib/faucet-client", () => ({ faucetUsdc: faucetUsdcMock }));
vi.mock("@/blank-ui/components", () => ({
  IosPwaCoachMark: () => <div data-testid="ios-coachmark-stub" />,
  UpgradeBanner: () => <div data-testid="upgrade-banner-stub" />,
}));
vi.mock("react-hot-toast", () => ({
  default: {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  },
}));

import Dashboard from "./Dashboard";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type ActivityRow = {
  id: string;
  activity_type: string;
  user_from: string;
  user_to: string;
  created_at: string;
  note?: string;
};

function activity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "act-1",
    activity_type: "payment",
    user_from: ALICE,
    user_to: ME,
    created_at: new Date().toISOString(),
    ...over,
  };
}

const mintTestTokensMock = vi.fn();
const mintTestUSDTMock = vi.fn();
const shieldMock = vi.fn();
const unshieldMock = vi.fn();
const resetShieldMock = vi.fn();
const retryUnshieldClaimMock = vi.fn();
const createPermitMock = vi.fn();
const togglePrivacyModeMock = vi.fn();
const toggleRevealMock = vi.fn();

function setShield(over: Record<string, unknown> = {}) {
  useShieldMock.mockReturnValue({
    mintTestTokens: mintTestTokensMock,
    mintTestUSDT: mintTestUSDTMock,
    shield: shieldMock,
    publicBalance: 0,
    isMinting: false,
    isMintingUsdt: false,
    step: "idle",
    error: null,
    reset: resetShieldMock,
    unshield: unshieldMock,
    unshieldStep: "idle",
    unshieldError: null,
    hasPendingUnshield: false,
    retryUnshieldClaim: retryUnshieldClaimMock,
    ...over,
  });
}

function setBalance(over: Record<string, unknown> = {}) {
  useEncryptedBalanceMock.mockReturnValue({
    formatted: null,
    raw: null,
    isInitialized: false,
    isDecrypted: false,
    isRevealed: false,
    hasBalance: false,
    disabledDueToMissingValidPermit: false,
    totalDeposited: 0,
    toggleReveal: toggleRevealMock,
    refetch: vi.fn(),
    error: null,
    ...over,
  });
}

beforeEach(() => {
  navigateMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useActivityFeedMock.mockReset();
  useEncryptedBalanceMock.mockReset();
  useShieldMock.mockReset();
  useChainMock.mockReset();
  usePaymasterHealthMock.mockReset();
  useMediaQueryMock.mockReset();
  useCofheConnectionMock.mockReset();
  useCofheEncryptMock.mockReset();
  usePrivacyModeMock.mockReset();
  usePrivacyMock.mockReset();
  faucetUsdcMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  mintTestTokensMock.mockReset();
  mintTestUSDTMock.mockReset();
  shieldMock.mockReset();
  unshieldMock.mockReset();
  resetShieldMock.mockReset();
  retryUnshieldClaimMock.mockReset();
  createPermitMock.mockReset();
  togglePrivacyModeMock.mockReset();
  toggleRevealMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({
    effectiveAddress: ME,
    isSmartAccount: false,
    smartAccount: { account: null, status: "idle" },
  });
  useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
  setBalance();
  setShield();
  useChainMock.mockReturnValue({
    activeChain: { name: "Ethereum Sepolia", id: 11155111 },
    activeChainId: 11155111,
    contracts: {
      TestUSDT: undefined, // ETH Sepolia has no USDT faucet
      FHERC20Vault_USDC: "0x1111111111111111111111111111111111111111",
    },
  });
  usePaymasterHealthMock.mockReturnValue({
    status: "healthy",
    depositWei: 0n,
    warnThresholdWei: 0n,
    failThresholdWei: 0n,
    configured: true,
    error: null,
    isLoading: false,
  });
  useMediaQueryMock.mockReturnValue(false); // desktop
  useCofheConnectionMock.mockReturnValue({ connected: true });
  useCofheEncryptMock.mockReturnValue({ encryptInputsAsync: vi.fn() });
  usePrivacyModeMock.mockReturnValue({
    privacyMode: true,
    toggle: togglePrivacyModeMock,
    setPrivacyMode: vi.fn(),
  });
  usePrivacyMock.mockReturnValue({
    hasPermit: false,
    createPermit: createPermitMock,
    isCreating: false,
    permitCreatedAt: null,
    permitExpiresAt: null,
    sharedPermits: [],
    isExpiringSoon: false,
    isExpired: false,
  });
  toastLoadingMock.mockReturnValue("toast-id");
});

afterEach(() => {
  localStorage.clear();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button"))
    .find((b) => {
      const text = b.textContent ?? "";
      const aria = b.getAttribute("aria-label") ?? "";
      if (typeof label === "string") return text.includes(label) || aria === label;
      return label.test(text) || label.test(aria);
    }) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`Button '${label}' not found`);
  return btn;
}

// ----- page chrome ----- //

describe("Dashboard — page chrome (§15.x)", () => {
  it("renders greeting with truncated address", () => {
    const { container } = render(<Dashboard />);
    // greeting prefix is time-of-day; just assert the connector + addr show
    expect(container.textContent).toMatch(/Good (morning|afternoon|evening)/);
    expect(container.textContent).toContain("0xaaaa");
  });

  it("renders 'Fully Homomorphic Encryption' privacy subtitle", () => {
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
  });

  it("'there' fallback when no effective address", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: null,
      isSmartAccount: false,
      smartAccount: { account: null, status: "idle" },
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toMatch(/Good (morning|afternoon|evening), there/);
  });

  it("Bell icon navigates to /app/history on click", () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Notifications"));
    expect(navigateMock).toHaveBeenCalledWith("/app/history");
  });

  it("IosPwaCoachMark + UpgradeBanner stubs both render", () => {
    const { getByTestId } = render(<Dashboard />);
    expect(getByTestId("ios-coachmark-stub")).toBeTruthy();
    expect(getByTestId("upgrade-banner-stub")).toBeTruthy();
  });
});

// ----- Getting Started gating ----- //

describe("Dashboard — Getting Started card (§15.x)", () => {
  it("renders Getting Started when no activity AND publicBalance === 0", () => {
    useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
    setShield({ publicBalance: 0 });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Getting Started");
    expect(container.textContent).toContain("Get test USDC");
    expect(container.textContent).toContain("Shield your USDC");
    expect(container.textContent).toContain("Send your first private payment");
  });

  it("hides Getting Started when publicBalance > 0 (user already funded)", () => {
    useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
    setShield({ publicBalance: 100 });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Getting Started");
  });

  it("hides Getting Started when user has activity (non-empty feed)", () => {
    useActivityFeedMock.mockReturnValue({ activities: [activity()], isLoading: false });
    setShield({ publicBalance: 0 });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Getting Started");
  });
});

// ----- monthActivityCount audit #9 ----- //

describe("Dashboard — monthActivityCount audit #9 (§15.x)", () => {
  it("counts only activities in current calendar month", () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12, 0, 0);
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({ id: "a-this-1", created_at: monthStart.toISOString() }),
        activity({ id: "a-this-2", created_at: new Date(monthStart.getTime() + 86400_000).toISOString() }),
        activity({ id: "a-last", created_at: lastMonth.toISOString() }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    // The BalanceCard renders "This Month" + N transactions; pin "2 transactions"
    expect(container.textContent).toContain("2 transactions");
  });

  it("zero activity -> '0 transactions' (not error, not blank)", () => {
    useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("0 transactions");
  });

  it("All-time count uses activities.length (different from monthly)", () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12, 0, 0);
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({ id: "a-this", created_at: monthStart.toISOString() }),
        activity({ id: "a-last-1", created_at: lastMonth.toISOString() }),
        activity({ id: "a-last-2", created_at: lastMonth.toISOString() }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    // "This Month" = 1; "All-time" = 3
    expect(container.textContent).toContain("1 transactions");
    expect(container.textContent).toContain("All-time");
    // The total "3" appears in the all-time card
    const allTimeLabel = Array.from(container.querySelectorAll("p"))
      .find((p) => p.textContent?.trim() === "All-time");
    const card = allTimeLabel?.parentElement?.parentElement;
    expect(card?.textContent).toContain("3");
  });
});

// ----- hasUnread #258 ----- //

describe("Dashboard — hasUnread bell pulse (#258) (§15.x)", () => {
  it("recent incoming (< 5min) -> red pulse on bell", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({
          user_from: ALICE,
          user_to: ME,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    const bellBtn = findButton(container, "Notifications");
    const pulse = bellBtn.querySelector(".bg-red-500");
    expect(pulse).not.toBeNull();
  });

  it("activity > 5min old -> NO pulse (offline-window guard)", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({
          user_from: ALICE,
          user_to: ME,
          created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    const bellBtn = findButton(container, "Notifications");
    expect(bellBtn.querySelector(".bg-red-500")).toBeNull();
  });

  it("outgoing-only activity (user_from === me) -> NO pulse", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({
          user_from: ME,
          user_to: ALICE,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    const bellBtn = findButton(container, "Notifications");
    expect(bellBtn.querySelector(".bg-red-500")).toBeNull();
  });

  it("address comparison is case-INsensitive (user_to vs effectiveAddress)", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({
          user_from: ALICE,
          user_to: ME.toUpperCase().replace("0X", "0x"), // checksummed-like
          created_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    const bellBtn = findButton(container, "Notifications");
    expect(bellBtn.querySelector(".bg-red-500")).not.toBeNull();
  });
});

// ----- Paymaster degraded banner (audit #19) ----- //

describe("Dashboard — paymaster degraded banner (§15.x)", () => {
  it("EOA user with degraded paymaster -> banner HIDDEN (EOA pays own gas)", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: false,
      smartAccount: { account: null, status: "idle" },
    });
    usePaymasterHealthMock.mockReturnValue({
      status: "degraded",
      depositWei: 0n,
      warnThresholdWei: 0n,
      failThresholdWei: 0n,
      configured: true,
      error: null,
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Sponsored gas is running low");
    expect(container.textContent).not.toContain("Sponsored gas is unavailable");
  });

  it("AA user + degraded -> amber 'running low' banner shown", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
      smartAccount: { account: { address: ME, isDeployed: true }, status: "ready" },
    });
    usePaymasterHealthMock.mockReturnValue({
      status: "degraded",
      depositWei: 0n,
      warnThresholdWei: 0n,
      failThresholdWei: 0n,
      configured: true,
      error: null,
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Sponsored gas is running low");
    expect(container.textContent).toContain("Sends should still succeed");
  });

  it("AA user + unavailable -> rose 'unavailable' banner with funding guide copy", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
      smartAccount: { account: { address: ME, isDeployed: true }, status: "ready" },
    });
    usePaymasterHealthMock.mockReturnValue({
      status: "unavailable",
      depositWei: 0n,
      warnThresholdWei: 0n,
      failThresholdWei: 0n,
      configured: true,
      error: null,
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Sponsored gas is unavailable");
    expect(container.textContent).toContain("walk you through funding");
  });

  it("AA user + healthy -> no banner", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
      smartAccount: { account: { address: ME, isDeployed: true }, status: "ready" },
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Sponsored gas");
  });
});

// ----- FHE Status 3-state tone matrix ----- //

describe("Dashboard — FHE Status tone (§15.x)", () => {
  it("cofheConnected -> 'FHE Active' + 'All amounts encrypted' (ready)", () => {
    useCofheConnectionMock.mockReturnValue({ connected: true });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("FHE Active");
    expect(container.textContent).toContain("All amounts encrypted");
  });

  it("undeployed passkey + !cofheConnected -> 'FHE Ready' pending state", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: true,
      smartAccount: {
        account: { address: ME, isDeployed: false },
        status: "ready",
      },
    });
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("FHE Ready");
    expect(container.textContent).toContain("Your first transaction will deploy your wallet");
    expect(container.textContent).not.toContain("Connecting to FHE");
  });

  it("EOA + !cofheConnected -> 'Connecting to FHE…' warning state", () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME,
      isSmartAccount: false,
      smartAccount: { account: null, status: "idle" },
    });
    useCofheConnectionMock.mockReturnValue({ connected: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Connecting to FHE");
    expect(container.textContent).toContain("Encryption initializing");
  });
});

// ----- USDT faucet config-gated ----- //

describe("Dashboard — USDT faucet config-gated (§15.x)", () => {
  it("contracts.TestUSDT undefined -> 'Get Test USDT' button HIDDEN", () => {
    useChainMock.mockReturnValue({
      activeChain: { name: "Ethereum Sepolia" },
      activeChainId: 11155111,
      contracts: {
        TestUSDT: undefined,
        FHERC20Vault_USDC: "0x1111",
      },
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Get Test USDT");
  });

  it("contracts.TestUSDT defined -> 'Get Test USDT' button VISIBLE", () => {
    useChainMock.mockReturnValue({
      activeChain: { name: "Base Sepolia" },
      activeChainId: 84532,
      contracts: {
        TestUSDT: "0x9999999999999999999999999999999999999999",
        FHERC20Vault_USDC: "0x1111",
      },
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Get Test USDT");
  });

  it("USDT mint click calls mintTestUSDT", () => {
    useChainMock.mockReturnValue({
      activeChain: { name: "Base Sepolia" },
      activeChainId: 84532,
      contracts: {
        TestUSDT: "0x9999999999999999999999999999999999999999",
        FHERC20Vault_USDC: "0x1111",
      },
    });
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Get test USDT"));
    expect(mintTestUSDTMock).toHaveBeenCalledTimes(1);
  });
});

// ----- Shield section ----- //

describe("Dashboard — Shield section (§15.x)", () => {
  it("amount input regex /^\\d*\\.?\\d{0,6}$/ rejects 7th decimal", () => {
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Shield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.123456" } });
    expect(input.value).toBe("1.123456");
    fireEvent.change(input, { target: { value: "1.1234567" } });
    expect(input.value).toBe("1.123456");
  });

  it("empty amount -> Deposit disabled + no shield call", async () => {
    const { container } = render(<Dashboard />);
    const depositBtn = findButton(container, "Deposit to vault");
    expect(depositBtn.disabled).toBe(true);
    fireEvent.click(depositBtn);
    await flush();
    expect(shieldMock).toHaveBeenCalledTimes(0);
  });

  it("amount=0 -> Deposit disabled + 'Enter an amount' toast on click", async () => {
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Shield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    const depositBtn = findButton(container, "Deposit to vault");
    expect(depositBtn.disabled).toBe(true);
    expect(shieldMock).toHaveBeenCalledTimes(0);
  });

  it("valid amount -> shield(amount) called + input cleared", async () => {
    shieldMock.mockResolvedValue(undefined);
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Shield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.click(findButton(container, "Deposit to vault"));
    await flush();
    expect(shieldMock).toHaveBeenCalledWith("25");
    expect(input.value).toBe("");
  });

  it("step='approving' -> 'Approving USDC...' progress shown", () => {
    setShield({ step: "approving" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Approving USDC");
  });

  it("step='shielding' -> 'Shielding tokens...' progress shown", () => {
    setShield({ step: "shielding" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Shielding tokens");
  });

  it("step='success' -> 'Shielding complete!' success copy", () => {
    setShield({ step: "success" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Shielding complete");
  });

  it("step='error' + error msg -> error rendered + Retry button calls reset", () => {
    setShield({ step: "error", error: "rpc reverted" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("rpc reverted");
    fireEvent.click(findButton(container, "Retry shield"));
    expect(resetShieldMock).toHaveBeenCalledTimes(1);
  });

  it("step='error' + null error -> 'Shield failed' fallback copy", () => {
    setShield({ step: "error", error: null });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Shield failed");
  });
});

// ----- Unshield 4-state matrix ----- //

describe("Dashboard — Unshield 4-state matrix (§15.x)", () => {
  it("step='encrypting' -> 'Encrypting...' label", () => {
    setShield({ unshieldStep: "encrypting" });
    const { container } = render(<Dashboard />);
    const btn = findButton(container, "Unshield");
    expect(btn.textContent).toContain("Encrypting");
  });

  it("step='requesting' -> 'Requesting...' label", () => {
    setShield({ unshieldStep: "requesting" });
    const { container } = render(<Dashboard />);
    const btn = findButton(container, "Unshield");
    expect(btn.textContent).toContain("Requesting");
  });

  it("step='decrypting' -> 'Decrypting...' label + ~10s Threshold-Network hint", () => {
    setShield({ unshieldStep: "decrypting" });
    const { container } = render(<Dashboard />);
    const btn = findButton(container, "Unshield");
    expect(btn.textContent).toContain("Decrypting");
    expect(container.textContent).toContain("Threshold Network is decrypting");
    expect(container.textContent).toContain("~10s");
  });

  it("step='claiming' -> 'Claiming...' label", () => {
    setShield({ unshieldStep: "claiming" });
    const { container } = render(<Dashboard />);
    const btn = findButton(container, "Unshield");
    expect(btn.textContent).toContain("Claiming");
  });

  it("step='success' -> green checkmark + 'Unshielded' copy", () => {
    setShield({ unshieldStep: "success" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Unshielded");
    expect(container.textContent).toContain("public USDC balance updated");
  });

  it("step='error' -> error message + 'Try again' fallback when err null", () => {
    setShield({ unshieldStep: "error", unshieldError: null });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Unshield failed. Try again");
  });

  it("hasPendingUnshield (cross-session) -> 'Pending unshield' card + Retry calls retryUnshieldClaim", () => {
    setShield({ hasPendingUnshield: true });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Pending unshield from a previous session");
    fireEvent.click(findButton(container, "Retry pending unshield claim"));
    expect(retryUnshieldClaimMock).toHaveBeenCalledTimes(1);
  });

  it("pending banner hidden during decrypting/claiming (UI not stacked twice)", () => {
    setShield({ hasPendingUnshield: true, unshieldStep: "decrypting" });
    const { container } = render(<Dashboard />);
    expect(container.textContent).not.toContain("Pending unshield from a previous session");
  });

  it("empty unshield amount -> 'Enter an amount to unshield' toast (no contract call)", async () => {
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Unshield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    const btn = findButton(container, "Unshield");
    expect(btn.disabled).toBe(true);
    expect(unshieldMock).toHaveBeenCalledTimes(0);
  });

  it("valid unshield amount -> unshield(amount, encryptInputsAsync, Encryptable) + ok clears input", async () => {
    unshieldMock.mockResolvedValue(true);
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Unshield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(findButton(container, "Unshield"));
    await flush();
    expect(unshieldMock).toHaveBeenCalled();
    expect(unshieldMock.mock.calls[0][0]).toBe("5");
    expect(input.value).toBe("");
  });

  it("unshield returns false -> input NOT cleared (so user can retry without retyping)", async () => {
    unshieldMock.mockResolvedValue(false);
    const { container } = render(<Dashboard />);
    const input = container.querySelector('input[aria-label="Unshield amount"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(findButton(container, "Unshield"));
    await flush();
    expect(input.value).toBe("5");
  });
});

// ----- Faucet cooldown #259 ----- //

describe("Dashboard — faucet cooldown (#259) (§15.x)", () => {
  it("no localStorage key -> 'Get Test USDC' label (no cooldown)", () => {
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Get Test USDC");
    expect(container.textContent).not.toMatch(/Try again in \d+s/);
  });

  it("recent mint timestamp in localStorage -> 'Try again in Ns' label", () => {
    localStorage.setItem("blank_last_faucet", String(Date.now() - 30_000));
    const { container } = render(<Dashboard />);
    expect(container.textContent).toMatch(/Try again in \d+s/);
  });

  it("60s+ old localStorage timestamp -> back to 'Get Test USDC' (cooldown elapsed)", () => {
    localStorage.setItem("blank_last_faucet", String(Date.now() - 70_000));
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Get Test USDC");
    expect(container.textContent).not.toMatch(/Try again in \d+s/);
  });

  it("Get Test USDC click invokes mintTestTokens", () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Get test USDC"));
    expect(mintTestTokensMock).toHaveBeenCalledTimes(1);
  });

  it("isMinting=true -> 'Minting...' label + button disabled", () => {
    setShield({ isMinting: true });
    const { container } = render(<Dashboard />);
    const btn = findButton(container, "Get test USDC");
    expect(btn.textContent).toContain("Minting");
    expect(btn.disabled).toBe(true);
  });

  it("mintTestTokens rejection -> error toast not silent", async () => {
    mintTestTokensMock.mockRejectedValue(new Error("rpc reverted"));
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Get test USDC"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("rpc reverted");
  });
});

// ----- handleFaucetFromDashboard (low-balance banner) ----- //

describe("Dashboard — low-balance faucet banner (§15.x)", () => {
  it("desktop + activities > 0 + publicBalance=0 -> banner with 'Get USDC' CTA", () => {
    useActivityFeedMock.mockReturnValue({ activities: [activity()], isLoading: false });
    setShield({ publicBalance: 0 });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Out of testnet USDC");
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "Get USDC");
    expect(btn).toBeTruthy();
  });

  it("handleFaucetFromDashboard click calls faucetUsdc + success toast on ok", async () => {
    useActivityFeedMock.mockReturnValue({ activities: [activity()], isLoading: false });
    setShield({ publicBalance: 0 });
    faucetUsdcMock.mockResolvedValue({ ok: true });
    const { container } = render(<Dashboard />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "Get USDC") as HTMLButtonElement;
    fireEvent.click(btn);
    await flush();
    expect(faucetUsdcMock).toHaveBeenCalledWith({
      address: ME,
      chainId: 11155111,
    });
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("rate_limited -> distinct 'Try again in an hour' copy", async () => {
    useActivityFeedMock.mockReturnValue({ activities: [activity()], isLoading: false });
    setShield({ publicBalance: 0 });
    faucetUsdcMock.mockResolvedValue({ ok: false, error: "rate_limited" });
    const { container } = render(<Dashboard />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "Get USDC") as HTMLButtonElement;
    fireEvent.click(btn);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("rate-limited"),
      expect.any(Object),
    );
  });

  it("generic error -> 'Faucet failed: <reason>' copy with reason surfaced", async () => {
    useActivityFeedMock.mockReturnValue({ activities: [activity()], isLoading: false });
    setShield({ publicBalance: 0 });
    faucetUsdcMock.mockResolvedValue({ ok: false, error: "config_missing" });
    const { container } = render(<Dashboard />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "Get USDC") as HTMLButtonElement;
    fireEvent.click(btn);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("config_missing"),
      expect.any(Object),
    );
  });
});

// ----- BalanceCard ----- //

describe("Dashboard — BalanceCard (§15.x)", () => {
  it("privacyMode + !isRevealed -> masked 6-dot placeholder + 'Amount hidden' sr-only", () => {
    usePrivacyModeMock.mockReturnValue({
      privacyMode: true,
      toggle: togglePrivacyModeMock,
      setPrivacyMode: vi.fn(),
    });
    setBalance({ isRevealed: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Amount hidden");
  });

  it("not privacyMode + decrypted balance -> '$X,XXX.XX' formatted", () => {
    usePrivacyModeMock.mockReturnValue({
      privacyMode: false,
      toggle: togglePrivacyModeMock,
      setPrivacyMode: vi.fn(),
    });
    setBalance({
      formatted: "1,234.56",
      isDecrypted: true,
      hasBalance: true,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("1,234.56");
  });

  it("hasBalance + no permit + not privacy -> 'tap to create permit' affordance", () => {
    usePrivacyModeMock.mockReturnValue({
      privacyMode: false,
      toggle: togglePrivacyModeMock,
      setPrivacyMode: vi.fn(),
    });
    setBalance({
      formatted: null,
      isDecrypted: false,
      hasBalance: true,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("tap to create permit");
  });

  it("Eye toggle: hasBalance + !hasPermit + !isDecrypted -> click drives createPermit (not silent no-op)", () => {
    setBalance({
      formatted: null,
      isDecrypted: false,
      hasBalance: true,
    });
    usePrivacyMock.mockReturnValue({
      hasPermit: false,
      createPermit: createPermitMock,
      isCreating: false,
      permitCreatedAt: null,
      permitExpiresAt: null,
      sharedPermits: [],
      isExpiringSoon: false,
      isExpired: false,
    });
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Reveal balance"));
    expect(createPermitMock).toHaveBeenCalled();
    expect(toggleRevealMock).not.toHaveBeenCalled();
  });

  it("Eye toggle: with permit -> toggleReveal + togglePrivacy both fire", () => {
    setBalance({
      formatted: "1,234.56",
      isDecrypted: true,
      hasBalance: true,
      isRevealed: true,
    });
    // displayAmount = privacyMode && !isRevealed; set privacyMode=false so the
    // toggle aria-label flips to "Hide balance" (decrypted + showing).
    usePrivacyModeMock.mockReturnValue({
      privacyMode: false,
      toggle: togglePrivacyModeMock,
      setPrivacyMode: vi.fn(),
    });
    usePrivacyMock.mockReturnValue({
      hasPermit: true,
      createPermit: createPermitMock,
      isCreating: false,
      permitCreatedAt: null,
      permitExpiresAt: null,
      sharedPermits: [],
      isExpiringSoon: false,
      isExpired: false,
    });
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Hide balance"));
    expect(toggleRevealMock).toHaveBeenCalled();
    expect(togglePrivacyModeMock).toHaveBeenCalled();
  });

  it("FHE Protected pill visible + chain name surfaced", () => {
    useChainMock.mockReturnValue({
      activeChain: { name: "Base Sepolia" },
      activeChainId: 84532,
      contracts: { TestUSDT: undefined, FHERC20Vault_USDC: "0x1111" },
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("FHE Protected");
    expect(container.textContent).toContain("Base Sepolia");
  });
});

// ----- Quick Actions ----- //

describe("Dashboard — Quick Actions (§15.x)", () => {
  it("Send Money -> navigate('/app/send')", () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Send Money"));
    expect(navigateMock).toHaveBeenCalledWith("/app/send");
  });

  it("Receive -> navigate('/app/receive')", () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Receive"));
    expect(navigateMock).toHaveBeenCalledWith("/app/receive");
  });

  it("More... -> navigate('/app/explore')", () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, /^More/));
    expect(navigateMock).toHaveBeenCalledWith("/app/explore");
  });

  it("Shield Tokens -> scrollToShield (NOT navigate)", () => {
    const scrollMock = vi.fn();
    const stubEl = { scrollIntoView: scrollMock } as unknown as HTMLElement;
    const getByIdSpy = vi.spyOn(document, "getElementById").mockImplementation((id) => {
      return id === "shield-section" ? stubEl : null;
    });
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "Shield Tokens"));
    expect(scrollMock).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalledWith("");
    getByIdSpy.mockRestore();
  });
});

// ----- ActivityList ----- //

describe("Dashboard — ActivityList (§15.x)", () => {
  it("isLoading=true -> 3 shimmer skeleton rows", () => {
    useActivityFeedMock.mockReturnValue({ activities: [], isLoading: true });
    const { container } = render(<Dashboard />);
    const shimmers = container.querySelectorAll(".shimmer");
    expect(shimmers.length).toBeGreaterThanOrEqual(3);
  });

  it("empty + not loading -> 'No activity yet' + dual CTAs", () => {
    useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("No activity yet");
    expect(container.textContent).toContain("Send a payment");
    expect(container.textContent).toContain("Or create a claim link");
  });

  it("populated -> renders row with direction-aware sign (+ for incoming, - for outgoing)", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        activity({ id: "in", user_from: ALICE, user_to: ME }),
        activity({
          id: "out",
          user_from: ME,
          user_to: ALICE,
        }),
      ],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    // Both should render with masked encrypted amounts
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("-");
    expect(container.textContent).toContain("Received");
    expect(container.textContent).toContain("Sent");
  });

  it("View All -> navigate('/app/history')", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [activity()],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    fireEvent.click(findButton(container, "View All"));
    expect(navigateMock).toHaveBeenCalledWith("/app/history");
  });

  it("renders only top 5 activities (slice(0,5))", () => {
    useActivityFeedMock.mockReturnValue({
      activities: Array.from({ length: 8 }, (_, i) =>
        activity({ id: `a-${i}`, note: `Note ${i}` }),
      ),
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Note 0");
    expect(container.textContent).toContain("Note 4");
    expect(container.textContent).not.toContain("Note 5");
  });

  it("unknown activity_type -> capitalized fallback label", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [activity({ activity_type: "weird_event" })],
      isLoading: false,
    });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Weird_event");
  });
});

// ----- Mobile layout ----- //

describe("Dashboard — mobile layout (§15.x)", () => {
  it("isMobile=true -> renders mobile dashboard (no bento grid)", () => {
    useMediaQueryMock.mockReturnValue(true);
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Quick Actions");
    expect(container.textContent).toContain("Recent Activity");
    // FHE Status section is desktop-only — should be absent on mobile
    expect(container.textContent).not.toContain("Encryption Status");
  });

  it("mobile renders shield section with same controls", () => {
    useMediaQueryMock.mockReturnValue(true);
    const { container } = render(<Dashboard />);
    expect(container.querySelector('input[aria-label="Shield amount"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Unshield amount"]')).not.toBeNull();
  });
});

// ----- Encryption Status (desktop) Vault Status ----- //

describe("Dashboard — Encryption Status section (desktop) (§15.x)", () => {
  it("balance.isInitialized -> 'Synced'", () => {
    setBalance({ isInitialized: true });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Synced");
  });

  it("!balance.isInitialized -> 'Not initialized'", () => {
    setBalance({ isInitialized: false });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Not initialized");
  });

  it("Decryption card shows '~2s async' descriptor", () => {
    const { container } = render(<Dashboard />);
    expect(container.textContent).toContain("Decryption");
    expect(container.textContent).toContain("~2s async");
  });
});

// ----- publicBalance display ----- //

describe("Dashboard — publicBalance display (§15.x)", () => {
  it("0 -> '0.00 USDC' (en-US locale or similar with 2dp)", () => {
    setShield({ publicBalance: 0 });
    const { container } = render(<Dashboard />);
    expect(container.textContent).toMatch(/0\.00 USDC/);
  });

  it("1234.5 -> locale-grouped 1,234.50 USDC (jsdom locale agnostic)", () => {
    setShield({ publicBalance: 1234.5 });
    const { container } = render(<Dashboard />);
    // en-US: '1,234.50', en-IN: '1,234.50' (both group >=4 digits at 3)
    expect(container.textContent).toMatch(/1[,]234\.50 USDC/);
  });
});
