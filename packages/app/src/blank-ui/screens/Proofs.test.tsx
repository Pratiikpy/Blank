import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for Proofs screen. The encrypted-proof generator + list.
// Pins:
//   - passkey-aware address resolution (effectiveAddress, not wagmi)
//   - income vs balance proof kind toggle (heading + which create-fn
//     dispatches)
//   - threshold-input regex /^\d*\.?\d{0,2}$/ (rejects 3rd decimal,
//     non-numeric; matches SendAmount-style controlled-input pattern)
//   - 3-state proof row (pending Clock / true CheckCircle / false
//     XCircle) with distinct status copy
//   - CRITICAL auto-poll: any !isReady proof -> setInterval(10s)
//     re-fires refresh, cleared when all proofs ready or on unmount
//   - share-link shape `/verify/<id>?chain=<chainId>` + Twitter
//     intent URL with 3 branches (not-ready / true / false copy)
//   - threshold USDC unit math: threshold (6dp bigint) / 1_000_000
//     renders as USD

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useQualificationProofMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));
vi.mock("@/hooks/useQualificationProof", () => ({
  useQualificationProof: useQualificationProofMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import Proofs from "./Proofs";

const ADDR = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

type ProofRecord = {
  threshold: bigint;
  timestamp: bigint;
  isReady: boolean;
  isTrue: boolean;
  blockNumber: bigint;
};

let createIncomeProofMock: ReturnType<typeof vi.fn>;
let createBalanceProofMock: ReturnType<typeof vi.fn>;
let publishProofMock: ReturnType<typeof vi.fn>;
let fetchProofMock: ReturnType<typeof vi.fn>;
let fetchProofsByUserMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

function buildProof(over: Partial<ProofRecord> = {}): ProofRecord {
  return {
    threshold: 50_000_000_000n, // $50,000 in USDC 6-dp
    timestamp: 1700000000n,
    isReady: true,
    isTrue: true,
    blockNumber: 100n,
    ...over,
  };
}

function setHook(overrides: Partial<{
  step: "idle" | "creating" | "error" | "success";
  error: string | null;
  proofsToReturn: bigint[];
  proofMap: Record<string, ProofRecord>;
}> = {}) {
  const opts = { step: "idle" as const, error: null, proofsToReturn: [], proofMap: {}, ...overrides };
  fetchProofsByUserMock.mockResolvedValue(opts.proofsToReturn);
  fetchProofMock.mockImplementation(async (id: bigint) => opts.proofMap[id.toString()] ?? null);
  useQualificationProofMock.mockReturnValue({
    createIncomeProof: createIncomeProofMock,
    createBalanceProof: createBalanceProofMock,
    publishProof: publishProofMock,
    fetchProof: fetchProofMock,
    fetchProofsByUser: fetchProofsByUserMock,
    step: opts.step,
    error: opts.error,
    reset: resetMock,
  });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useQualificationProofMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ADDR });
  useChainMock.mockReturnValue({
    activeChain: { id: 11155111, name: "Ethereum Sepolia", explorerUrl: "https://sepolia.etherscan.io" },
    activeChainId: 11155111,
  });

  createIncomeProofMock = vi.fn().mockResolvedValue(1n);
  createBalanceProofMock = vi.fn().mockResolvedValue(2n);
  publishProofMock = vi.fn().mockResolvedValue(true);
  fetchProofMock = vi.fn();
  fetchProofsByUserMock = vi.fn();
  resetMock = vi.fn();

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });

  setHook();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Proofs — page chrome (§15.x)", () => {
  it("renders 'Encrypted Proofs' heading + privacy explainer", async () => {
    const { container, findByText } = render(<Proofs />);
    await findByText("Encrypted Proofs");
    expect(container.textContent).toContain("Encrypted Proofs");
    expect(container.textContent).toContain("Prove");
    expect(container.textContent).toContain("without revealing the actual amount");
  });

  it("kind toggle defaults to 'income' (heading reads 'Create a new income proof')", async () => {
    const { findByText } = render(<Proofs />);
    expect(await findByText("Create a new income proof")).toBeDefined();
  });

  it("clicking Balance flips kind: heading becomes 'Create a new balance proof'", async () => {
    const { getByText, findByText } = render(<Proofs />);
    await findByText("Create a new income proof");
    fireEvent.click(getByText("Balance"));
    expect(await findByText("Create a new balance proof")).toBeDefined();
  });
});

describe("Proofs — threshold input regex (§15.x)", () => {
  it("accepts integer typing (e.g. '50000')", async () => {
    const { getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50000" } });
    expect(input.value).toBe("50000");
  });

  it("accepts 2-dp decimal (e.g. '1234.56')", async () => {
    const { getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1234.56" } });
    expect(input.value).toBe("1234.56");
  });

  it("rejects 3rd decimal (state stays at prior value)", async () => {
    const { getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12.34" } });
    fireEvent.change(input, { target: { value: "12.345" } });
    expect(input.value).toBe("12.34");
  });

  it("rejects non-numeric input", async () => {
    const { getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("");
  });

  it("allows empty (so user can clear the input)", async () => {
    const { getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
  });
});

describe("Proofs — preset chips (§15.x)", () => {
  it("renders 4 preset chips with $-prefixed numeric labels", async () => {
    // Two gotchas pinned here together:
    //   (1) JSX `${preset.toLocaleString()}` renders the "$" and number
    //       as adjacent text nodes inside each chip button.
    //   (2) jsdom defaults to an en-IN-style locale on this Windows env,
    //       so 100_000.toLocaleString() = "1,00,000" not "100,000".
    // Both make findByText("$100,000") fail. Walk textContent + use a
    // locale-agnostic chip-count via regex on dollar-prefixed runs.
    const { container } = render(<Proofs />);
    await waitFor(() => {
      const chipMatches = (container.textContent ?? "").match(/\$[\d,]+/g) ?? [];
      // 4 preset chips at minimum (plus the heading "$X" in the explainer).
      expect(chipMatches.length).toBeGreaterThanOrEqual(4);
    });
    // Verify locale-stable smaller presets render as expected.
    expect(container.textContent).toContain("$1,000");
    expect(container.textContent).toContain("$10,000");
    expect(container.textContent).toContain("$50,000");
  });

  it("clicking a preset chip fills the threshold input", async () => {
    const { getByText, getByLabelText, findByText } = render(<Proofs />);
    await findByText("$50,000");
    fireEvent.click(getByText("$50,000"));
    const input = getByLabelText("Income threshold in USD") as HTMLInputElement;
    expect(input.value).toBe("50000");
  });
});

describe("Proofs — create proof dispatch (§15.x)", () => {
  it("'Create proof' disabled when input empty", async () => {
    const { findByLabelText } = render(<Proofs />);
    const btn = await findByLabelText("Create proof") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("dispatches createIncomeProof when kind='income'", async () => {
    const { getByText, getByLabelText, findByLabelText } = render(<Proofs />);
    await findByLabelText("Income threshold in USD");
    fireEvent.change(getByLabelText("Income threshold in USD"), { target: { value: "1000" } });
    await act(async () => {
      fireEvent.click(getByText("Create proof"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createIncomeProofMock).toHaveBeenCalledWith(1000);
    expect(createBalanceProofMock).not.toHaveBeenCalled();
  });

  it("dispatches createBalanceProof when kind='balance'", async () => {
    const { getByText, getByLabelText, findByText } = render(<Proofs />);
    await findByText("Balance");
    fireEvent.click(getByText("Balance"));
    fireEvent.change(getByLabelText("Income threshold in USD"), { target: { value: "5000" } });
    await act(async () => {
      fireEvent.click(getByText("Create proof"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createBalanceProofMock).toHaveBeenCalledWith(5000);
    expect(createIncomeProofMock).not.toHaveBeenCalled();
  });

  it("submitting state shows 'Creating...' + disables create button", async () => {
    setHook({ step: "creating" });
    const { findByText, getByLabelText } = render(<Proofs />);
    await findByText("Creating...");
    const btn = getByLabelText("Create proof") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("input disabled while submitting", async () => {
    setHook({ step: "creating" });
    const { findByLabelText } = render(<Proofs />);
    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("after successful create: reset() called + threshold cleared", async () => {
    createIncomeProofMock.mockResolvedValueOnce(7n);
    const { getByText, findByLabelText } = render(<Proofs />);
    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    await act(async () => {
      fireEvent.click(getByText("Create proof"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resetMock).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("if create returns null (failure), threshold input NOT cleared (user can retry)", async () => {
    createIncomeProofMock.mockResolvedValueOnce(null);
    const { getByText, findByLabelText } = render(<Proofs />);
    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    await act(async () => {
      fireEvent.click(getByText("Create proof"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe("1000");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("error state renders the error message inline", async () => {
    setHook({ step: "error", error: "Proof creation failed" });
    const { findByText } = render(<Proofs />);
    expect(await findByText("Proof creation failed")).toBeDefined();
  });
});

describe("Proofs — list rendering 3-state row (§15.x)", () => {
  it("pending state: status copy 'Pending verification' visible", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: false }) },
    });
    const { findByText } = render(<Proofs />);
    expect(await findByText(/Pending verification/)).toBeDefined();
  });

  it("verified-true state: status copy 'Verified true' visible", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: true, isTrue: true }) },
    });
    const { findByText } = render(<Proofs />);
    expect(await findByText(/Verified true/)).toBeDefined();
  });

  it("verified-false state: status copy 'Verified false' visible", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: true, isTrue: false }) },
    });
    const { findByText } = render(<Proofs />);
    expect(await findByText(/Verified false/)).toBeDefined();
  });

  it("threshold rendered with USDC 6-dp -> USD conversion (locale-agnostic)", async () => {
    setHook({
      proofsToReturn: [1n],
      // $123,456 -> threshold = 123_456_000_000 (6dp). Renders as
      // "$123,456" in en-US and "$1,23,456" in jsdom's en-IN default
      // on this Windows env. Pin the conversion math, not the grouping.
      proofMap: { "1": buildProof({ threshold: 123_456_000_000n }) },
    });
    const { container } = render(<Proofs />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Income ≥ \$(123,456|1,23,456)/);
    });
  });

  it("proof ID rendered as 'Proof #<id>'", async () => {
    setHook({
      proofsToReturn: [42n],
      proofMap: { "42": buildProof() },
    });
    const { findByText } = render(<Proofs />);
    expect(await findByText(/Proof #42/)).toBeDefined();
  });

  it("renders Share on X + Copy link + Explorer buttons per row", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof() },
    });
    const { findByLabelText } = render(<Proofs />);
    expect(await findByLabelText("Share on X / Twitter")).toBeDefined();
    expect(await findByLabelText("Copy verification link")).toBeDefined();
    expect(await findByLabelText("View on explorer")).toBeDefined();
  });

  it("Explorer link href = activeChain.explorerUrl/block/<blockNumber> + tabnabbing guard", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ blockNumber: 9999n }) },
    });
    const { findByLabelText } = render(<Proofs />);
    const link = (await findByLabelText("View on explorer")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://sepolia.etherscan.io/block/9999");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders nothing for proofIds whose record is missing (defensive)", async () => {
    setHook({
      proofsToReturn: [1n, 2n],
      proofMap: { "1": buildProof() }, // 2 is missing
    });
    const { container, findByText } = render(<Proofs />);
    await findByText(/Proof #1/);
    expect(container.textContent).not.toContain("Proof #2");
  });
});

describe("Proofs — share link + tweet intent (§15.x)", () => {
  it("Copy link writes /v/<id>?chain=<chainId> URL (crawler-friendly form) + 'Verification link copied' toast", async () => {
    // Share URL routes through /v/:id → /api/share/proof so Twitter /
    // Slack / Discord can read per-proof meta tags. Real browsers
    // bounce to /verify/:id via the JS redirect in the share endpoint.
    // Linking directly to /verify/:id would unfurl as the generic site
    // card because the SPA shell has no per-proof meta tags.
    setHook({
      proofsToReturn: [7n],
      proofMap: { "7": buildProof() },
    });
    const { findByLabelText } = render(<Proofs />);
    const btn = await findByLabelText("Copy verification link");
    fireEvent.click(btn);
    expect(writeTextMock).toHaveBeenCalled();
    const url = writeTextMock.mock.calls[0][0];
    expect(url).toContain("/v/7");
    expect(url).not.toContain("/verify/7");
    expect(url).toContain("chain=11155111");
    expect(toastSuccessMock).toHaveBeenCalledWith("Verification link copied");
  });

  it("Tweet intent for !isReady proof contains 'just created' framing + threshold", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: false, threshold: 50_000_000_000n }) },
    });
    const { findByLabelText } = render(<Proofs />);
    const link = (await findByLabelText("Share on X / Twitter")) as HTMLAnchorElement;
    const href = link.getAttribute("href")!;
    expect(href).toContain("https://twitter.com/intent/tweet?text=");
    const text = decodeURIComponent(href.split("text=")[1]);
    expect(text).toContain("just created an encrypted proof");
    expect(text).toContain("$50,000");
  });

  it("Tweet intent for true proof contains 'Verified on-chain' + 'inside FHE' framing", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: true, isTrue: true, threshold: 50_000_000_000n }) },
    });
    const { findByLabelText } = render(<Proofs />);
    const link = (await findByLabelText("Share on X / Twitter")) as HTMLAnchorElement;
    const text = decodeURIComponent(link.getAttribute("href")!.split("text=")[1]);
    expect(text).toContain("Verified on-chain");
    expect(text).toContain("inside FHE");
  });

  it("Tweet intent for FALSE proof contains 'FALSE' + 'just the boolean answer' framing", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: true, isTrue: false, threshold: 50_000_000_000n }) },
    });
    const { findByLabelText } = render(<Proofs />);
    const link = (await findByLabelText("Share on X / Twitter")) as HTMLAnchorElement;
    const text = decodeURIComponent(link.getAttribute("href")!.split("text=")[1]);
    expect(text).toContain("FALSE");
    expect(text).toContain("just the boolean answer");
  });

  it("Tweet link has tabnabbing guard", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof() },
    });
    const { findByLabelText } = render(<Proofs />);
    const link = (await findByLabelText("Share on X / Twitter")) as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("Proofs — empty + no-address states (§15.x)", () => {
  it("no address: 'Connect your wallet to see your proofs.' message", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container, findByText } = render(<Proofs />);
    await findByText("Connect your wallet to see your proofs.");
    expect(container.textContent).toContain("Connect your wallet to see your proofs.");
  });

  it("address + no proofs + not loading: 'No proofs yet' empty state", async () => {
    setHook({ proofsToReturn: [], proofMap: {} });
    const { findByText } = render(<Proofs />);
    expect(await findByText("No proofs yet")).toBeDefined();
  });
});

describe("Proofs — auto-poll (§15.x)", () => {
  it("CRITICAL: any !isReady proof triggers a setInterval(10s) refresh", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: false }) },
    });
    vi.useFakeTimers();
    render(<Proofs />);
    // Let initial mount refresh resolve first.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const initialCalls = fetchProofsByUserMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchProofsByUserMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("all-ready proofs: no auto-poll (refresh NOT re-fired after 10s)", async () => {
    setHook({
      proofsToReturn: [1n],
      proofMap: { "1": buildProof({ isReady: true, isTrue: true }) },
    });
    vi.useFakeTimers();
    render(<Proofs />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const initialCalls = fetchProofsByUserMock.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetchProofsByUserMock.mock.calls.length).toBe(initialCalls);
  });

  it("manual Refresh button calls fetchProofsByUser", async () => {
    setHook({ proofsToReturn: [], proofMap: {} });
    const { findByText } = render(<Proofs />);
    await waitFor(() => expect(fetchProofsByUserMock).toHaveBeenCalled());
    const before = fetchProofsByUserMock.mock.calls.length;
    const btn = await findByText("Refresh");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchProofsByUserMock.mock.calls.length).toBeGreaterThan(before);
  });
});

// ─── Auto-publish toggle (§15.x viral artifact) ───────────────────
//
// Pins:
//   - Toggle defaults ON so a fresh share link unfurls as
//     "Verified" instead of "Pending" without a second user action
//   - Toggling OFF skips publishProof entirely (prover-defers-cost
//     mode)
//   - Toggle is disabled while a create is in flight (no race
//     between submitting=true and a mid-flow toggle change)
//   - The chained publishProof is called with the proof id returned
//     from createIncomeProof — pins the dependency arrow so a
//     regression that called publishProof(undefined) wouldn't slip
//   - When create returns null (user rejected, etc.), publishProof
//     is NOT called

describe("Proofs — auto-publish toggle (§15.x viral artifact)", () => {
  it("toggle renders ON by default with the cost-explainer copy", async () => {
    setHook();
    const { findByLabelText, container } = render(<Proofs />);
    const cb = (await findByLabelText("Auto-publish proof so the share link is verified immediately")) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(container.textContent).toContain("Publish immediately so the share link is verified");
    expect(container.textContent).toContain("0.0001 ETH");
  });

  it("auto-publish ON + create -> publishProof called with the returned proof id", async () => {
    createIncomeProofMock.mockResolvedValue(42n);
    setHook();
    const { findByLabelText, findByText } = render(<Proofs />);
    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    const btn = await findByText("Create proof");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createIncomeProofMock).toHaveBeenCalledWith(1000);
    expect(publishProofMock).toHaveBeenCalledTimes(1);
    expect(publishProofMock).toHaveBeenCalledWith(42n);
  });

  it("auto-publish OFF + create -> publishProof NOT called (recipient pays publish gas)", async () => {
    createIncomeProofMock.mockResolvedValue(42n);
    setHook();
    const { findByLabelText, findByText } = render(<Proofs />);
    const cb = (await findByLabelText("Auto-publish proof so the share link is verified immediately")) as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);

    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    const btn = await findByText("Create proof");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createIncomeProofMock).toHaveBeenCalledTimes(1);
    expect(publishProofMock).not.toHaveBeenCalled();
  });

  it("createIncomeProof returns null (user rejected) -> publishProof NOT called even with auto-publish ON", async () => {
    createIncomeProofMock.mockResolvedValue(null);
    setHook();
    const { findByLabelText, findByText } = render(<Proofs />);
    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    const btn = await findByText("Create proof");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createIncomeProofMock).toHaveBeenCalledTimes(1);
    // Gate must not fire publish on a failed create.
    expect(publishProofMock).not.toHaveBeenCalled();
  });

  it("toggle is disabled while submitting (no race with mid-flow toggle change)", async () => {
    setHook({ step: "creating" });
    const { findByLabelText } = render(<Proofs />);
    const cb = (await findByLabelText("Auto-publish proof so the share link is verified immediately")) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it("auto-publish ON + balance kind: publishProof still chains after createBalanceProof", async () => {
    createBalanceProofMock.mockResolvedValue(99n);
    setHook();
    const { findByLabelText, findByText, container } = render(<Proofs />);
    // Switch to balance kind.
    const balanceBtn = container.querySelectorAll("button");
    // Find balance button by visible text.
    const balanceToggle = Array.from(balanceBtn).find((b) => b.textContent === "Balance");
    if (balanceToggle) fireEvent.click(balanceToggle);

    const input = await findByLabelText("Income threshold in USD") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    const btn = await findByText("Create proof");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createBalanceProofMock).toHaveBeenCalledWith(1000);
    expect(publishProofMock).toHaveBeenCalledWith(99n);
  });
});
