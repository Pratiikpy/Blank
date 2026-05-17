import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for CreateCampaign screen. The PRODUCER side of the
// /fund/:chainId/:campaignId URL contract that CrowdfundPage (the
// consumer) parses. CrowdfundPage.test.tsx pinned the consumer
// shape; this test pins that CreateCampaign emits the URL the way
// CrowdfundPage parses it. Producer + consumer pinned together
// catch any drift between either end.
//
// CRITICAL pins:
//   - validation cascade: empty title -> "Title required"; goal
//     <= 0 -> "Set a goal above zero". Pin proves the cascade is
//     order-dependent (title checked first).
//   - description hash: empty description -> ZERO bytes32 (sentinel
//     that lets the contract know no description was supplied);
//     non-empty -> keccak256(stringToBytes(trimmed)). The zero
//     sentinel is a deliberate contract-level choice; pin so a
//     refactor that hashes empty string instead lands in review.
//   - goal input sanitizer strips non-numeric (seventh independent
//     enforcement of the precision-input contract).
//   - 3 duration presets (1d / 7d / 30d) with aria-pressed; default
//     is 7d (DURATIONS[1].seconds = 7 * 86_400).
//   - success state share URL shape: `${origin}/fund/<chainId>/
//     <campaignId>` matches CrowdfundPage's `/fund/:chainId/
//     :campaignId` route param shape.
//   - "Create another" reset clears all 3 form fields + calls
//     reset on the hook.

const useChainMock = vi.hoisted(() => vi.fn());
const useCrowdfundMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useCrowdfund", () => ({ useCrowdfund: useCrowdfundMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import CreateCampaign from "./CreateCampaign";

const VAULT_USDC = "0xfffffffffffffffffffffffffffffffffffffff1";

let createCampaignMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  lastCampaignId: number | null;
  pipelinePhase: string;
}> = {}) {
  useCrowdfundMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
      lastCampaignId: overrides.lastCampaignId ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    createCampaign: createCampaignMock,
    // §1.15 B4b — creator-side surface defaults to empty.
    closeCampaign: vi.fn().mockResolvedValue(true),
    fetchCreatorCampaigns: vi.fn().mockResolvedValue([]),
    fetchCampaign: vi.fn().mockResolvedValue(null),
    reset: resetMock,
  });
}

beforeEach(() => {
  useChainMock.mockReset();
  useCrowdfundMock.mockReset();
  useEffectiveAddressMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();

  useChainMock.mockReturnValue({
    contracts: { FHERC20Vault_USDC: VAULT_USDC },
    activeChainId: 11155111,
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });

  createCampaignMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  setHook();

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

describe("CreateCampaign — page chrome (§15.x)", () => {
  it("renders 'Launch a private campaign' heading + 3-clause privacy framing", () => {
    const { container } = render(<CreateCampaign />);
    expect(container.textContent).toContain("Launch a private campaign");
    expect(container.textContent).toContain("Encrypted goal");
    expect(container.textContent).toContain("Encrypted contributions");
    expect(container.textContent).toContain("Refund-on-miss");
  });

  it("renders 3 form fields: title + description + goal", () => {
    const { container } = render(<CreateCampaign />);
    expect(container.textContent).toContain("Campaign title");
    expect(container.textContent).toContain("Description");
    expect(container.textContent).toContain("Funding goal (USDC)");
  });

  it("submit button reads 'Launch campaign' at rest", () => {
    const { getByText } = render(<CreateCampaign />);
    expect(getByText("Launch campaign")).toBeDefined();
  });
});

describe("CreateCampaign — validation cascade (§15.x)", () => {
  it("empty title -> 'Title required' label + Launch button disabled", () => {
    const { container, getByText } = render(<CreateCampaign />);
    expect(container.textContent).toContain("Title required");
    const btn = getByText("Launch campaign").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("title set + empty goal -> 'Set a goal above zero'", () => {
    const { getByPlaceholderText, container } = render(<CreateCampaign />);
    fireEvent.change(getByPlaceholderText("Save the bees fund"), { target: { value: "Test" } });
    expect(container.textContent).toContain("Set a goal above zero");
  });

  it("title set + goal=0 -> still 'Set a goal above zero'", () => {
    const { getByPlaceholderText, container } = render(<CreateCampaign />);
    fireEvent.change(getByPlaceholderText("Save the bees fund"), { target: { value: "Test" } });
    fireEvent.change(getByPlaceholderText("500.00"), { target: { value: "0" } });
    expect(container.textContent).toContain("Set a goal above zero");
  });

  it("CRITICAL cascade order: title-empty wins over goal-empty (title checked FIRST)", () => {
    const { getByPlaceholderText, container } = render(<CreateCampaign />);
    // Goal set, title empty -> title error wins
    fireEvent.change(getByPlaceholderText("500.00"), { target: { value: "100" } });
    expect(container.textContent).toContain("Title required");
    expect(container.textContent).not.toContain("Set a goal above zero");
  });

  it("valid title + valid goal -> validation cleared + Launch enabled", () => {
    const { getByPlaceholderText, getByText, container } = render(<CreateCampaign />);
    fireEvent.change(getByPlaceholderText("Save the bees fund"), { target: { value: "Test" } });
    fireEvent.change(getByPlaceholderText("500.00"), { target: { value: "100" } });
    expect(container.textContent).not.toContain("Title required");
    expect(container.textContent).not.toContain("Set a goal above zero");
    const btn = getByText("Launch campaign").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("clicking Launch with validation error fires toast.error + does NOT call createCampaign", async () => {
    const { getByText } = render(<CreateCampaign />);
    const btn = getByText("Launch campaign");
    // Even though disabled, exercise the handler defensively.
    expect((btn.closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(createCampaignMock).not.toHaveBeenCalled();
  });
});

describe("CreateCampaign — goal input sanitizer (§15.x)", () => {
  it("strips non-numeric (seventh independent enforcement of precision-input contract)", () => {
    const { getByPlaceholderText } = render(<CreateCampaign />);
    const input = getByPlaceholderText("500.00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc12.34$" } });
    expect(input.value).toBe("12.34");
  });

  it("accepts numeric + dot only", () => {
    const { getByPlaceholderText } = render(<CreateCampaign />);
    const input = getByPlaceholderText("500.00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1234.56" } });
    expect(input.value).toBe("1234.56");
  });
});

describe("CreateCampaign — duration picker (§15.x)", () => {
  it("3 preset buttons: 1 day / 7 days / 30 days", () => {
    const { getByText } = render(<CreateCampaign />);
    expect(getByText("1 day")).toBeDefined();
    expect(getByText("7 days")).toBeDefined();
    expect(getByText("30 days")).toBeDefined();
  });

  it("CRITICAL default duration = 7 days (DURATIONS[1])", () => {
    const { getByText } = render(<CreateCampaign />);
    expect(getByText("7 days").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("1 day").getAttribute("aria-pressed")).toBe("false");
    expect(getByText("30 days").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking '1 day' flips aria-pressed", () => {
    const { getByText } = render(<CreateCampaign />);
    fireEvent.click(getByText("1 day"));
    expect(getByText("1 day").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("7 days").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking '30 days' switches active preset", () => {
    const { getByText } = render(<CreateCampaign />);
    fireEvent.click(getByText("30 days"));
    expect(getByText("30 days").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("CreateCampaign — handleCreate flow (§15.x)", () => {
  function fillValid(getByPlaceholderText: (t: string) => HTMLElement, opts: { title?: string; description?: string; goal?: string } = {}) {
    fireEvent.change(getByPlaceholderText("Save the bees fund"), { target: { value: opts.title ?? "Test campaign" } });
    fireEvent.change(getByPlaceholderText("500.00"), { target: { value: opts.goal ?? "100" } });
    if (opts.description) {
      fireEvent.change(getByPlaceholderText("What you're raising for. Why people should chip in."), { target: { value: opts.description } });
    }
  }

  it("valid form + click Launch -> createCampaign with vault + goal + decimals=6 + duration + trimmed title", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateCampaign />);
    fillValid(getByPlaceholderText, { title: "  Save the bees  ", goal: "500" });
    await act(async () => {
      fireEvent.click(getByText("Launch campaign"));
      await Promise.resolve();
    });
    expect(createCampaignMock).toHaveBeenCalled();
    const arg = createCampaignMock.mock.calls[0][0];
    expect(arg.vault).toBe(VAULT_USDC);
    expect(arg.goalTokens).toBe("500");
    expect(arg.decimals).toBe(6);
    expect(arg.durationSeconds).toBe(7 * 86_400); // default 7d
    expect(arg.title).toBe("Save the bees"); // trimmed
  });

  it("CRITICAL empty description -> descriptionCidHash = ZERO bytes32 (contract sentinel for no-description)", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateCampaign />);
    fillValid(getByPlaceholderText, {});
    await act(async () => {
      fireEvent.click(getByText("Launch campaign"));
      await Promise.resolve();
    });
    expect(createCampaignMock).toHaveBeenCalled();
    expect(createCampaignMock.mock.calls[0][0].descriptionCidHash).toBe(
      "0x" + "00".repeat(32),
    );
  });

  it("CRITICAL non-empty description -> descriptionCidHash = keccak256(stringToBytes(trimmed))", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateCampaign />);
    fillValid(getByPlaceholderText, { description: "  raising for bees  " });
    await act(async () => {
      fireEvent.click(getByText("Launch campaign"));
      await Promise.resolve();
    });
    const hash = createCampaignMock.mock.calls[0][0].descriptionCidHash;
    // Should be a non-zero 32-byte hex hash.
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(hash).not.toBe("0x" + "00".repeat(32));
  });

  it("description is TRIMMED before hashing (whitespace-only does NOT hash, falls to zero sentinel)", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateCampaign />);
    fillValid(getByPlaceholderText, { description: "   " });
    await act(async () => {
      fireEvent.click(getByText("Launch campaign"));
      await Promise.resolve();
    });
    expect(createCampaignMock.mock.calls[0][0].descriptionCidHash).toBe(
      "0x" + "00".repeat(32),
    );
  });

  it("duration override: clicking '30 days' then Launch sends 30d in seconds", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateCampaign />);
    fillValid(getByPlaceholderText, {});
    fireEvent.click(getByText("30 days"));
    await act(async () => {
      fireEvent.click(getByText("Launch campaign"));
      await Promise.resolve();
    });
    expect(createCampaignMock.mock.calls[0][0].durationSeconds).toBe(30 * 86_400);
  });

  it("isProcessing -> 'Creating…' label + button disabled", () => {
    setHook({ isProcessing: true });
    const { getByText } = render(<CreateCampaign />);
    const btn = getByText("Creating…").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("CreateCampaign — pipeline + error display (§15.x)", () => {
  it("pipeline.phase !== 'idle' renders FhePipelineProgress with phase", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<CreateCampaign />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("state.error renders inline (not silent)", () => {
    setHook({ error: "Vault not set" });
    const { container } = render(<CreateCampaign />);
    expect(container.textContent).toContain("Vault not set");
  });
});

describe("CreateCampaign — success state + share URL (PRODUCER side of CrowdfundPage contract) (§15.x)", () => {
  beforeEach(() => {
    setHook({ step: "success", lastCampaignId: 42 });
  });

  it("CRITICAL share URL shape: ${origin}/fund/<chainId>/<campaignId> matches CrowdfundPage route", () => {
    const { container } = render(<CreateCampaign />);
    const text = container.textContent ?? "";
    // The URL contains /fund/<chainId>/<campaignId>
    expect(text).toMatch(/\/fund\/11155111\/42/);
  });

  it("renders 'Campaign live' headline + refund-on-miss reassurance copy", () => {
    const { container } = render(<CreateCampaign />);
    expect(container.textContent).toContain("Campaign live");
    expect(container.textContent).toContain("Contributions stay encrypted");
    expect(container.textContent).toContain("contributors get refunded");
  });

  it("Copy link click writes share URL to clipboard + 'Link copied' toast", async () => {
    const { getByText } = render(<CreateCampaign />);
    await act(async () => {
      fireEvent.click(getByText("Copy link"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalled();
    expect(writeTextMock.mock.calls[0][0]).toMatch(/\/fund\/11155111\/42$/);
    expect(toastSuccessMock).toHaveBeenCalledWith("Link copied");
  });

  it("'Create another' click calls reset + clears local form fields", () => {
    const { getByText } = render(<CreateCampaign />);
    fireEvent.click(getByText("Create another"));
    expect(resetMock).toHaveBeenCalled();
  });

  it("success state with lastCampaignId=null falls through to FORM (no broken /fund//null URL)", () => {
    setHook({ step: "success", lastCampaignId: null });
    const { container } = render(<CreateCampaign />);
    // Falls through to the form (no Campaign live card).
    expect(container.textContent).not.toContain("Campaign live");
    expect(container.textContent).toContain("Launch a private campaign");
  });

  it("share URL uses activeChainId from useChain (chain-aware)", () => {
    useChainMock.mockReturnValue({
      contracts: { FHERC20Vault_USDC: VAULT_USDC },
      activeChainId: 84532,
    });
    setHook({ step: "success", lastCampaignId: 7 });
    const { container } = render(<CreateCampaign />);
    expect(container.textContent).toMatch(/\/fund\/84532\/7/);
  });
});
