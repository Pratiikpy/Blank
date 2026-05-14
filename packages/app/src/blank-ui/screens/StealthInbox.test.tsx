import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for StealthInbox screen. Phase 9.4: ERC-5564 stealth
// payment list (recipient-side complement to SendConfirm's sender
// toggle). Pins:
//   - 4 UX states from the hook: !hasKeys (CTA) / scanning
//     (progress with current/to blocks) / 0 entries (empty state) /
//     entries list
//   - audit Top-28 #11: USDC-vs-non-USDC decimals branch driven by
//     `contracts.TestUSDC` from useChain() so a reload-free chain
//     switch keeps the comparison correct (regression: a hardcoded
//     0x... USDC address would silently format wrong-decimal once
//     the user switched chains)
//   - sort by blockNumber DESCENDING (newest first)
//   - sweep flow 5-step label matrix: funding / waitingFund /
//     sweeping / waitingSweep / default. Wrong label during a long
//     RPC wait is a UX trust regression (user thinks the sweep
//     stalled when it's actually mid-flight)
//   - swept entries: opacity-60 + "Swept" pill + Sweep button HIDDEN
//   - sweep success/failure toast contract
//   - ERC-20 detection via functionSelector === 0xa9059cbb
//     (lowercased comparison)

const useNavigateMock = vi.hoisted(() => vi.fn());
const useStealthInboxMock = vi.hoisted(() => vi.fn());
const useStealthSweepMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useNavigate: () => useNavigateMock }));
vi.mock("@/hooks/useStealthInbox", () => ({ useStealthInbox: useStealthInboxMock }));
vi.mock("@/hooks/useStealthSweep", () => ({ useStealthSweep: useStealthSweepMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn() } }));

import StealthInbox from "./StealthInbox";

const SENDER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const STEALTH = "0xstealthstealthstealthstealthstealthstea";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const OTHER_TOKEN = "0xffffffffffffffffffffffffffffffffffffffff";
const ERC20_SEL = "0xa9059cbb";

type Entry = {
  txHash: string;
  stealthAddress: string;
  sender: string;
  token: string;
  amount: string;
  blockNumber: string;
  functionSelector: string;
  swept: boolean;
};

function entry(over: Partial<Entry> = {}): Entry {
  return {
    txHash: "0xtx1",
    stealthAddress: STEALTH,
    sender: SENDER,
    token: USDC,
    amount: "1000000", // 1 USDC at 6dp
    blockNumber: "100",
    functionSelector: ERC20_SEL,
    swept: false,
    ...over,
  };
}

let sweepMock: ReturnType<typeof vi.fn>;
let scanMock: ReturnType<typeof vi.fn>;

function setInbox(overrides: Partial<{
  entries: Entry[];
  isScanning: boolean;
  scanProgress: { current: bigint; to: bigint } | null;
  hasKeys: boolean;
}> = {}) {
  useStealthInboxMock.mockReturnValue({
    entries: overrides.entries ?? [],
    isScanning: overrides.isScanning ?? false,
    scanProgress: overrides.scanProgress ?? null,
    hasKeys: overrides.hasKeys ?? true,
    scan: scanMock,
  });
}

function setSweeper(overrides: Partial<{
  step: "idle" | "funding" | "waitingFund" | "sweeping" | "waitingSweep";
  isSweeping: boolean;
}> = {}) {
  useStealthSweepMock.mockReturnValue({
    sweep: sweepMock,
    isSweeping: overrides.isSweeping ?? false,
    step: overrides.step ?? "idle",
  });
}

beforeEach(() => {
  useNavigateMock.mockReset();
  useStealthInboxMock.mockReset();
  useStealthSweepMock.mockReset();
  useChainMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  scanMock = vi.fn();
  sweepMock = vi.fn().mockResolvedValue({ ok: true });

  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { TestUSDC: USDC },
  });
  setInbox();
  setSweeper();
});

describe("StealthInbox — page chrome (§15.x)", () => {
  it("renders 'Stealth Inbox' heading + privacy framing copy", () => {
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("Stealth Inbox");
    expect(container.textContent).toContain("Auto-discovered payments addressed to your stealth meta-address");
    expect(container.textContent).toContain("can");
    expect(container.textContent).toContain("link these to your main wallet");
  });

  it("back button (aria-label='Go back') navigates(-1)", () => {
    const { getByLabelText } = render(<StealthInbox />);
    fireEvent.click(getByLabelText("Go back"));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });
});

describe("StealthInbox — !hasKeys state (§15.x)", () => {
  it("renders 'Set up your stealth meta-address' CTA when hasKeys=false", () => {
    setInbox({ hasKeys: false });
    const { container, getByText } = render(<StealthInbox />);
    expect(container.textContent).toContain("Set up your stealth meta-address");
    expect(getByText("Set up stealth meta-address")).toBeDefined();
  });

  it("CTA click navigates to /app/stealth/setup", () => {
    setInbox({ hasKeys: false });
    const { getByText } = render(<StealthInbox />);
    fireEvent.click(getByText("Set up stealth meta-address"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/stealth/setup");
  });

  it("!hasKeys: scan/rescan controls HIDDEN", () => {
    setInbox({ hasKeys: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).not.toContain("Rescan");
    expect(container.textContent).not.toContain("Scanning");
  });

  it("!hasKeys: explainer mentions spending+viewing key pair + on-chain registry", () => {
    setInbox({ hasKeys: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("spending and viewing key pair");
    expect(container.textContent).toContain("on-chain registry");
  });
});

describe("StealthInbox — scanning state (§15.x)", () => {
  it("isScanning + scanProgress renders 'Scanning blocks X / Y…' status", () => {
    setInbox({
      hasKeys: true,
      isScanning: true,
      scanProgress: { current: 1000n, to: 2000n },
    });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("Scanning blocks 1000 / 2000");
  });

  it("Rescan button reads 'Scanning' + disabled while isScanning", () => {
    setInbox({ hasKeys: true, isScanning: true, scanProgress: { current: 1n, to: 2n } });
    const { container } = render(<StealthInbox />);
    const buttons = Array.from(container.querySelectorAll("button"));
    const rescan = buttons.find((b) => b.textContent?.includes("Scanning") && !b.textContent?.includes("Scanning blocks")) as HTMLButtonElement;
    expect(rescan).toBeDefined();
    expect(rescan.disabled).toBe(true);
  });

  it("Rescan button click invokes scan() when NOT scanning", () => {
    setInbox({ hasKeys: true, isScanning: false });
    const { getByText } = render(<StealthInbox />);
    fireEvent.click(getByText("Rescan"));
    expect(scanMock).toHaveBeenCalled();
  });
});

describe("StealthInbox — no-entries empty state (§15.x)", () => {
  it("'No stealth payments yet' empty state when hasKeys + 0 entries + !scanning", () => {
    setInbox({ hasKeys: true, entries: [], isScanning: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("No stealth payments yet");
  });

  it("empty state copy explains the discovery contract: senders derive one-time addresses", () => {
    setInbox({ hasKeys: true, entries: [], isScanning: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("derive a one-time address that nobody can link back");
    expect(container.textContent).toContain("Payments will appear here automatically");
  });

  it("empty state HIDDEN during scanning (don't show 'no payments' before scan completes)", () => {
    setInbox({ hasKeys: true, entries: [], isScanning: true, scanProgress: { current: 1n, to: 100n } });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).not.toContain("No stealth payments yet");
  });

  it("entry-count line reads '0 stealth payments on chain <id>' when idle", () => {
    setInbox({ hasKeys: true, entries: [], isScanning: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("0 stealth payments on chain 11155111");
  });

  it("entry-count line uses singular 'payment' for 1 entry", () => {
    setInbox({ hasKeys: true, entries: [entry()], isScanning: false });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("1 stealth payment on chain");
    expect(container.textContent).not.toContain("1 stealth payments");
  });

  it("entry-count line uses plural 'payments' for >1 entries", () => {
    setInbox({
      hasKeys: true,
      entries: [entry({ txHash: "0x1" }), entry({ txHash: "0x2" })],
      isScanning: false,
    });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("2 stealth payments on chain");
  });
});

describe("StealthInbox — amount formatting (audit Top-28 #11) (§15.x)", () => {
  it("CRITICAL: USDC token (matches contracts.TestUSDC) formats at 6 decimals", () => {
    setInbox({ entries: [entry({ token: USDC, amount: "1000000" })] }); // 1 USDC at 6dp
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("1");
    expect(container.textContent).not.toContain("0.000000000001"); // 18dp would show this
  });

  it("CRITICAL: USDC compare is case-INsensitive (token may arrive checksummed)", () => {
    setInbox({ entries: [entry({ token: USDC.toUpperCase(), amount: "5000000" })] });
    const { container } = render(<StealthInbox />);
    // 5_000_000 at 6dp = 5. The amount span renders "5 " directly
    // adjacent to the "From: ..." address row text, so check the
    // pair substring rather than a word-boundary regex (which fails
    // because container.textContent concatenates "Rescan5 From"
    // across DOM elements, killing the leading \b).
    expect(container.textContent).toContain("5 From:");
  });

  it("non-USDC token defaults to 18 decimals (ETH-like)", () => {
    setInbox({
      entries: [entry({ token: OTHER_TOKEN, amount: "1000000000000000000" })], // 1 ETH at 18dp
    });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toMatch(/\b1\b/);
  });

  it("malformed amount string gracefully falls back to raw value (try/catch)", () => {
    setInbox({ entries: [entry({ amount: "not-a-bigint" })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("not-a-bigint");
  });

  it("undefined TestUSDC contract (e.g. mid-chain-switch) falls through to 18dp branch (defensive)", () => {
    useChainMock.mockReturnValue({ activeChainId: 11155111, contracts: { TestUSDC: undefined } });
    setInbox({ entries: [entry({ token: USDC, amount: "1000000000000000000" })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toMatch(/\b1\b/);
  });
});

describe("StealthInbox — entry sort (§15.x)", () => {
  it("entries sorted by blockNumber DESCENDING (newest first)", () => {
    setInbox({
      entries: [
        entry({ txHash: "0xold", blockNumber: "100", sender: "0x" + "1".repeat(40) }),
        entry({ txHash: "0xnew", blockNumber: "500", sender: "0x" + "2".repeat(40) }),
        entry({ txHash: "0xmid", blockNumber: "300", sender: "0x" + "3".repeat(40) }),
      ],
    });
    const { container } = render(<StealthInbox />);
    const text = container.textContent ?? "";
    // The block numbers appear in row content like "Block: #500".
    const newIdx = text.indexOf("#500");
    const midIdx = text.indexOf("#300");
    const oldIdx = text.indexOf("#100");
    expect(newIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(newIdx);
    expect(oldIdx).toBeGreaterThan(midIdx);
  });
});

describe("StealthInbox — entry rendering (§15.x)", () => {
  it("shows truncated sender + stealth + token addresses + block number", () => {
    setInbox({ entries: [entry()] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toMatch(/From: 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/);
    expect(container.textContent).toMatch(/Stealth address: 0x[a-zA-Z0-9]{4}\.\.\.[a-zA-Z0-9]{4}/);
    expect(container.textContent).toMatch(/Token: 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/);
    expect(container.textContent).toContain("Block: #100");
  });

  it("swept entry: 'Swept' pill visible + Sweep button HIDDEN + opacity-60 class", () => {
    setInbox({ entries: [entry({ swept: true })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("Swept");
    expect(container.textContent).not.toContain("Sweep to my wallet");
    // Row carries opacity-60.
    expect(container.innerHTML).toContain("opacity-60");
  });

  it("non-swept entry: 'Sweep to my wallet' button visible", () => {
    setInbox({ entries: [entry({ swept: false })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("Sweep to my wallet");
  });

  it("ERC-20 (functionSelector === 0xa9059cbb) shows amount WITHOUT '(token)' suffix", () => {
    setInbox({ entries: [entry({ functionSelector: ERC20_SEL })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).not.toContain("(token)");
  });

  it("non-ERC-20 (different selector) shows amount WITH '(token)' suffix", () => {
    setInbox({ entries: [entry({ functionSelector: "0xabcdef00" })] });
    const { container } = render(<StealthInbox />);
    expect(container.textContent).toContain("(token)");
  });
});

describe("StealthInbox — sweep flow (§15.x)", () => {
  it("clicking Sweep calls sweeper.sweep(entry) with the matched row", async () => {
    const e = entry({ txHash: "0xtarget" });
    setInbox({ entries: [e] });
    const { getByText } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
    });
    expect(sweepMock).toHaveBeenCalledWith(e);
  });

  it("sweep success → toast.success with amount + unit framing", async () => {
    setInbox({ entries: [entry({ amount: "1000000" })] });
    const { getByText } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalled();
    const msg = (toastSuccessMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("Swept");
    expect(msg).toContain("your wallet");
  });

  it("sweep rejection → toast.error 'Sweep failed: <msg>' (NOT silent)", async () => {
    sweepMock.mockRejectedValueOnce(new Error("RPC reverted"));
    setInbox({ entries: [entry()] });
    const { getByText } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("Sweep failed");
    expect(msg).toContain("RPC reverted");
  });

  it("non-Error rejection coerced via String() into the error toast", async () => {
    sweepMock.mockRejectedValueOnce("rejection string");
    setInbox({ entries: [entry()] });
    const { getByText } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    const msg = (toastErrorMock.mock.calls[0][0] as string) ?? "";
    expect(msg).toContain("rejection string");
  });

  it("CRITICAL sweep step labels: 'Funding stealth address…' during step='funding'", async () => {
    let resolveSweep!: (v: unknown) => void;
    sweepMock.mockReturnValue(new Promise((res) => { resolveSweep = res; }));
    // isSweeping=false so the button is clickable; the LABEL test
    // exercises sweeper.step independently of the isSweeping gate.
    setSweeper({ step: "funding", isSweeping: false });
    setInbox({ entries: [entry()] });
    const { getByText, container } = render(<StealthInbox />);

    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Funding stealth address");

    await act(async () => {
      resolveSweep({ ok: true });
      await Promise.resolve();
    });
  });

  it("step='waitingFund' label: 'Waiting for funding to confirm…'", async () => {
    let resolveSweep!: (v: unknown) => void;
    sweepMock.mockReturnValue(new Promise((res) => { resolveSweep = res; }));
    setSweeper({ step: "waitingFund", isSweeping: false });
    setInbox({ entries: [entry()] });
    const { getByText, container } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Waiting for funding to confirm");
    await act(async () => { resolveSweep({}); await Promise.resolve(); });
  });

  it("step='sweeping' label: 'Sweeping…'", async () => {
    let resolveSweep!: (v: unknown) => void;
    sweepMock.mockReturnValue(new Promise((res) => { resolveSweep = res; }));
    setSweeper({ step: "sweeping", isSweeping: false });
    setInbox({ entries: [entry()] });
    const { getByText, container } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
    });
    await waitFor(() => expect(container.textContent).toContain("Sweeping"));
    await act(async () => { resolveSweep({}); await Promise.resolve(); });
  });

  it("step='waitingSweep' label: 'Waiting for sweep to confirm…'", async () => {
    let resolveSweep!: (v: unknown) => void;
    sweepMock.mockReturnValue(new Promise((res) => { resolveSweep = res; }));
    setSweeper({ step: "waitingSweep", isSweeping: false });
    setInbox({ entries: [entry()] });
    const { getByText, container } = render(<StealthInbox />);
    await act(async () => {
      fireEvent.click(getByText("Sweep to my wallet"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Waiting for sweep to confirm");
    await act(async () => { resolveSweep({}); await Promise.resolve(); });
  });

  it("Sweep button disabled when sweeper.isSweeping (multi-row guard: only ONE sweep at a time)", () => {
    setInbox({ entries: [entry({ txHash: "0xrow1" }), entry({ txHash: "0xrow2" })] });
    setSweeper({ isSweeping: true, step: "sweeping" });
    const { container } = render(<StealthInbox />);
    // Find all "Sweep to my wallet" buttons -- all should be disabled.
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("Sweep to my wallet"),
    ) as HTMLButtonElement[];
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
    }
  });
});
