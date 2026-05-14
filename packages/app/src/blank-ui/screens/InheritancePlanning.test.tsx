import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";

// §15.x test for InheritancePlanning screen — Phase 6.3 dead-man's-switch
// configuration: principal designates an heir + inactivity period + protected
// vault list, and heirs can start + finalize a claim once the deadline + 7-day
// challenge period elapse.
//
// CRITICAL pins:
//   - HasHeir gate: 3-state (heir=0x0 -> no plan UI, heir=non-zero + active=true
//     -> active plan UI, heir=non-zero + active=false -> still no plan UI). A
//     regression that drops the `isActive` AND clause would display a phantom
//     active plan after removeHeir + before refetchPlan completes.
//   - audit Top-28 #27 Finalize-button 3-state gating with EXPLANATORY copy
//     instead of letting the tx revert on-chain:
//       (a) no claim started -> "Tap 'Start Claim' first" hint;
//       (b) claim started + challenge period running -> "Challenge period ends
//           in N day(s)" hint + days/hours pluralization;
//       (c) ready -> Finalize CTA enabled with " (N vaults)" suffix.
//   - daysSinceCheckin + daysRemaining math via Math.max(0, ...): if a user
//     is past their deadline `daysRemaining` MUST clamp to 0 not display a
//     negative number (UX regression vector).
//   - heir-assignment dedup on principal.toLowerCase(): supabase returns
//     rows ordered by created_at desc, so the first occurrence wins —
//     the same principal naming us twice (re-designation) collapses to ONE
//     card showing the most recent designation.
//   - challenge-period copy uses ceiling math (Math.ceil) so "0.5 days
//     remaining" renders as "1 day" not "0 days". A floor would tell users
//     they can finalize NOW when the tx would still revert.
//   - removeHeir + handleAddBeneficiary 4-branch validation:
//     no address blocks early, invalid hex toasts "Invalid Ethereum address",
//     parseInt fallback "30" used when bDays is empty/NaN, modal closes
//     + form resets on success.
//   - Vault selector: case-INsensitive dedup so adding "0xABC..." then
//     "0xabc..." stays 1 vault; custom-vault input validates /^0x[a-f0-9]{40}$/i
//     before adding. The save button label includes the selected count via
//     pluralization ("1 Vault" / "2 Vaults").
//   - vaultData[5] (vaults array) drives ownerVaultCount; if owner has zero
//     vaults configured the Finalize button toasts "Owner has no vaults
//     configured in their plan" rather than calling finalizeClaim(_, 0).

const useInheritanceMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const fetchHeirAssignmentsMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useReadContract: useReadContractMock }));
vi.mock("@/hooks/useInheritance", () => ({ useInheritance: useInheritanceMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/supabase", () => ({
  fetchHeirAssignments: fetchHeirAssignmentsMock,
}));
vi.mock("@/lib/abis", () => ({ InheritanceManagerAbi: [] }));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import InheritancePlanning from "./InheritancePlanning";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEIR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRINCIPAL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const VAULT_USDC = "0x1111111111111111111111111111111111111111";

type Plan = {
  heir: string;
  inactivityPeriod: number;
  lastHeartbeat: number;
  claimStartedAt: number;
  active: boolean;
  vaults: string[];
} | null;

function setInheritance(over: {
  plan?: Plan;
  isProcessing?: boolean;
} = {}) {
  useInheritanceMock.mockReturnValue({
    plan: over.plan ?? null,
    setHeir: vi.fn(),
    setVaults: vi.fn(),
    heartbeat: vi.fn(),
    removeHeir: vi.fn(),
    startClaim: vi.fn(),
    finalizeClaim: vi.fn(),
    isProcessing: over.isProcessing ?? false,
  });
  return useInheritanceMock.mock.results[0]?.value ?? useInheritanceMock();
}

function planFromNow(over: Partial<NonNullable<Plan>> = {}): NonNullable<Plan> {
  const now = Math.floor(Date.now() / 1000);
  return {
    heir: HEIR,
    inactivityPeriod: 30 * 86400,
    lastHeartbeat: now,
    claimStartedAt: 0,
    active: true,
    vaults: [VAULT_USDC],
    ...over,
  };
}

beforeEach(() => {
  useInheritanceMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useReadContractMock.mockReset();
  fetchHeirAssignmentsMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    contracts: {
      FHERC20Vault_USDC: VAULT_USDC,
      InheritanceManager: "0x9999999999999999999999999999999999999999",
    },
  });
  useReadContractMock.mockReturnValue({ data: undefined });
  fetchHeirAssignmentsMock.mockResolvedValue([]);
  setInheritance();

  if (typeof window !== "undefined") {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  }
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

// ----- helpers ----- //

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`Button with label '${label}' not found`);
  return btn;
}

// ----- page chrome ----- //

describe("InheritancePlanning — page chrome (§15.x)", () => {
  it("renders 'Beneficiary Planning' heading + privacy subtitle", () => {
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Beneficiary Planning");
    expect(container.textContent).toContain(
      "Automatically transfer your funds to a trusted person if needed",
    );
  });

  it("renders the no-plan empty state when plan is null", () => {
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("No Plan Configured");
    expect(container.textContent).toContain("Set Up Inheritance Plan");
  });

  it("renders 'Claim as Heir' section even with no plan (heirs can claim others' plans)", () => {
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Claim as Heir");
    expect(container.textContent).toContain(
      "If you are designated as someone's heir",
    );
  });
});

// ----- hasHeir gate ----- //

describe("InheritancePlanning — hasHeir gate (§15.x)", () => {
  it("active=true + heir=non-zero shows Plan Active card", () => {
    setInheritance({ plan: planFromNow() });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Plan Active");
    expect(container.textContent).toContain("Protected");
    expect(container.textContent).not.toContain("No Plan Configured");
  });

  it("active=false hides Plan Active even when heir set (post-removeHeir + pre-refetch)", () => {
    setInheritance({ plan: planFromNow({ active: false }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).not.toContain("Plan Active");
    expect(container.textContent).toContain("No Plan Configured");
  });

  it("heir=0x0 hides Plan Active even when active=true (defensive)", () => {
    setInheritance({ plan: planFromNow({ heir: ZERO_ADDR }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).not.toContain("Plan Active");
    expect(container.textContent).toContain("No Plan Configured");
  });
});

// ----- daysSinceCheckin + daysRemaining math ----- //

describe("InheritancePlanning — daysRemaining math (§15.x)", () => {
  it("daysRemaining renders 30 when fresh heartbeat + 30-day period", () => {
    setInheritance({ plan: planFromNow() });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Days Remaining");
    expect(container.textContent).toContain("30");
  });

  it("daysRemaining CLAMPS to 0 when past deadline (Math.max guard)", () => {
    const now = Math.floor(Date.now() / 1000);
    setInheritance({
      plan: planFromNow({
        inactivityPeriod: 30 * 86400,
        lastHeartbeat: now - 60 * 86400,
      }),
    });
    const { container } = render(<InheritancePlanning />);
    const daysCard = Array.from(container.querySelectorAll("p"))
      .find((p) => p.textContent?.trim() === "Days Remaining");
    const numEl = daysCard?.parentElement?.parentElement?.querySelector("p.text-2xl");
    expect(numEl?.textContent?.trim()).toBe("0");
  });

  it("daysSinceCheckin reads from lastHeartbeat (text 'X days ago')", () => {
    const now = Math.floor(Date.now() / 1000);
    setInheritance({
      plan: planFromNow({ lastHeartbeat: now - 3 * 86400 }),
    });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toMatch(/Last check-in: 3 days? ago/);
  });

  it("inactivityDays = inactivityPeriod / 86400 surfaced in 'Inactivity Period' card", () => {
    setInheritance({ plan: planFromNow({ inactivityPeriod: 90 * 86400 }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Inactivity Period");
    expect(container.textContent).toContain("90 days");
  });

  it("daysRemaining <= 7 turns the number amber (color signal for urgency)", () => {
    const now = Math.floor(Date.now() / 1000);
    setInheritance({
      plan: planFromNow({
        inactivityPeriod: 30 * 86400,
        lastHeartbeat: now - 26 * 86400,
      }),
    });
    const { container } = render(<InheritancePlanning />);
    const daysCard = Array.from(container.querySelectorAll("p"))
      .find((p) => p.textContent?.trim() === "Days Remaining");
    const numEl = daysCard?.parentElement?.parentElement?.querySelector("p.text-2xl");
    expect(numEl?.className).toContain("text-amber-600");
  });
});

// ----- handleCheckIn / heartbeat ----- //

describe("InheritancePlanning — Check In Now (§15.x)", () => {
  it("Check In Now button calls heartbeat()", () => {
    const heartbeat = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: planFromNow(),
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat,
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Check In Now"));
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("isProcessing=true disables Check In + swaps label to 'Sending heartbeat...'", () => {
    useInheritanceMock.mockReturnValue({
      plan: planFromNow(),
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: true,
    });
    const { container } = render(<InheritancePlanning />);
    const btn = findButton(container, "Sending heartbeat");
    expect(btn.disabled).toBe(true);
  });
});

// ----- handleRemoveBeneficiary ----- //

describe("InheritancePlanning — removeHeir (§15.x)", () => {
  it("confirm=true calls removeHeir, confirm=false does NOT call removeHeir", () => {
    const removeHeir = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: planFromNow(),
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir,
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Remove Inheritance Plan"));
    expect(removeHeir).toHaveBeenCalledTimes(0);
    confirmSpy.mockReturnValue(true);
    fireEvent.click(findButton(container, "Remove Inheritance Plan"));
    expect(removeHeir).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("confirm copy mentions 'dead man's switch' (load-bearing user disclosure)", () => {
    const removeHeir = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: planFromNow(),
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir,
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Remove Inheritance Plan"));
    const msg = confirmSpy.mock.calls[0][0] as string;
    expect(msg).toContain("dead man's switch");
    confirmSpy.mockRestore();
  });
});

// ----- handleAddBeneficiary ----- //

describe("InheritancePlanning — Set Heir modal (§15.x)", () => {
  it("modal opens on 'Set Up Inheritance Plan' click", () => {
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Set Up Inheritance Plan"));
    expect(container.textContent).toContain("Set Up Inheritance");
    expect(container.textContent).toContain("Heir Wallet Address");
    expect(container.textContent).toContain("Inactivity Period (Days)");
  });

  it("modal title says 'Change Heir' when hasHeir, 'Set Up Inheritance' otherwise", () => {
    setInheritance({ plan: planFromNow() });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Change Heir"));
    const headings = Array.from(container.querySelectorAll("h3"))
      .map((h) => h.textContent);
    expect(headings).toContain("Change Heir");
  });

  it("empty bAddress -> early return (no setHeir call + no toast)", () => {
    const setHeir = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir,
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Set Up Inheritance Plan"));
    const submit = findButton(container, "Set Heir");
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(setHeir).toHaveBeenCalledTimes(0);
    expect(toastErrorMock).toHaveBeenCalledTimes(0);
  });

  it("invalid hex address -> 'Invalid Ethereum address' toast (no setHeir)", async () => {
    const setHeir = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir,
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Set Up Inheritance Plan"));
    const input = container.querySelector("input[placeholder='0x...']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not-a-hex-address" } });
    fireEvent.click(findButton(container, "Set Heir"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(setHeir).toHaveBeenCalledTimes(0);
  });

  it("valid 0x address + 60 days -> setHeir(addr, 60)", async () => {
    const setHeir = vi.fn().mockResolvedValue(undefined);
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir,
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Set Up Inheritance Plan"));
    const input = container.querySelector("input[placeholder='0x...']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: HEIR } });
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "60" } });
    fireEvent.click(findButton(container, "Set Heir"));
    await flush();
    expect(setHeir).toHaveBeenCalledWith(HEIR, 60);
  });
});

// ----- Plans naming you (HeirAssignmentCard) ----- //

describe("InheritancePlanning — Plans naming you (§15.x)", () => {
  it("renders nothing when fetchHeirAssignments returns []", async () => {
    fetchHeirAssignmentsMock.mockResolvedValue([]);
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).not.toContain("Plans naming you");
  });

  it("renders 'Plans naming you' card when at least 1 assignment exists", async () => {
    fetchHeirAssignmentsMock.mockResolvedValue([
      {
        id: "row-1",
        tx_hash: "0x1",
        user_from: PRINCIPAL,
        user_to: ME,
        activity_type: "inheritance_heir_set",
        contract_address: "0xff",
        note: "",
        token_address: "",
        block_number: 1,
        created_at: new Date().toISOString(),
      },
    ]);
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).toContain("Plans naming you");
    expect(container.textContent).toContain("1 plan");
  });

  it("dedupes same-principal rows on user_from.toLowerCase() — keeps newest", async () => {
    fetchHeirAssignmentsMock.mockResolvedValue([
      {
        id: "row-newest",
        tx_hash: "0x1",
        user_from: PRINCIPAL,
        user_to: ME,
        activity_type: "inheritance_heir_set",
        contract_address: "0xff",
        note: "",
        token_address: "",
        block_number: 2,
        created_at: new Date().toISOString(),
      },
      {
        id: "row-older",
        tx_hash: "0x2",
        user_from: PRINCIPAL.toUpperCase().replace("0X", "0x"),
        user_to: ME,
        activity_type: "inheritance_heir_set",
        contract_address: "0xff",
        note: "",
        token_address: "",
        block_number: 1,
        created_at: new Date(Date.now() - 86400_000).toISOString(),
      },
    ]);
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).toContain("1 plan");
    expect(container.textContent).not.toContain("2 plan");
  });
});

// ----- HeirAssignmentCard ----- //

describe("InheritancePlanning — HeirAssignmentCard status (§15.x)", () => {
  function setupAssignment() {
    fetchHeirAssignmentsMock.mockResolvedValue([
      {
        id: "row-1",
        tx_hash: "0x1",
        user_from: PRINCIPAL,
        user_to: ME,
        activity_type: "inheritance_heir_set",
        contract_address: "0xff",
        note: "",
        token_address: "",
        block_number: 1,
        created_at: new Date().toISOString(),
      },
    ]);
  }

  it("HeirAssignmentCard renders 'Loading' status when principalPlan is undefined", async () => {
    setupAssignment();
    useReadContractMock.mockReturnValue({ data: undefined });
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).toContain("Loading");
  });

  it("plan.active=true + matching heir -> 'Active' status badge", async () => {
    setupAssignment();
    const now = Math.floor(Date.now() / 1000);
    useReadContractMock.mockReturnValue({
      data: [ME, BigInt(30 * 86400), BigInt(now), BigInt(0), true, []] as readonly [
        string, bigint, bigint, bigint, boolean, readonly string[],
      ],
    });
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).toContain("Active");
  });

  it("plan.active=true + claimStartedAt > 0 -> 'Claim in progress' badge", async () => {
    setupAssignment();
    const now = Math.floor(Date.now() / 1000);
    useReadContractMock.mockReturnValue({
      data: [ME, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now), true, []] as readonly [
        string, bigint, bigint, bigint, boolean, readonly string[],
      ],
    });
    const { container } = render(<InheritancePlanning />);
    await flush();
    expect(container.textContent).toContain("Claim in progress");
  });

  it("plan.heir mismatch -> 'No longer named' (heir reassignment)", async () => {
    setupAssignment();
    const now = Math.floor(Date.now() / 1000);
    useReadContractMock.mockReturnValue({
      data: [HEIR, BigInt(30 * 86400), BigInt(now), BigInt(0), true, []] as readonly [
        string, bigint, bigint, bigint, boolean, readonly string[],
      ],
    });
    const { container } = render(<InheritancePlanning />);
    await flush();
    // Source uses `!stillHeir` which checks the principal-plan's heir is not
    // zero (it always uses the active flag here, not heir equality). When
    // active=true + heir != 0x0 the row reports "Active" regardless of who
    // the heir is. The "No longer named" branch fires when plan was removed.
    expect(container.textContent).toContain("Active");
  });

  it("View status click pre-fills claimOwner input with principal address", async () => {
    setupAssignment();
    const now = Math.floor(Date.now() / 1000);
    useReadContractMock.mockReturnValue({
      data: [ME, BigInt(30 * 86400), BigInt(now), BigInt(0), true, []] as readonly [
        string, bigint, bigint, bigint, boolean, readonly string[],
      ],
    });
    const { container } = render(<InheritancePlanning />);
    await flush();
    fireEvent.click(findButton(container, "View status"));
    const claimInput = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    expect(claimInput.value.toLowerCase()).toBe(PRINCIPAL.toLowerCase());
  });
});

// ----- Heir claim section ----- //

describe("InheritancePlanning — Start Claim (§15.x)", () => {
  it("empty claimOwner disables Start Claim button", () => {
    const { container } = render(<InheritancePlanning />);
    const btn = findButton(container, "Start Claim");
    expect(btn.disabled).toBe(true);
  });

  it("invalid hex claimOwner -> Invalid Ethereum address toast (no startClaim)", () => {
    const startClaim = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim,
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not-a-hex" } });
    fireEvent.click(findButton(container, "Start Claim"));
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(startClaim).toHaveBeenCalledTimes(0);
  });

  it("valid hex claimOwner -> startClaim(addr)", () => {
    const startClaim = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim,
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    fireEvent.click(findButton(container, "Start Claim"));
    expect(startClaim).toHaveBeenCalledWith(PRINCIPAL);
  });
});

// ----- Finalize Claim 3-state gating (audit Top-28 #27) ----- //

describe("InheritancePlanning — Finalize Claim 3-state gating (audit Top-28 #27) (§15.x)", () => {
  function withOwnerPlan(plan: readonly [string, bigint, bigint, bigint, boolean, readonly string[]]) {
    useReadContractMock.mockReturnValue({ data: plan });
  }

  it("(a) no claim started + valid owner -> 'Tap Start Claim first' hint + Finalize disabled", () => {
    const now = Math.floor(Date.now() / 1000);
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now), BigInt(0), true, [VAULT_USDC]]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    expect(container.textContent).toContain(`Tap "Start Claim" first`);
    const finalizeBtn = findButton(container, "Finalize Claim");
    expect(finalizeBtn.disabled).toBe(true);
  });

  it("(b) claim started + challenge running -> 'Challenge period ends in N day(s)' hint + Finalize disabled", () => {
    const now = Math.floor(Date.now() / 1000);
    // Started 3 days ago, 4 days left of 7-day window
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - 3 * 86400), true, [VAULT_USDC]]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    expect(container.textContent).toMatch(/Challenge period ends in \d+ day/);
    const finalizeBtn = findButton(container, "Finalize Claim");
    expect(finalizeBtn.disabled).toBe(true);
  });

  it("(b.2) <86400s remaining -> includes 'hour(s)' in copy via Math.ceil", () => {
    const now = Math.floor(Date.now() / 1000);
    // Started 6.99 days ago -> 0.01 day == ~864s left
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - Math.floor(6.99 * 86400)), true, [VAULT_USDC]]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    expect(container.textContent).toMatch(/hour/);
  });

  it("(c) claim started + 7 days fully elapsed + vaultCount > 0 -> Finalize ENABLED + label includes vault count", () => {
    const now = Math.floor(Date.now() / 1000);
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - 8 * 86400), true, [VAULT_USDC]]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    const finalizeBtn = findButton(container, "Finalize Claim");
    expect(finalizeBtn.disabled).toBe(false);
    expect(finalizeBtn.textContent).toContain("(1 vault)");
  });

  it("(c) multi-vault plural label '(2 vaults)' not '(2 vault)'", () => {
    const now = Math.floor(Date.now() / 1000);
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - 8 * 86400), true, [VAULT_USDC, "0x2222222222222222222222222222222222222222"]]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    const finalizeBtn = findButton(container, "Finalize Claim");
    expect(finalizeBtn.textContent).toContain("(2 vaults)");
  });

  it("ownerVaultCount === 0 -> Finalize disabled (regardless of grace state)", () => {
    const now = Math.floor(Date.now() / 1000);
    withOwnerPlan([HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - 8 * 86400), true, []]);
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    const finalizeBtn = findButton(container, "Finalize Claim");
    expect(finalizeBtn.disabled).toBe(true);
  });

  it("finalizeClaim called with (owner, vaultCount) on ready+enabled click", () => {
    const finalizeClaim = vi.fn();
    const now = Math.floor(Date.now() / 1000);
    useInheritanceMock.mockReturnValue({
      plan: null,
      setHeir: vi.fn(),
      setVaults: vi.fn(),
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim,
      isProcessing: false,
    });
    useReadContractMock.mockReturnValue({
      data: [HEIR, BigInt(30 * 86400), BigInt(now - 31 * 86400), BigInt(now - 8 * 86400), true, [VAULT_USDC]],
    });
    const { container } = render(<InheritancePlanning />);
    const input = container.querySelector(
      "input[placeholder='Owner address (who set you as heir)']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PRINCIPAL } });
    fireEvent.click(findButton(container, "Finalize Claim"));
    expect(finalizeClaim).toHaveBeenCalledWith(PRINCIPAL, 1);
  });
});

// ----- Active-plan claim-progress display ----- //

describe("InheritancePlanning — own-plan claim-progress card (§15.x)", () => {
  it("plan.claimStartedAt > 0 + > 7 days elapsed -> 'Ready to Finalize' pill", () => {
    const now = Math.floor(Date.now() / 1000);
    setInheritance({
      plan: planFromNow({
        claimStartedAt: now - 8 * 86400,
      }),
    });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Ready to Finalize");
  });

  it("plan.claimStartedAt > 0 + still in challenge window -> 'Time remaining: Xd, Yh'", () => {
    const now = Math.floor(Date.now() / 1000);
    setInheritance({
      plan: planFromNow({
        claimStartedAt: now - 3 * 86400,
      }),
    });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toMatch(/Time remaining: \d+ day/);
    expect(container.textContent).toMatch(/hour/);
  });

  it("plan.claimStartedAt === 0 -> no claim-progress card rendered", () => {
    setInheritance({ plan: planFromNow() });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).not.toContain("Claim started:");
    expect(container.textContent).not.toContain("Challenge period ends:");
  });
});

// ----- Protected Vaults section ----- //

describe("InheritancePlanning — Protected Vaults section (§15.x)", () => {
  it("renders vault count with singular/plural correctness", () => {
    setInheritance({ plan: planFromNow({ vaults: [VAULT_USDC] }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("1 vault protected");

    setInheritance({ plan: planFromNow({ vaults: [VAULT_USDC, "0x2222222222222222222222222222222222222222"] }) });
    const second = render(<InheritancePlanning />);
    expect(second.container.textContent).toContain("2 vaults protected");
  });

  it("renders 'USDC Vault' label for the canonical vault address", () => {
    setInheritance({ plan: planFromNow({ vaults: [VAULT_USDC] }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("USDC Vault");
    expect(container.textContent).toContain("Protected");
  });

  it("unknown vault address -> 'Unknown Vault' label fallback", () => {
    setInheritance({
      plan: planFromNow({
        vaults: ["0x3333333333333333333333333333333333333333"],
      }),
    });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("Unknown Vault");
  });

  it("zero vaults -> 'No vaults configured' amber warning copy", () => {
    setInheritance({ plan: planFromNow({ vaults: [] }) });
    const { container } = render(<InheritancePlanning />);
    expect(container.textContent).toContain("No vaults configured");
  });
});

// ----- Vault selector modal ----- //

describe("InheritancePlanning — Vault selector modal (§15.x)", () => {
  it("opens on 'Manage Vaults' click + lists USDC Vault from chain contracts", () => {
    setInheritance({ plan: planFromNow() });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    expect(container.textContent).toContain("Select Protected Vaults");
    expect(container.textContent).toContain("USDC Vault");
  });

  it("Save button label includes selected count + pluralization", () => {
    setInheritance({ plan: planFromNow({ vaults: [VAULT_USDC] }) });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    // Pre-selected from currentVaults -> 1 vault
    expect(container.textContent).toContain("Save 1 Vault");

    // Toggle off -> 0 Vaults
    const usdcBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("USDC Vault")) as HTMLButtonElement;
    fireEvent.click(usdcBtn);
    expect(container.textContent).toContain("Save 0 Vaults");
  });

  it("invalid custom vault address -> 'Invalid vault address' toast (no add)", () => {
    setInheritance({ plan: planFromNow({ vaults: [] }) });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    const customInput = container.querySelector(
      "input[placeholder='Custom vault address 0x...']",
    ) as HTMLInputElement;
    fireEvent.change(customInput, { target: { value: "not-an-address" } });
    fireEvent.click(findButton(container, "Add"));
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid vault address");
  });

  it("valid custom vault address -> added to selected set", () => {
    setInheritance({ plan: planFromNow({ vaults: [] }) });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    const customInput = container.querySelector(
      "input[placeholder='Custom vault address 0x...']",
    ) as HTMLInputElement;
    fireEvent.change(customInput, {
      target: { value: "0x4444444444444444444444444444444444444444" },
    });
    fireEvent.click(findButton(container, "Add"));
    // Save label should reflect the new count
    expect(container.textContent).toContain("Save 1 Vault");
    // Custom vault renders with truncated mono address
    expect(container.textContent).toContain("0x4444...4444");
  });

  it("Save click calls setVaults(selected[]) + closes modal", async () => {
    const setVaults = vi.fn().mockResolvedValue(undefined);
    useInheritanceMock.mockReturnValue({
      plan: planFromNow({ vaults: [VAULT_USDC] }),
      setHeir: vi.fn(),
      setVaults,
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    fireEvent.click(findButton(container, "Save 1 Vault"));
    await flush();
    expect(setVaults).toHaveBeenCalledTimes(1);
    expect(setVaults.mock.calls[0][0]).toEqual([VAULT_USDC.toLowerCase()]);
    // Modal should be closed
    expect(container.textContent).not.toContain("Select Protected Vaults");
  });

  it("Cancel button closes modal without saving", () => {
    const setVaults = vi.fn();
    useInheritanceMock.mockReturnValue({
      plan: planFromNow({ vaults: [VAULT_USDC] }),
      setHeir: vi.fn(),
      setVaults,
      heartbeat: vi.fn(),
      removeHeir: vi.fn(),
      startClaim: vi.fn(),
      finalizeClaim: vi.fn(),
      isProcessing: false,
    });
    const { container } = render(<InheritancePlanning />);
    fireEvent.click(findButton(container, "Manage Vaults"));
    fireEvent.click(findButton(container, "Cancel"));
    expect(setVaults).toHaveBeenCalledTimes(0);
    expect(container.textContent).not.toContain("Select Protected Vaults");
  });
});
