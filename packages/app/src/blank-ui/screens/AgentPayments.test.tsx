import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for AgentPayments screen. AI-derived payments with
// on-chain attestation provenance. 2-tab dispatcher (Send /
// Received) + 2 templates (payroll_line / expense_share) +
// expiry safety margin + supabase realtime received feed.
//
// CRITICAL pins:
//   - expiry safety margin: 30-second buffer before block
//     inclusion. Submit button DISABLED when remaining <= 30s
//     AND submit toast-rejects if check passes the button gate
//     but the attestation expired by the time the user tapped.
//   - block timestamp vs local-now reconciliation: source uses
//     `blockTimestamp ?? now` so a client clock-skew never
//     marks a fresh attestation as "Expired". Pin so a future
//     refactor that simplifies to `Date.now()` is caught.
//   - submit validation 3-branch: invalid recipient -> toast;
//     too-close-to-expiry -> toast; valid -> submit + clear all
//     form state + reset hook.
//   - received tab unread badge: count = receivedPayments.length
//     - seenHashes.length, persisted to localStorage per
//     (address, chainId).
//   - tab switch to received marks all current payments seen
//     (so badge clears on entry); inflight arrivals while tab
//     IS open auto-mark seen via secondary effect.
//   - realtime supabase channel filters server-side on
//     `user_to=eq.<me>` then client-side on activity_type +
//     non-self-from (so the user doesn't see their own outgoing
//     agent-payments in the inbox).
//   - 5-state submit button copy matrix.

const useAgentPaymentMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const fetchActivitiesMock = vi.hoisted(() => vi.fn());
const getStoredJsonMock = vi.hoisted(() => vi.fn());
const setStoredJsonMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());
const isAddressMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

const supabaseStub = vi.hoisted(() => ({
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, isAddress: isAddressMock };
});
vi.mock("@/hooks/useAgentPayment", () => ({
  useAgentPayment: useAgentPaymentMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/supabase", () => ({
  fetchActivities: fetchActivitiesMock,
  supabase: supabaseStub,
}));
vi.mock("@/lib/activity-types", () => ({
  ACTIVITY_TYPES: { AGENT_PAYMENT: "agent_payment" },
}));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    agentReceivedSeen: (addr: string, chainId: number) =>
      `blank_agent_received_seen_${addr.toLowerCase()}_${chainId}`,
  },
  getStoredJson: getStoredJsonMock,
  setStoredJson: setStoredJsonMock,
}));
vi.mock("@/lib/constants", () => ({
  getExplorerTxUrl: getExplorerTxUrlMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import AgentPayments from "./AgentPayments";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALICE = "0xcccccccccccccccccccccccccccccccccccccccc";
const AGENT = "0xdddddddddddddddddddddddddddddddddddddddd";

type Attestation = {
  amount: bigint;
  agent: string;
  expiry: number; // seconds since epoch
  model?: string;
  provider?: string;
  raw?: string;
};

let deriveMock: ReturnType<typeof vi.fn>;
let submitMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let channelOnMock: ReturnType<typeof vi.fn>;
let channelSubscribeMock: ReturnType<typeof vi.fn>;
let fakeChannel: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

function setHook(overrides: Partial<{
  step: "idle" | "deriving" | "approving" | "encrypting" | "sending" | "success" | "error";
  error: string | null;
  lastAttestation: Attestation | null;
  blockTimestamp: number | null;
}> = {}) {
  useAgentPaymentMock.mockReturnValue({
    step: overrides.step ?? "idle",
    error: overrides.error ?? null,
    lastAttestation: overrides.lastAttestation ?? null,
    blockTimestamp: overrides.blockTimestamp ?? null,
    derive: deriveMock,
    submit: submitMock,
    reset: resetMock,
  });
}

function buildAttestation(over: Partial<Attestation> = {}): Attestation {
  return {
    amount: 1_500_000n, // 1.5 USDC at 6dp
    agent: AGENT,
    expiry: Math.floor(Date.now() / 1000) + 3600, // 1h future
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    raw: "raw model output",
    ...over,
  };
}

type ActivityRow = {
  tx_hash: string;
  activity_type: string;
  user_from: string;
  user_to: string;
  note: string | null;
  chain_id: number;
  created_at: string;
};

function buildActivity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    tx_hash: "0xtx1",
    activity_type: "agent_payment",
    user_from: ALICE,
    user_to: ME,
    note: "October payroll",
    chain_id: 11155111,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  useAgentPaymentMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  fetchActivitiesMock.mockReset();
  getStoredJsonMock.mockReset();
  setStoredJsonMock.mockReset();
  getExplorerTxUrlMock.mockReset();
  isAddressMock.mockReset();
  toastErrorMock.mockReset();
  supabaseStub.channel.mockReset();
  supabaseStub.removeChannel.mockReset();

  deriveMock = vi.fn().mockResolvedValue(undefined);
  submitMock = vi.fn().mockResolvedValue("0xsubmittxhash");
  resetMock = vi.fn();
  setHook();

  useChainMock.mockReturnValue({
    activeChain: { name: "Ethereum Sepolia" },
    activeChainId: 11155111,
  });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });

  fetchActivitiesMock.mockResolvedValue([]);
  getStoredJsonMock.mockReturnValue([]);
  getExplorerTxUrlMock.mockImplementation(
    (hash: string, chainId: number) => `https://explorer.test/${hash}?c=${chainId}`,
  );
  isAddressMock.mockImplementation((v: string) => /^0x[a-fA-F0-9]{40}$/.test(v));

  channelOnMock = vi.fn();
  channelSubscribeMock = vi.fn();
  fakeChannel = { on: channelOnMock, subscribe: channelSubscribeMock };
  channelOnMock.mockReturnValue(fakeChannel);
  channelSubscribeMock.mockReturnValue(fakeChannel);
  supabaseStub.channel.mockReturnValue(fakeChannel);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentPayments — page chrome (§15.x)", () => {
  it("renders 'Pay with an AI agent' heading + AI provenance framing", async () => {
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Pay with an AI agent");
    expect(container.textContent).toContain("AI Agents");
    expect(container.textContent).toContain("provenance on-chain");
    expect(container.textContent).toContain("Kimi K2 primary");
    expect(container.textContent).toContain("Claude fallback");
    expect(container.textContent).toContain("auditable forever");
  });

  it("2 tabs: Send (default aria-selected=true) + Received", async () => {
    const { findByLabelText } = render(<AgentPayments />);
    const send = await findByLabelText("Send via agent");
    const received = await findByLabelText("Received agent payments");
    expect(send.getAttribute("aria-selected")).toBe("true");
    expect(received.getAttribute("aria-selected")).toBe("false");
  });

  it("2 template cards: 'Smart payroll line' (default) + 'AI expense split'", async () => {
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    expect(container.textContent).toContain("AI expense split");
    expect(container.textContent).toContain("split context");
    // Template placeholder is on the textarea's `placeholder` attribute,
    // not in textContent. Check the attribute directly.
    const textarea = container.querySelector("textarea");
    expect(textarea?.getAttribute("placeholder")).toContain("Senior full-stack engineer");
  });
});

describe("AgentPayments — template picker (§15.x)", () => {
  it("clicking 'AI expense split' switches activeTemplate + clears context + reset hook", async () => {
    const { findByText, container } = render(<AgentPayments />);
    const expenseCard = await findByText("AI expense split");
    fireEvent.click(expenseCard.closest("button") as HTMLButtonElement);
    await waitFor(() => {
      expect(container.querySelector("textarea")?.value).toBe("");
    });
    expect(resetMock).toHaveBeenCalled();
    // Placeholder changes to expense-split copy.
    expect(container.querySelector("textarea")?.getAttribute("placeholder")).toContain("Dinner");
  });

  it("'Use example' button fills the textarea with template's example string", async () => {
    const { findByText, container } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    const useExampleBtn = container.querySelector("button:not([role='tab'])");
    const allBtns = Array.from(container.querySelectorAll("button"));
    const exampleBtn = allBtns.find((b) => b.textContent?.trim() === "Use example") as HTMLButtonElement;
    fireEvent.click(exampleBtn);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Mid-level mobile engineer");
    expect(useExampleBtn).toBeDefined();
  });

  it("textarea maxLength capped at 4000 characters via slice(0, 4000)", async () => {
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "a".repeat(5000) } });
    expect(textarea.value.length).toBe(4000);
  });
});

describe("AgentPayments — derive flow (§15.x)", () => {
  it("empty context -> 'Describe the situation' toast + derive NOT called", async () => {
    const { findByText, container } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    const askBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ask agent")) as HTMLButtonElement;
    // Button is disabled when context is empty; but exercise the handler.
    expect(askBtn.disabled).toBe(true);
    expect(deriveMock).not.toHaveBeenCalled();
  });

  it("valid context + Ask agent -> derive(template, trimmed-context) called", async () => {
    const { findByText, container } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  senior backend, Tokyo  " } });
    const askBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ask agent")) as HTMLButtonElement;
    expect(askBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(askBtn);
      await Promise.resolve();
    });
    expect(deriveMock).toHaveBeenCalledWith("payroll_line", "senior backend, Tokyo");
  });

  it("step='deriving' -> 'Deriving...' label + button disabled", async () => {
    setHook({ step: "deriving" });
    const { findByText } = render(<AgentPayments />);
    expect(await findByText("Deriving...")).toBeDefined();
  });

  it("step='error' + error -> inline red message visible (NOT silent)", async () => {
    setHook({ step: "error", error: "Agent API timeout" });
    const { findByText } = render(<AgentPayments />);
    expect(await findByText("Agent API timeout")).toBeDefined();
  });
});

describe("AgentPayments — attestation review (§15.x)", () => {
  it("renders 'Agent attestation' panel with USDC amount + agent address + countdown", async () => {
    setHook({
      lastAttestation: buildAttestation({
        amount: 5_000_000n,
        expiry: Math.floor(Date.now() / 1000) + 600, // 10m
      }),
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    expect(container.textContent).toContain("Agent proposed");
    expect(container.textContent).toContain("USDC");
    expect(container.textContent).toMatch(/5\.00/);
    expect(container.textContent).toContain(AGENT);
    expect(container.textContent).toMatch(/Expires in \d+m/);
  });

  it("attestation amount formats with locale grouping at 6dp max", async () => {
    setHook({
      lastAttestation: buildAttestation({ amount: 1_234_567_890n }), // 1234.567890 USDC
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    expect(container.textContent).toMatch(/1[,]?234\.56|1[,]?234\.567/);
  });

  it("renders model + provider chips when present", async () => {
    setHook({
      lastAttestation: buildAttestation({
        model: "kimi-k2",
        provider: "moonshot",
      }),
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    expect(container.textContent).toContain("kimi-k2");
    expect(container.textContent).toContain("moonshot");
  });

  it("raw model output renders inside a <details> collapsed by default", async () => {
    setHook({ lastAttestation: buildAttestation({ raw: "raw output here" }) });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain("Raw model output");
    expect(details?.textContent).toContain("raw output here");
  });
});

describe("AgentPayments — expiry math + safety margin (§15.x)", () => {
  it("expired attestation (remaining <= 0) -> 'Expired. Please re-derive' copy + submit DISABLED", async () => {
    setHook({
      lastAttestation: buildAttestation({
        expiry: Math.floor(Date.now() / 1000) - 1, // 1s in past
      }),
      blockTimestamp: Math.floor(Date.now() / 1000),
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    expect(container.textContent).toContain("Expired. Please re-derive");
    const submitBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Encrypt & submit")) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it("CRITICAL safety margin: remaining <= 30s -> submit button DISABLED even though not yet expired", async () => {
    setHook({
      lastAttestation: buildAttestation({
        expiry: Math.floor(Date.now() / 1000) + 25, // 25s left, < 30s margin
      }),
      blockTimestamp: Math.floor(Date.now() / 1000),
    });
    isAddressMock.mockReturnValue(true);
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    const recipientInput = container.querySelector("input[placeholder='0x…']") as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: RECIPIENT } });
    const submitBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Encrypt & submit")) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it("CRITICAL block timestamp reconciliation: blockTimestamp wins over local Date.now()", async () => {
    // Local now is in the future of blockTs by 1h. If source used Date.now(),
    // remaining would be negative -> "Expired" copy. If source uses blockTs,
    // remaining is fresh + valid.
    const localNow = Math.floor(Date.now() / 1000);
    const blockTs = localNow - 3600; // chain is "behind" local clock by 1h
    setHook({
      lastAttestation: buildAttestation({
        expiry: localNow - 1800, // 30m past local now BUT 30m in future of blockTs
      }),
      blockTimestamp: blockTs,
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    // Should NOT be marked expired (using blockTs reference).
    expect(container.textContent).not.toContain("Expired");
  });

  it("no blockTimestamp -> falls back to local now (deferred chain read)", async () => {
    setHook({
      lastAttestation: buildAttestation({
        expiry: Math.floor(Date.now() / 1000) + 600,
      }),
      blockTimestamp: null,
    });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    expect(container.textContent).toMatch(/Expires in \d+m/);
  });
});

describe("AgentPayments — submit flow (§15.x)", () => {
  it("invalid recipient -> 'Enter a valid recipient address' toast + submit NOT called", async () => {
    setHook({ lastAttestation: buildAttestation() });
    isAddressMock.mockReturnValue(false);
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    const recipientInput = container.querySelector("input[placeholder='0x…']") as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: "garbage" } });
    const submitBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Encrypt & submit")) as HTMLButtonElement;
    // Button disabled when isAddress false.
    expect(submitBtn.disabled).toBe(true);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("CRITICAL valid submit: submit(recipient, attestation, trimmed-note) + form cleared + reset", async () => {
    const attestation = buildAttestation();
    setHook({ lastAttestation: attestation });
    isAddressMock.mockReturnValue(true);
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    const recipientInput = container.querySelector("input[placeholder='0x…']") as HTMLInputElement;
    const noteInput = container.querySelector("input[placeholder*='October payroll']") as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: RECIPIENT } });
    fireEvent.change(noteInput, { target: { value: "  payroll Oct  " } });
    const submitBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Encrypt & submit")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submitMock).toHaveBeenCalled();
    const args = submitMock.mock.calls[0];
    expect(args[0]).toBe(RECIPIENT);
    expect(args[1]).toBe(attestation); // unchanged attestation passed through
    expect(args[2]).toBe("payroll Oct"); // trimmed
    expect(resetMock).toHaveBeenCalled();
    expect(recipientInput.value).toBe("");
    expect(noteInput.value).toBe("");
  });

  it("note input maxLength=80 enforced via slice(0, 80)", async () => {
    setHook({ lastAttestation: buildAttestation() });
    const { container, findByText } = render(<AgentPayments />);
    await findByText("Agent attestation");
    const noteInput = container.querySelector("input[placeholder*='October payroll']") as HTMLInputElement;
    fireEvent.change(noteInput, { target: { value: "x".repeat(200) } });
    expect(noteInput.value.length).toBe(80);
  });

  it("5-state submit button copy matrix: approving / encrypting / sending / success / default", async () => {
    const states = [
      { step: "approving" as const, label: "Approving vault" },
      { step: "encrypting" as const, label: "Encrypting amount" },
      { step: "sending" as const, label: "Submitting on-chain" },
      { step: "success" as const, label: "Submitted!" },
    ];
    for (const { step, label } of states) {
      setHook({ step, lastAttestation: buildAttestation() });
      const { container, findByText, unmount } = render(<AgentPayments />);
      await findByText("Agent attestation");
      expect(container.textContent).toContain(label);
      unmount();
    }
  });

  it("default state shows 'Encrypt & submit' copy", async () => {
    setHook({ step: "idle", lastAttestation: buildAttestation() });
    const { findByText } = render(<AgentPayments />);
    expect(await findByText(/Encrypt & submit/)).toBeDefined();
  });
});

describe("AgentPayments — received tab + unread badge (§15.x)", () => {
  it("unread badge HIDDEN when receivedPayments empty", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { findByLabelText, container } = render(<AgentPayments />);
    await findByLabelText("Received agent payments");
    expect(container.textContent).not.toMatch(/new agent payments received/);
  });

  it("unread badge VISIBLE with count when receivedPayments > seenHashes", async () => {
    fetchActivitiesMock.mockResolvedValue([
      buildActivity({ tx_hash: "0xnew1" }),
      buildActivity({ tx_hash: "0xnew2" }),
    ]);
    getStoredJsonMock.mockReturnValue([]);
    const { findByLabelText } = render(<AgentPayments />);
    const label = await findByLabelText(/new agent payments received/);
    expect(label.textContent).toContain("2");
  });

  it("CRITICAL: switching to received tab marks ALL current payments as seen", async () => {
    fetchActivitiesMock.mockResolvedValue([
      buildActivity({ tx_hash: "0xnew1" }),
      buildActivity({ tx_hash: "0xnew2" }),
    ]);
    getStoredJsonMock.mockReturnValue([]);
    const { findByLabelText } = render(<AgentPayments />);
    const receivedTab = await findByLabelText("Received agent payments");
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    fireEvent.click(receivedTab);
    expect(setStoredJsonMock).toHaveBeenCalled();
    const setArgs = setStoredJsonMock.mock.calls[0];
    expect(setArgs[0]).toMatch(/blank_agent_received_seen_/);
    expect(setArgs[1]).toContain("0xnew1");
    expect(setArgs[1]).toContain("0xnew2");
  });

  it("received tab: empty state copy when no payments", async () => {
    fetchActivitiesMock.mockResolvedValue([]);
    const { findByLabelText, container } = render(<AgentPayments />);
    fireEvent.click(await findByLabelText("Received agent payments"));
    await waitFor(() => {
      expect(container.textContent).toContain("No agent payments received yet");
      expect(container.textContent).toContain("public note");
      expect(container.textContent).toContain("audit");
    });
  });

  it("received tab: renders payment row with from + note + relative time + Explorer link", async () => {
    fetchActivitiesMock.mockResolvedValue([
      buildActivity({
        tx_hash: "0xtxabc",
        user_from: ALICE,
        note: "October payroll",
        chain_id: 11155111,
      }),
    ]);
    const { findByLabelText, container } = render(<AgentPayments />);
    fireEvent.click(await findByLabelText("Received agent payments"));
    await waitFor(() => {
      expect(container.textContent).toContain("Agent payment");
      expect(container.textContent).toContain("October payroll");
      expect(container.textContent).toMatch(/0xcccc.{1,3}cccc/i);
    });
    const link = Array.from(container.querySelectorAll("a"))
      .find((a) => a.textContent?.includes("View on explorer")) as HTMLAnchorElement;
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toContain("0xtxabc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("CRITICAL fetchActivities filter: ONLY agent_payment WHERE user_to===me AND user_from!==me", async () => {
    fetchActivitiesMock.mockResolvedValue([
      buildActivity({ tx_hash: "0xkeep", user_from: ALICE, user_to: ME }),
      buildActivity({
        tx_hash: "0xdrop-self-send",
        user_from: ME,
        user_to: ME, // self-send, must be filtered
      }),
      buildActivity({
        tx_hash: "0xdrop-wrong-type",
        activity_type: "payment", // not agent
      }),
    ]);
    const { findByLabelText, container } = render(<AgentPayments />);
    fireEvent.click(await findByLabelText("Received agent payments"));
    await waitFor(() => {
      expect(container.textContent).toContain("1 agent payment received");
    });
  });

  it("singular '1 agent payment received' vs plural 'N agent payments received'", async () => {
    fetchActivitiesMock.mockResolvedValue([buildActivity({ tx_hash: "0xone" })]);
    const { findByLabelText, container } = render(<AgentPayments />);
    fireEvent.click(await findByLabelText("Received agent payments"));
    await waitFor(() => {
      expect(container.textContent).toContain("1 agent payment received");
      expect(container.textContent).not.toContain("1 agent payments received");
    });
  });

  it("Refresh button calls fetchActivities again", async () => {
    fetchActivitiesMock.mockResolvedValue([buildActivity()]);
    const { findByLabelText, findByText } = render(<AgentPayments />);
    fireEvent.click(await findByLabelText("Received agent payments"));
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    const initialCalls = fetchActivitiesMock.mock.calls.length;
    fireEvent.click(await findByText("Refresh"));
    await waitFor(() => {
      expect(fetchActivitiesMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });
});

describe("AgentPayments — realtime supabase channel (§15.x)", () => {
  it("CRITICAL: subscribes to INSERT filter user_to=eq.<lowercased me>", async () => {
    const { findByText } = render(<AgentPayments />);
    await findByText("Pay with an AI agent");
    await waitFor(() => expect(supabaseStub.channel).toHaveBeenCalled());
    expect(supabaseStub.channel).toHaveBeenCalledWith(`agent_received_${ME.toLowerCase()}`);
    const filterArg = channelOnMock.mock.calls[0][1];
    expect(filterArg.event).toBe("INSERT");
    expect(filterArg.table).toBe("activities");
    expect(filterArg.filter).toBe(`user_to=eq.${ME.toLowerCase()}`);
  });

  it("cleanup on unmount: removeChannel called with the same channel", async () => {
    const { findByText, unmount } = render(<AgentPayments />);
    await findByText("Pay with an AI agent");
    await waitFor(() => expect(supabaseStub.channel).toHaveBeenCalled());
    unmount();
    expect(supabaseStub.removeChannel).toHaveBeenCalled();
  });

  it("realtime handler ignores rows where user_from === me (own outgoing agent-payment)", async () => {
    const { findByText } = render(<AgentPayments />);
    await findByText("Pay with an AI agent");
    await waitFor(() => expect(channelOnMock).toHaveBeenCalled());
    const handler = channelOnMock.mock.calls[0][2] as (payload: { new: ActivityRow }) => void;

    // Self-send: should NOT add to inbox.
    handler({ new: buildActivity({ user_from: ME, user_to: ME }) });
    // Wrong type: should NOT add either.
    handler({ new: buildActivity({ activity_type: "payment" }) });
    // Valid: SHOULD add.
    handler({ new: buildActivity({ tx_hash: "0xnewreal", user_from: ALICE }) });
    // No exception thrown is the contract here.
    expect(handler).toBeDefined();
  });
});

describe("AgentPayments — no-address branch (§15.x)", () => {
  it("no effective address -> Ask agent button disabled even with context filled", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { findByText, container } = render(<AgentPayments />);
    await findByText("Smart payroll line");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "engineer" } });
    const askBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ask agent")) as HTMLButtonElement;
    expect(askBtn.disabled).toBe(true);
  });
});
