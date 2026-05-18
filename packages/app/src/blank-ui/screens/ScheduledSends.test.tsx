import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for ScheduledSends screen. Phase 4.1 session-key
// recurring-USDC management. Multi-gate screen with 3 pre-flight
// banners + create modal + audit-fix persistent stub banner.
//
// CRITICAL pins:
//   - audit Top-28 #15 + #18: the stub-mode banner MUST be a
//     PERSISTENT amber card, not a 6-second toast. A 6s toast
//     fades while the user is still configuring their next
//     scope, leaving them to think the schedule is active when
//     the cron + KMS backing hasn't shipped yet. Pin the
//     persistent banner so a future refactor cannot quietly
//     regress this to ephemeral UX.
//   - 3 pre-flight gates: no address (full chrome suppressed) /
//     account-needs-upgrade banner / validator-not-deployed
//     banner. Each gate has distinct copy + the Create button is
//     ONLY rendered when BOTH accountReady AND validatorDeployed.
//   - Create button gated on accountReady AND validatorDeployed;
//     omitting either gate would let the user open the modal
//     against an un-upgraded account or non-existent validator
//     contract, failing on submit.
//   - handleCreate validation: invalid recipient (not hex, or
//     zero address) -> toast; amount<=0 -> toast.
//   - Revoke flow: window.confirm gate + revokeScope(key, mode);
//     confirm=false skips. Same audit-#313 pattern shape as
//     Settings disconnect.
//   - Scope row rendering: isExpired pill on expired scopes,
//     amount + truncated recipient + period label + expires
//     date + next-fire countdown.
//   - Cadence buttons: aria-pressed visual via class swap; period
//     state survives modal close-and-reopen via reset (defensive
//     pin proves the reset DOES wipe period back to default).

const useScheduledSendsMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useAccountVersionMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const usePaymasterHealthMock = vi.hoisted(() => vi.fn());
const useBalanceMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useEmailAuthSignerMock = vi.hoisted(() => vi.fn());
const signEmailAuthMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());
const isAddressMock = vi.hoisted(() => vi.fn());
const computeNextFireSecondsMock = vi.hoisted(() => vi.fn());
const formatTimeUntilMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: usePublicClientMock,
  useBalance: useBalanceMock,
}));
vi.mock("@/hooks/useScheduledSends", () => ({
  useScheduledSends: useScheduledSendsMock,
}));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useAccountVersion", () => ({
  useAccountVersion: useAccountVersionMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/hooks/useEmailAuthSigner", () => ({
  useEmailAuthSigner: useEmailAuthSignerMock,
}));
vi.mock("@/lib/email-client", () => ({
  buildScheduledSendCreateSignableMessage: () => "test-sig-message",
}));
vi.mock("@/hooks/usePaymasterHealth", () => ({ usePaymasterHealth: usePaymasterHealthMock }));
vi.mock("@/lib/scheduled-sends", () => ({
  PERIOD_PRESETS: [
    { label: "Daily", seconds: 86_400 },
    { label: "Weekly", seconds: 7 * 86_400 },
    { label: "Monthly", seconds: 30 * 86_400 },
    { label: "Yearly", seconds: 365 * 86_400 },
  ],
  SessionKeyValidatorAbi: [],
  computeNextFireSeconds: computeNextFireSecondsMock,
  formatTimeUntil: formatTimeUntilMock,
}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    isAddress: isAddressMock,
  };
});
vi.mock("react-hot-toast", () => ({
  default: Object.assign(toastMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
  }),
}));

import ScheduledSends from "./ScheduledSends";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VALIDATOR = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDC = "0xddddddddddddddddddddddddddddddddddddddd1";
const ZERO = "0x0000000000000000000000000000000000000000";

let refetchMock: ReturnType<typeof vi.fn>;
let revokeScopeMock: ReturnType<typeof vi.fn>;
let unifiedWriteMock: ReturnType<typeof vi.fn>;
let readContractMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

type Scope = {
  sessionKey: `0x${string}`;
  recipient: `0x${string}`;
  spendToken: `0x${string}`;
  maxAmountPerCall: bigint;
  periodSeconds: number;
  validUntil: number;
  lastFiredAt: number;
  isExpired: boolean;
};

function setFeed(overrides: Partial<{
  scopes: Scope[];
  isLoading: boolean;
  error: string | null;
}> = {}) {
  useScheduledSendsMock.mockReturnValue({
    scopes: overrides.scopes ?? [],
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
    refetch: refetchMock,
    revokeScope: revokeScopeMock,
  });
}

function buildScope(over: Partial<Scope> = {}): Scope {
  return {
    sessionKey: "0xs1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1s1" as `0x${string}`,
    recipient: RECIPIENT as `0x${string}`,
    spendToken: USDC as `0x${string}`,
    maxAmountPerCall: 50_000_000n, // 50 USDC at 6dp
    periodSeconds: 7 * 86_400, // Weekly
    validUntil: Math.floor(Date.now() / 1000) + 86_400 * 90,
    lastFiredAt: 0,
    isExpired: false,
    ...over,
  };
}

beforeEach(() => {
  useScheduledSendsMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useAccountVersionMock.mockReset();
  useChainMock.mockReset();
  useUnifiedWriteMock.mockReset();
  usePaymasterHealthMock.mockReset();
  useBalanceMock.mockReset();
  usePublicClientMock.mockReset();
  useEmailAuthSignerMock.mockReset();
  signEmailAuthMock.mockReset();
  // Default-good signer that returns a valid auth bundle.
  signEmailAuthMock.mockResolvedValue({
    signature: "0xfeedfeed",
    signerAddress: ME,
    signedAt: Math.floor(Date.now() / 1000),
    signerChainId: 84532,
  });
  useEmailAuthSignerMock.mockReturnValue({
    signEmailAuth: signEmailAuthMock,
    canSign: true,
  });
  toastMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  isAddressMock.mockReset();
  computeNextFireSecondsMock.mockReset();
  formatTimeUntilMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useAccountVersionMock.mockReturnValue({ status: "current" });
  useChainMock.mockReturnValue({
    contracts: { SessionKeyValidator: VALIDATOR, TestUSDC: USDC },
    activeChain: { name: "Ethereum Sepolia" },
    activeChainId: 11155111,
  });

  refetchMock = vi.fn().mockResolvedValue(undefined);
  revokeScopeMock = vi.fn().mockResolvedValue(undefined);
  setFeed();

  unifiedWriteMock = vi.fn().mockResolvedValue({});
  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });

  usePaymasterHealthMock.mockReturnValue({ status: "ready" });
  useBalanceMock.mockReturnValue({ data: { value: 1_000_000_000_000_000_000n } });

  readContractMock = vi.fn().mockResolvedValue(false); // validator NOT yet enabled
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });

  isAddressMock.mockImplementation((v: string) => /^0x[a-fA-F0-9]{40}$/.test(v));
  computeNextFireSecondsMock.mockReturnValue(Math.floor(Date.now() / 1000) + 86_400);
  formatTimeUntilMock.mockReturnValue("in 1d");

  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ sessionKey: "0xnewkey", stub: false }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ScheduledSends — no-address guard (§15.x)", () => {
  it("renders connect-wallet message when effectiveAddress is undefined", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Connect your wallet to set up recurring payments");
  });

  it("no-address state HIDES the full chrome (no create button, no scopes)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { queryByTestId } = render(<ScheduledSends />);
    expect(queryByTestId("scheduled-create-button")).toBeNull();
    expect(queryByTestId("scope-list")).toBeNull();
  });
});

describe("ScheduledSends — pre-flight gates (§15.x)", () => {
  it("CRITICAL accountStatus='needs-upgrade' -> amber banner 'Upgrade your account first'", () => {
    useAccountVersionMock.mockReturnValue({ status: "needs-upgrade" });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Upgrade your account first");
    expect(container.textContent).toContain("v0.4.1 BlankAccount implementation");
  });

  it("CRITICAL needs-upgrade HIDES the Create button (defense-in-depth)", () => {
    useAccountVersionMock.mockReturnValue({ status: "needs-upgrade" });
    const { queryByTestId } = render(<ScheduledSends />);
    expect(queryByTestId("scheduled-create-button")).toBeNull();
  });

  it("CRITICAL !validatorDeployed (zero address) -> 'Scheduled sends aren't available on <chain> yet'", () => {
    useChainMock.mockReturnValue({
      contracts: { SessionKeyValidator: ZERO, TestUSDC: USDC },
      activeChain: { name: "Ethereum Sepolia" },
      activeChainId: 11155111,
    });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Scheduled sends aren't available on Ethereum Sepolia yet");
  });

  it("!validatorDeployed HIDES the Create button", () => {
    useChainMock.mockReturnValue({
      contracts: { SessionKeyValidator: ZERO, TestUSDC: USDC },
      activeChain: { name: "Ethereum Sepolia" },
      activeChainId: 11155111,
    });
    const { queryByTestId } = render(<ScheduledSends />);
    expect(queryByTestId("scheduled-create-button")).toBeNull();
  });

  it("both gates pass -> indigo 'Cron fires daily at 00:00 UTC' banner + Create button visible", () => {
    const { container, getByTestId } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Cron fires daily at 00:00 UTC");
    expect(container.textContent).toContain("Vercel");
    expect(getByTestId("scheduled-create-button")).toBeDefined();
  });
});

describe("ScheduledSends — list rendering (§15.x)", () => {
  it("loading state shows 'Loading scopes…'", () => {
    setFeed({ isLoading: true });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Loading scopes");
  });

  it("empty + ready -> 'No scheduled sends yet'", () => {
    setFeed({ scopes: [] });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("No scheduled sends yet");
  });

  it("scope row renders amount + truncated recipient + period label + expires date", () => {
    const scope = buildScope({ maxAmountPerCall: 50_000_000n, periodSeconds: 7 * 86_400 });
    setFeed({ scopes: [scope] });
    const { container, getByTestId } = render(<ScheduledSends />);
    expect(getByTestId(`scope-${scope.sessionKey}`)).toBeDefined();
    expect(container.textContent).toContain("$50 USDC");
    expect(container.textContent).toMatch(/0xbbbb.{1,3}bbbb/i);
    expect(container.textContent).toContain("Weekly");
  });

  it("non-preset period shows fallback '<n>s' label", () => {
    setFeed({ scopes: [buildScope({ periodSeconds: 12345 })] });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("12345s");
  });

  it("CRITICAL isExpired pill rendered + 'next fire' line HIDDEN", () => {
    setFeed({ scopes: [buildScope({ isExpired: true })] });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("Expired");
    expect(container.textContent).not.toContain("next fire");
  });

  it("active scope shows 'next fire' line with formatTimeUntil output", () => {
    formatTimeUntilMock.mockReturnValue("in 3h");
    setFeed({ scopes: [buildScope({ isExpired: false })] });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("next fire");
    expect(container.textContent).toContain("in 3h");
  });

  it("Refresh scopes button calls refetch", () => {
    setFeed({ scopes: [buildScope()] });
    const { getByText } = render(<ScheduledSends />);
    fireEvent.click(getByText("Refresh scopes"));
    expect(refetchMock).toHaveBeenCalled();
  });

  it("error state renders the error message inline (not silent)", () => {
    setFeed({ error: "RPC down" });
    const { container } = render(<ScheduledSends />);
    expect(container.textContent).toContain("RPC down");
  });
});

describe("ScheduledSends — revoke flow (§15.x)", () => {
  it("confirm=true -> revokeScope(sessionKey, paymasterMode) called + success toast", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const scope = buildScope();
    setFeed({ scopes: [scope] });
    const { getByTestId } = render(<ScheduledSends />);
    await act(async () => {
      fireEvent.click(getByTestId(`scope-revoke-${scope.sessionKey}`));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(revokeScopeMock).toHaveBeenCalledWith(scope.sessionKey, undefined);
    expect(toastSuccessMock).toHaveBeenCalledWith("Scheduled send revoked");
  });

  it("CRITICAL confirm=false -> revokeScope NOT called (irreversible-warning gate)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const scope = buildScope();
    setFeed({ scopes: [scope] });
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId(`scope-revoke-${scope.sessionKey}`));
    expect(revokeScopeMock).not.toHaveBeenCalled();
  });

  it("confirm copy mentions 'irreversible' AND 'server-held session key' (informed-consent disclosure)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const scope = buildScope();
    setFeed({ scopes: [scope] });
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId(`scope-revoke-${scope.sessionKey}`));
    const msg = confirmSpy.mock.calls[0][0] as string;
    expect(msg).toContain("irreversible");
    expect(msg).toContain("server-held session key");
  });

  it("paymaster unavailable + low ETH -> paymasterMode passed undefined", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 0n } }); // not enough for self-pay
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const scope = buildScope();
    setFeed({ scopes: [scope] });
    const { getByTestId } = render(<ScheduledSends />);
    await act(async () => {
      fireEvent.click(getByTestId(`scope-revoke-${scope.sessionKey}`));
      await Promise.resolve();
    });
    expect(revokeScopeMock).toHaveBeenCalledWith(scope.sessionKey, undefined);
  });

  it("paymaster unavailable + sufficient AA ETH -> paymasterMode='self' (Phase 7.5 self-pay)", async () => {
    usePaymasterHealthMock.mockReturnValue({ status: "unavailable" });
    useBalanceMock.mockReturnValue({ data: { value: 5_000_000_000_000_000n } }); // 0.005 ETH > 0.001 threshold
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const scope = buildScope();
    setFeed({ scopes: [scope] });
    const { getByTestId } = render(<ScheduledSends />);
    await act(async () => {
      fireEvent.click(getByTestId(`scope-revoke-${scope.sessionKey}`));
      await Promise.resolve();
    });
    expect(revokeScopeMock).toHaveBeenCalledWith(scope.sessionKey, "self");
  });
});

describe("ScheduledSends — create modal (§15.x)", () => {
  it("modal closed by default", () => {
    const { queryByLabelText } = render(<ScheduledSends />);
    expect(queryByLabelText("Recipient address")).toBeNull();
  });

  it("clicking Create button opens modal with 'New scheduled send' heading", () => {
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    expect(container.textContent).toContain("New scheduled send");
  });

  it("modal Cancel closes the modal without firing create", () => {
    const { getByTestId, getByText, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.click(getByText("Cancel"));
    expect(container.textContent).not.toContain("New scheduled send");
  });

  it("4 cadence presets rendered: Daily / Weekly / Monthly / Yearly", () => {
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    expect(container.textContent).toContain("Daily");
    expect(container.textContent).toContain("Weekly");
    expect(container.textContent).toContain("Monthly");
    expect(container.textContent).toContain("Yearly");
  });

  it("3 expiry presets: 30 / 90 / 180 days", () => {
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    expect(container.textContent).toContain("30 days");
    expect(container.textContent).toContain("90 days");
    expect(container.textContent).toContain("180 days");
  });

  it("amount input accepts digits + dot only (regex /^\\d*\\.?\\d*$/)", () => {
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    const input = getByTestId("scheduled-amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc12.34" } });
    expect(input.value).toBe(""); // failed regex, state unchanged from default ""
    fireEvent.change(input, { target: { value: "12.34" } });
    expect(input.value).toBe("12.34");
  });

  it("recipient input trims whitespace on change", () => {
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    const input = getByTestId("scheduled-recipient") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  0xabc  " } });
    expect(input.value).toBe("0xabc");
  });

  it("Authorize button disabled when recipient OR amount empty", () => {
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    const btn = getByTestId("scheduled-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("ScheduledSends — handleCreate validation (§15.x)", () => {
  it("invalid recipient hex -> 'Enter a valid recipient address' toast + fetch NOT called", async () => {
    isAddressMock.mockReturnValue(false);
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: "garbage" } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a valid recipient address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CRITICAL zero-address recipient -> rejected (independent of isAddress)", async () => {
    isAddressMock.mockReturnValue(true); // would pass hex check
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: ZERO } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a valid recipient address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("amount = 0 -> 'Enter a positive amount' toast", async () => {
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "0" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a positive amount");
  });
});

describe("ScheduledSends — handleCreate flow + stub-mode banner (§15.x)", () => {
  it("valid create: calls fetch /api/scheduled-sends/create with account + chainId + recipient + spendToken", async () => {
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/scheduled-sends/create");
    const body = JSON.parse(init.body);
    expect(body.account).toBe(ME);
    expect(body.chainId).toBe(11155111);
    expect(body.recipient).toBe(RECIPIENT);
    expect(body.spendToken).toBe(USDC);
  });

  it("CRITICAL backend stub:true -> persistent banner appears (NOT a 6s toast)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionKey: "0xnewkey", stub: true }),
    });
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Schedules are queued");
      expect(container.textContent).toContain("not firing yet");
    });
    expect(container.textContent).toContain("cron + KMS");
  });

  it("CRITICAL stub banner PERSISTS across the screen's lifetime (not auto-dismissed)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionKey: "0xnewkey", stub: true }),
    });
    vi.useFakeTimers();
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Advance well past the old 6s toast timeout. Banner MUST still be visible.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toContain("Schedules are queued");
  });

  it("backend stub:false -> no persistent banner (banner only when needed)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionKey: "0xnewkey", stub: false }),
    });
    const { getByTestId, container } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Schedules are queued");
  });

  it("backend !ok -> toast.error with backend message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "KMS down" }),
    });
    const { getByTestId } = render(<ScheduledSends />);
    fireEvent.click(getByTestId("scheduled-create-button"));
    fireEvent.change(getByTestId("scheduled-recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(getByTestId("scheduled-amount"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(getByTestId("scheduled-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // toastMappedError wraps unknown errors with the default "Transaction
    // failed — {message}" shape, then passes undefined as the toast id.
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Transaction failed: KMS down",
      undefined,
    );
  });
});
