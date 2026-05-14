import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for CrowdfundPage. Public Wave 4 deep-link landing
// for /fund/:chainId/:campaignId. Sibling to ClaimLinkPage in
// shape (load-error matrix + state machine + success terminal +
// cancellation guard) but with a richer phase machine: open ->
// needsClose -> needsPublish -> released / refunding, with each
// phase showing a DIFFERENT CTA.
//
// CRITICAL pins:
//   - 5-state phase machine derived from on-chain status +
//     deadline + resultPublished + goalMet. The else-if cascade
//     resolves precedence; pin proves a STATUS_RELEASED row does
//     not also accidentally render the "needsPublish" CTA.
//   - 4-branch load error matching ClaimLinkPage's pattern
//   - parallel two-call fetch sequence: getCampaign followed by
//     getContributionCount. If the count call fails the page
//     still shows the campaign (graceful degradation).
//   - refund flow: prompt for contribution index, validate
//     non-negative integer, reject empty/negative/non-numeric.
//     A free-form prompt input is a known footgun; the test
//     pins all the rejection branches so a refactor that loosens
//     validation lands in review.
//   - input sanitizer on contribute amount: e.target.value
//     stripped to /[0-9.]/ only (matches sibling-screen pattern)
//   - cancellation guard via spyOn(console, "error")

const useParamsMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useCrowdfundMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useParams: useParamsMock }));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useCrowdfund", () => ({ useCrowdfund: useCrowdfundMock }));
vi.mock("@/lib/constants", () => ({
  CONTRACTS_BY_CHAIN: {
    11155111: { EncryptedCrowdfund: "0xcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf" },
    84532: { EncryptedCrowdfund: "0x1111111111111111111111111111111111111111" },
    9999: { EncryptedCrowdfund: "0x0000000000000000000000000000000000000000" },
  },
}));
vi.mock("@/lib/abis", () => ({ EncryptedCrowdfundAbi: [] }));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import CrowdfundPage from "./CrowdfundPage";

const CREATOR = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

const STATUS_OPEN = 0;
const STATUS_CLOSED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDING = 3;

let readContractMock: ReturnType<typeof vi.fn>;
let contributeMock: ReturnType<typeof vi.fn>;
let closeCampaignMock: ReturnType<typeof vi.fn>;
let claimReleaseMock: ReturnType<typeof vi.fn>;
let claimRefundMock: ReturnType<typeof vi.fn>;

function buildCampaign(over: Partial<{
  creator: string;
  vault: string;
  deadline: bigint;
  status: number;
  goalMet: boolean;
  resultPublished: boolean;
  title: string;
  descriptionCidHash: string;
  createdAt: bigint;
}> = {}): readonly unknown[] {
  const o = {
    creator: CREATOR,
    vault: VAULT,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 5), // 5d future
    status: STATUS_OPEN,
    goalMet: false,
    resultPublished: false,
    title: "Build a private podcast network",
    descriptionCidHash: "0x" + "11".repeat(32),
    createdAt: 1000n,
    ...over,
  };
  return [
    o.creator, o.vault, o.deadline, o.status, o.goalMet, o.resultPublished,
    o.title, o.descriptionCidHash, o.createdAt,
  ];
}

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  pipelinePhase: string;
}> = {}) {
  useCrowdfundMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    contribute: contributeMock,
    closeCampaign: closeCampaignMock,
    claimRelease: claimReleaseMock,
    claimRefund: claimRefundMock,
  });
}

function makeReadContract(campaign: readonly unknown[], contributionCount = 0) {
  return vi.fn().mockImplementation(async (args: { functionName: string }) => {
    if (args.functionName === "getCampaign") return campaign;
    if (args.functionName === "getContributionCount") return BigInt(contributionCount);
    return null;
  });
}

beforeEach(() => {
  useParamsMock.mockReset();
  usePublicClientMock.mockReset();
  useCrowdfundMock.mockReset();
  toastErrorMock.mockReset();

  useParamsMock.mockReturnValue({ chainId: "11155111", campaignId: "7" });

  readContractMock = makeReadContract(buildCampaign(), 3);
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });

  contributeMock = vi.fn().mockResolvedValue(undefined);
  closeCampaignMock = vi.fn().mockResolvedValue(undefined);
  claimReleaseMock = vi.fn().mockResolvedValue(undefined);
  claimRefundMock = vi.fn().mockResolvedValue(undefined);
  setHook();
});

afterEach(() => {
  // NOTE: do NOT call vi.restoreAllMocks() here. It undoes vi.mock()
  // module replacements (the docs say it restores "replaced exports"),
  // which makes the next test's useCrowdfundMock.mockReturnValue a no-op
  // and the page sits in "Loading campaign…" forever. The per-test
  // mockReset() in beforeEach handles state cleanup just fine.
  vi.useRealTimers();
});

describe("CrowdfundPage — load-error branches (§15.x)", () => {
  it("invalid chainId (NaN) -> 'Invalid URL'", async () => {
    useParamsMock.mockReturnValue({ chainId: "abc", campaignId: "7" });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Invalid URL")).toBeDefined();
  });

  it("invalid campaignId -> 'Invalid URL'", async () => {
    useParamsMock.mockReturnValue({ chainId: "11155111", campaignId: "xyz" });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Invalid URL")).toBeDefined();
  });

  it("unsupported chain -> 'Unsupported chain'", async () => {
    useParamsMock.mockReturnValue({ chainId: "1", campaignId: "7" });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Unsupported chain")).toBeDefined();
  });

  it("zero EncryptedCrowdfund address on chain -> 'Crowdfund not deployed on this chain yet'", async () => {
    useParamsMock.mockReturnValue({ chainId: "9999", campaignId: "7" });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Crowdfund not deployed on this chain yet")).toBeDefined();
  });

  it("creator = address(0) -> 'Campaign not found'", async () => {
    readContractMock = makeReadContract(buildCampaign({ creator: ZERO }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Campaign not found")).toBeDefined();
  });

  it("readContract throws Error -> error.message as loadError", async () => {
    readContractMock = vi.fn().mockRejectedValue(new Error("RPC reverted"));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("RPC reverted")).toBeDefined();
  });

  it("readContract throws non-Error -> 'Failed to load campaign' fallback", async () => {
    readContractMock = vi.fn().mockRejectedValue("string rejection");
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Failed to load campaign")).toBeDefined();
  });
});

describe("CrowdfundPage — loading state (§15.x)", () => {
  it("publicClient pending -> 'Loading campaign…'", async () => {
    readContractMock = vi.fn().mockReturnValue(new Promise(() => {}));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container } = render(<CrowdfundPage />);
    await waitFor(() => expect(container.textContent).toContain("Loading campaign"));
  });

  it("no publicClient -> stays in loading state", async () => {
    usePublicClientMock.mockReturnValue(undefined);
    const { container } = render(<CrowdfundPage />);
    await waitFor(() => expect(container.textContent).toContain("Loading campaign"));
  });
});

describe("CrowdfundPage — campaign header rendering (§15.x)", () => {
  it("renders title + truncated creator + contribution count (plural)", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ title: "Build a private podcast network", creator: CREATOR }),
      3,
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container, findByText } = render(<CrowdfundPage />);
    await findByText("Build a private podcast network");
    expect(container.textContent).toContain("3 contributions");
    expect(container.textContent).toMatch(/0xc0c0.{1,3}c0c0/i);
  });

  it("singular 'contribution' for count=1", async () => {
    readContractMock = makeReadContract(buildCampaign(), 1);
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container, findByText } = render(<CrowdfundPage />);
    await findByText("Build a private podcast network");
    expect(container.textContent).toContain("1 contribution so far");
    expect(container.textContent).not.toContain("1 contributions");
  });

  it("'Encrypted crowdfund' eyebrow label + privacy framing copy", async () => {
    const { container, findByText } = render(<CrowdfundPage />);
    await findByText("Build a private podcast network");
    expect(container.textContent).toContain("Encrypted crowdfund");
    expect(container.textContent).toContain("Goal + total raised stay encrypted");
  });
});

describe("CrowdfundPage — 5-state phase machine (§15.x)", () => {
  it("STATUS_OPEN + deadline in future -> 'open' phase shows ContributeForm", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_OPEN, deadline: BigInt(Math.floor(Date.now() / 1000) + 86400) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Contribute privately")).toBeDefined();
  });

  it("STATUS_OPEN + deadline passed -> 'needsClose' phase shows 'Close campaign' CTA", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_OPEN, deadline: BigInt(Math.floor(Date.now() / 1000) - 1) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Close campaign");
    expect(container.textContent).toContain("Deadline reached");
  });

  it("STATUS_CLOSED + !resultPublished -> 'needsPublish' phase shows 'Refresh' CTA", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_CLOSED, resultPublished: false }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Refresh");
    expect(container.textContent).toContain("Awaiting threshold-network verdict");
  });

  it("STATUS_RELEASED -> 'released' phase shows 'Creator: claim release' CTA", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_RELEASED, resultPublished: true, goalMet: true }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Creator: claim release");
    expect(container.textContent).toContain("Goal met. Campaign succeeded");
  });

  it("resultPublished+goalMet (status still CLOSED) -> 'released' branch", async () => {
    // Per source: `STATUS_RELEASED || (resultPublished && goalMet)` -> released
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_CLOSED, resultPublished: true, goalMet: true }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Creator: claim release")).toBeDefined();
  });

  it("STATUS_REFUNDING -> 'refunding' phase shows 'Refund my contribution' CTA", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_REFUNDING, resultPublished: true, goalMet: false }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Refund my contribution");
    expect(container.textContent).toContain("Goal not met. Each contributor can pull their amount back");
  });

  it("resultPublished+!goalMet (status still CLOSED) -> 'refunding' branch", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_CLOSED, resultPublished: true, goalMet: false }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Refund my contribution")).toBeDefined();
  });
});

describe("CrowdfundPage — contribute flow (§15.x)", () => {
  it("amount input strips non-numeric characters (matches sibling-screen pattern)", async () => {
    const { findByPlaceholderText } = render(<CrowdfundPage />);
    const input = (await findByPlaceholderText("any amount")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ab12.34$" } });
    expect(input.value).toBe("12.34");
  });

  it("submit disabled when amount empty", async () => {
    const { findByText } = render(<CrowdfundPage />);
    const btn = (await findByText("Contribute privately")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("submit disabled when amount <= 0", async () => {
    const { findByText, findByPlaceholderText } = render(<CrowdfundPage />);
    const input = (await findByPlaceholderText("any amount")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    const btn = (await findByText("Contribute privately")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("submit with positive amount calls contribute with campaignId/vault/amountTokens/decimals=6", async () => {
    const { findByText, findByPlaceholderText } = render(<CrowdfundPage />);
    const input = (await findByPlaceholderText("any amount")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25.50" } });
    await act(async () => {
      fireEvent.click(await findByText("Contribute privately"));
      await Promise.resolve();
    });
    expect(contributeMock).toHaveBeenCalledWith({
      campaignId: 7,
      vault: VAULT,
      amountTokens: "25.50",
      decimals: 6,
    });
  });

  it("isProcessing -> 'Submitting…' label", async () => {
    setHook({ isProcessing: true });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("Submitting…")).toBeDefined();
  });

  it("ContributeForm shows remaining-time pill with days + hours", async () => {
    // 2 days + 3 hours in seconds
    const futureSec = Math.floor(Date.now() / 1000) + 2 * 86400 + 3 * 3600;
    readContractMock = makeReadContract(
      buildCampaign({ deadline: BigInt(futureSec) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Contribute privately");
    expect(container.textContent).toMatch(/2d \d+h left to contribute/);
  });

  it("FHE encryption-before-leaves-browser disclosure visible on ContributeForm", async () => {
    const { findByText, container } = render(<CrowdfundPage />);
    await findByText("Contribute privately");
    expect(container.textContent).toContain("FHE-encrypted before it leaves your browser");
    expect(container.textContent).toContain("Nobody");
    expect(container.textContent).toContain("not even the creator");
  });
});

describe("CrowdfundPage — close + claimRelease (§15.x)", () => {
  it("'Close campaign' click calls closeCampaign(campaignId)", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_OPEN, deadline: BigInt(Math.floor(Date.now() / 1000) - 1) }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    // findByText OUTSIDE act -- otherwise the await-inside-act-async pattern
    // races React's state-update flush with the polling loop and leaves the
    // click unfired by the time the assertion runs.
    const btn = await findByText("Close campaign");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(closeCampaignMock).toHaveBeenCalledWith(7);
  });

  it("'Creator: claim release' click calls claimRelease(campaignId)", async () => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_RELEASED, resultPublished: true, goalMet: true }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<CrowdfundPage />);
    const btn = await findByText("Creator: claim release");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimReleaseMock).toHaveBeenCalledWith(7);
  });
});

describe("CrowdfundPage — refund flow (prompt validation) (§15.x)", () => {
  beforeEach(() => {
    readContractMock = makeReadContract(
      buildCampaign({ status: STATUS_REFUNDING, resultPublished: true, goalMet: false }),
    );
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("user cancels prompt (null) -> claimRefund NOT called (no toast, no action)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(claimRefundMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("empty trimmed input -> 'Contribution index required' toast", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(toastErrorMock).toHaveBeenCalledWith("Contribution index required");
    expect(claimRefundMock).not.toHaveBeenCalled();
  });

  it("non-numeric input -> 'must be a non-negative integer' toast", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("abc");
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("non-negative integer");
    expect(claimRefundMock).not.toHaveBeenCalled();
  });

  it("negative integer -> 'non-negative integer' toast (NOT silent)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("-1");
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(claimRefundMock).not.toHaveBeenCalled();
  });

  it("CRITICAL: fractional input '1.5' rejected (String(idx) !== trimmed guard)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("1.5");
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(claimRefundMock).not.toHaveBeenCalled();
  });

  it("CRITICAL: leading-zero input '007' rejected (String(idx)=='7' != '007')", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("007");
    const { findByText } = render(<CrowdfundPage />);
    fireEvent.click(await findByText("Refund my contribution"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(claimRefundMock).not.toHaveBeenCalled();
  });

  it("valid integer '0' -> claimRefund(campaignId, 0) called", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("0");
    const { findByText } = render(<CrowdfundPage />);
    const btn = await findByText("Refund my contribution");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimRefundMock).toHaveBeenCalledWith(7, 0);
  });

  it("valid integer '5' -> claimRefund(campaignId, 5) called", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("5");
    const { findByText } = render(<CrowdfundPage />);
    const btn = await findByText("Refund my contribution");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimRefundMock).toHaveBeenCalledWith(7, 5);
  });

  it("whitespace-padded valid integer ' 3 ' -> claimRefund(7, 3) (trim before parse)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("  3  ");
    const { findByText } = render(<CrowdfundPage />);
    const btn = await findByText("Refund my contribution");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimRefundMock).toHaveBeenCalledWith(7, 3);
  });
});

describe("CrowdfundPage — success terminal + pipeline + error (§15.x)", () => {
  it("state.step === 'success' shows 'Done' card + Open Blank link", async () => {
    setHook({ step: "success" });
    const { findByText } = render(<CrowdfundPage />);
    await findByText("Done");
    const link = (await findByText("Open Blank")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/app");
  });

  it("pipeline.phase !== 'idle' renders FhePipelineProgress with phase", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<CrowdfundPage />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("state.error renders inline (not silent)", async () => {
    setHook({ error: "paymaster rejected" });
    const { findByText } = render(<CrowdfundPage />);
    expect(await findByText("paymaster rejected")).toBeDefined();
  });
});

describe("CrowdfundPage — cancellation guard (§15.x)", () => {
  it("CRITICAL: unmount during pending readContract does NOT setState on unmounted component", async () => {
    let resolveRead!: (v: unknown) => void;
    readContractMock = vi.fn().mockReturnValue(new Promise((res) => { resolveRead = res; }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<CrowdfundPage />);
    unmount();

    await act(async () => {
      resolveRead(buildCampaign());
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((c) => c.includes("unmounted component"))).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});
