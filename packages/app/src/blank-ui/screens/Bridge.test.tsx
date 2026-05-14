import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Bridge screen. CCTP V2 burn-and-mint USDC between
// Sepolia + Base Sepolia via the useBridgeUSDC two-phase state
// machine.
//
// CRITICAL pins:
//   - 9-state status label matrix: idle / approving / burning /
//     polling (with attestation sub-state) / readyToClaim /
//     switching / minting / complete / error. The wrong label
//     during a 15-minute Finalized wait reads as a stall to the
//     user; pinning the exact copy stops a refactor that swaps
//     "polling" copy with a generic spinner.
//   - active-chain mismatch warning: sourceChain !== activeChainId
//     -> visible amber banner BEFORE the user clicks Start, so
//     they don't burn USDC on the wrong network.
//   - canStart formula: idle AND amount > 0 AND <= balance AND
//     no parse error AND sourceChain === activeChainId. Single
//     pin proves all 5 conditions are checked together.
//   - amount regex /^\d*\.?\d{0,6}$/ matches USDC precision
//     (sixth independent enforcement after Receive/Requests/
//     SendAmount/Crowdfund/Storefront).
//   - resume banner: bridge.resumable + idle + !inProgress ->
//     visible. Discard click calls bridge.reset; Resume click
//     calls bridge.resume. Without the banner, a user who closed
//     the tab mid-bridge loses awareness of the in-flight burn.
//   - embedded prop suppresses the page header (mounted-as-tab
//     mode inside Exchange; avoids duplicate H1 a11y).
//   - CCTP-not-FHE disclosure: load-bearing privacy copy that
//     warns the user CCTP burns NATIVE USDC (visible on-chain
//     during bridge), NOT the FHE-vault wrapper.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useBridgeUSDCMock = vi.hoisted(() => vi.fn());
const useReadContractMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useReadContract: useReadContractMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useBridgeUSDC", () => ({ useBridgeUSDC: useBridgeUSDCMock }));
vi.mock("@/lib/cctp", () => ({
  CCTP_USDC: {
    11155111: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    84532: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  },
  CCTP_DOMAIN: { 11155111: 0, 84532: 6 },
}));
vi.mock("@/lib/constants", () => ({
  CHAINS: {
    11155111: { name: "Ethereum Sepolia", explorerUrl: "https://sepolia.etherscan.io" },
    84532: { name: "Base Sepolia", explorerUrl: "https://sepolia.basescan.org" },
  },
  ETH_SEPOLIA_ID: 11155111,
  BASE_SEPOLIA_ID: 84532,
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import Bridge from "./Bridge";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ETH_SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;

let startMock: ReturnType<typeof vi.fn>;
let claimMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let resumeMock: ReturnType<typeof vi.fn>;

type BridgeStep =
  | "idle" | "approving" | "burning" | "polling" | "readyToClaim"
  | "switching" | "minting" | "complete" | "error";

function setBridge(overrides: Partial<{
  step: BridgeStep;
  attestationStatus: string | null;
  error: string | null;
  resumable: null | { sourceChainId: number; destChainId: number; startedAt: number; attestation: object | null };
  txHashes: { approve?: string; burn?: string; mint?: string };
  quote: null | { destDomain: number; minFinalityThreshold: number };
  attestation: null | { attestation: string };
}> = {}) {
  useBridgeUSDCMock.mockReturnValue({
    step: overrides.step ?? "idle",
    attestationStatus: overrides.attestationStatus ?? null,
    error: overrides.error ?? null,
    resumable: overrides.resumable ?? null,
    txHashes: overrides.txHashes ?? {},
    quote: overrides.quote ?? null,
    attestation: overrides.attestation ?? null,
    start: startMock,
    claim: claimMock,
    reset: resetMock,
    resume: resumeMock,
  });
}

function setBalance(amount: bigint) {
  useReadContractMock.mockReturnValue({ data: amount });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useBridgeUSDCMock.mockReset();
  useReadContractMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA });

  startMock = vi.fn().mockResolvedValue(undefined);
  claimMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  resumeMock = vi.fn();
  setBridge();
  setBalance(100_000_000n); // 100 USDC at 6dp
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Bridge — page chrome (§15.x)", () => {
  it("standalone (embedded=false): renders 'Bridge USDC' heading + privacy + speed framing", () => {
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Bridge USDC");
    expect(container.textContent).toContain("Circle CCTP V2");
    expect(container.textContent).toContain("burn-and-mint");
    expect(container.textContent).toContain("~15 seconds on");
  });

  it("CRITICAL embedded mode suppresses the H1 header (no duplicate when mounted inside Exchange tab)", () => {
    const { container } = render(<Bridge embedded />);
    expect(container.textContent).not.toContain("Bridge USDC");
    // Form still renders.
    expect(container.textContent).toContain("From");
    expect(container.textContent).toContain("To");
  });

  it("CRITICAL CCTP-not-FHE disclosure visible (load-bearing privacy framing)", () => {
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("CCTP burns and mints native USDC");
    expect(container.textContent).toContain("not the encrypted FHE-vault");
    expect(container.textContent).toContain("Unshield encrypted balances first");
  });
});

describe("Bridge — From / To row + direction swap (§15.x)", () => {
  it("default sourceChain = activeChainId (Sepolia); destChain derived as Base Sepolia", () => {
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Ethereum Sepolia");
    expect(container.textContent).toContain("Base Sepolia");
  });

  it("default sourceChain swaps when activeChainId is Base Sepolia", () => {
    useChainMock.mockReturnValue({ activeChainId: BASE_SEPOLIA });
    // Use embedded mode so the page-header subtitle ("Move native USDC
    // between Ethereum Sepolia and Base Sepolia") doesn't pollute the
    // chain-order position check; header naturally lists Eth first.
    const { container } = render(<Bridge embedded />);
    const text = container.textContent ?? "";
    const baseIdx = text.indexOf("Base Sepolia");
    const ethIdx = text.indexOf("Ethereum Sepolia");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(ethIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(ethIdx);
  });

  it("clicking the source-chain button swaps source <-> dest", () => {
    const { container, getByText } = render(<Bridge embedded />);
    const fromBtn = getByText("Ethereum Sepolia").closest("button") as HTMLButtonElement;
    fireEvent.click(fromBtn);
    const text = container.textContent ?? "";
    const baseIdx = text.indexOf("Base Sepolia");
    const ethIdx = text.indexOf("Ethereum Sepolia");
    expect(baseIdx).toBeLessThan(ethIdx);
  });
});

describe("Bridge — active-chain mismatch warning (§15.x)", () => {
  it("CRITICAL: source !== active -> amber warning banner BEFORE Start", () => {
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA });
    const { container, getByText } = render(<Bridge />);
    // Swap source to Base Sepolia (active still ETH_SEPOLIA).
    fireEvent.click(getByText("Ethereum Sepolia").closest("button") as HTMLButtonElement);
    expect(container.textContent).toContain("Your wallet is on");
    expect(container.textContent).toContain("bridge source is");
    expect(container.textContent).toContain("Use the chain selector to switch");
  });

  it("source === active -> warning HIDDEN", () => {
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA });
    const { container } = render(<Bridge />);
    expect(container.textContent).not.toContain("Your wallet is on");
  });
});

describe("Bridge — amount input validation (§15.x)", () => {
  it("amount regex /^\\d*\\.?\\d{0,6}$/: rejects 7th decimal", () => {
    const { getByPlaceholderText } = render(<Bridge />);
    const input = getByPlaceholderText("0.00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1.123456" } });
    expect(input.value).toBe("1.123456");
    fireEvent.change(input, { target: { value: "1.1234567" } });
    expect(input.value).toBe("1.123456");
  });

  it("amount > balance -> 'Amount exceeds balance' inline error", () => {
    setBalance(10_000_000n); // 10 USDC
    const { getByPlaceholderText, container } = render(<Bridge />);
    fireEvent.change(getByPlaceholderText("0.00"), { target: { value: "50" } });
    expect(container.textContent).toContain("Amount exceeds balance");
  });

  it("amount = 0 -> 'Amount must be > 0' inline error", () => {
    const { getByPlaceholderText, container } = render(<Bridge />);
    fireEvent.change(getByPlaceholderText("0.00"), { target: { value: "0" } });
    expect(container.textContent).toContain("Amount must be > 0");
  });

  it("valid amount + sufficient balance + idle + matching chain -> Start enabled", () => {
    const { getByPlaceholderText, container } = render(<Bridge />);
    fireEvent.change(getByPlaceholderText("0.00"), { target: { value: "5" } });
    // Action button labelled "Ready to bridge" (statusLabel for idle).
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ready to bridge")) as HTMLButtonElement;
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
  });

  it("amount valid BUT sourceChain !== activeChainId -> Start DISABLED (canStart all-AND'd)", () => {
    const { getByPlaceholderText, getByText, container } = render(<Bridge />);
    fireEvent.click(getByText("Ethereum Sepolia").closest("button") as HTMLButtonElement);
    fireEvent.change(getByPlaceholderText("0.00"), { target: { value: "5" } });
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ready to bridge")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("Bridge — MAX button (§15.x)", () => {
  it("'Max (X USDC)' label reflects current balance (viem formatUnits strips trailing zeros)", () => {
    setBalance(123_456_000n); // 123.456 USDC at 6dp; formatUnits returns "123.456"
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Max (123.456 USDC)");
  });

  it("MAX click fills the amount input with formatUnits balance (whole numbers render with no decimal point)", () => {
    setBalance(50_000_000n); // 50 USDC; formatUnits returns "50" (no trailing zeros)
    const { container, getByPlaceholderText } = render(<Bridge />);
    const maxBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.startsWith("Max ")) as HTMLButtonElement;
    fireEvent.click(maxBtn);
    expect((getByPlaceholderText("0.00") as HTMLInputElement).value).toBe("50");
  });

  it("MAX disabled when balance = 0", () => {
    setBalance(0n);
    const { container } = render(<Bridge />);
    const maxBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.startsWith("Max ")) as HTMLButtonElement;
    expect(maxBtn.disabled).toBe(true);
  });
});

describe("Bridge — speed toggle (§15.x)", () => {
  it("Fast preset rendered with '~15s · 0.5% fee cap' framing", () => {
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Fast");
    expect(container.textContent).toContain("~15s");
    expect(container.textContent).toContain("0.5% fee cap");
  });

  it("Finalized preset rendered with '~15min · no fee' framing", () => {
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Finalized");
    expect(container.textContent).toContain("~15min");
    expect(container.textContent).toContain("no fee");
  });

  it("default speed = 'fast' (emerald-50 background on Fast tile)", () => {
    const { container } = render(<Bridge />);
    const fastTile = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Fast") && b.textContent?.includes("0.5%")) as HTMLButtonElement;
    expect(fastTile.className).toContain("bg-emerald-50");
  });

  it("clicking Finalized switches the active tile", () => {
    const { container } = render(<Bridge />);
    const finalizedTile = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Finalized")) as HTMLButtonElement;
    fireEvent.click(finalizedTile);
    expect(finalizedTile.className).toContain("bg-indigo-50");
  });
});

describe("Bridge — handleStart flow (§15.x)", () => {
  it("Start click with valid form calls bridge.start with sourceChain/destChain/amountUnits/speed", async () => {
    const { container, getByPlaceholderText } = render(<Bridge />);
    fireEvent.change(getByPlaceholderText("0.00"), { target: { value: "5" } });
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ready to bridge")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(startMock).toHaveBeenCalled();
    const arg = startMock.mock.calls[0][0];
    expect(arg.sourceChain).toBe(ETH_SEPOLIA);
    expect(arg.destChain).toBe(BASE_SEPOLIA);
    expect(arg.amountUnits).toBe(5_000_000n); // parseUnits("5", 6)
    expect(arg.speed).toBe("fast");
  });

  it("Start click with !canStart short-circuits (no bridge.start call)", async () => {
    // No amount set -> canStart=false
    const { container } = render(<Bridge />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ready to bridge")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("Bridge — statusLabel 9-state matrix (§15.x)", () => {
  it("idle -> 'Ready to bridge'", () => {
    setBridge({ step: "idle" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Ready to bridge");
  });

  it("approving -> 'Approving USDC for the CCTP bridge'", () => {
    setBridge({ step: "approving" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Approving USDC for the CCTP bridge");
  });

  it("burning -> 'Burning USDC on the source chain'", () => {
    setBridge({ step: "burning" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Burning USDC on the source chain");
  });

  it("polling + no attestationStatus -> 'Waiting for Circle attestation'", () => {
    setBridge({ step: "polling", attestationStatus: null });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Waiting for Circle attestation");
  });

  it("polling + attestationStatus=pending_confirmations -> '(pending_confirmations)' annotation", () => {
    setBridge({ step: "polling", attestationStatus: "pending_confirmations" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("(pending_confirmations)");
  });

  it("polling + attestationStatus=complete -> 'Attestation ready' override", () => {
    setBridge({ step: "polling", attestationStatus: "complete" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Attestation ready");
  });

  it("readyToClaim -> shows 'Switch to <destChain> & Claim' button", () => {
    setBridge({ step: "readyToClaim" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Switch to Base Sepolia");
    expect(container.textContent).toContain("Claim");
  });

  it("switching -> 'Switching to destination chain'", () => {
    setBridge({ step: "switching" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Switching to destination chain");
  });

  it("minting -> 'Minting USDC on the destination chain'", () => {
    setBridge({ step: "minting" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Minting USDC on the destination chain");
  });

  it("complete -> 'Bridge complete' card + 'Bridge again' reset", () => {
    setBridge({ step: "complete" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Bridge complete");
    expect(container.textContent).toContain("Bridge again");
  });

  it("error step + error message -> rose error card with reset button", () => {
    setBridge({ step: "error", error: "User rejected" });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Bridge interrupted");
    expect(container.textContent).toContain("User rejected");
    expect(container.textContent).toContain("Reset");
  });
});

describe("Bridge — claim flow + reset (§15.x)", () => {
  it("readyToClaim 'Switch & Claim' click calls bridge.claim()", async () => {
    setBridge({ step: "readyToClaim" });
    const { container } = render(<Bridge />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Switch to Base Sepolia")) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimMock).toHaveBeenCalled();
  });

  it("complete state 'Bridge again' click calls bridge.reset()", () => {
    setBridge({ step: "complete" });
    const { container } = render(<Bridge />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Bridge again")) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(resetMock).toHaveBeenCalled();
  });

  it("error state Reset click calls bridge.reset()", () => {
    setBridge({ step: "error", error: "boom" });
    const { container } = render(<Bridge />);
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Reset") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(resetMock).toHaveBeenCalled();
  });
});

describe("Bridge — resume banner (§15.x)", () => {
  const RESUMABLE = {
    sourceChainId: ETH_SEPOLIA,
    destChainId: BASE_SEPOLIA,
    startedAt: Date.now() - 5 * 60 * 1000, // 5 min ago
    attestation: null,
  };

  it("CRITICAL banner visible when bridge.resumable + idle + !inProgress", () => {
    setBridge({ step: "idle", resumable: RESUMABLE });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Unfinished bridge");
    expect(container.textContent).toContain("You started a bridge from Ethereum Sepolia to Base Sepolia");
    expect(container.textContent).toContain("min ago");
  });

  it("banner shows 'Ready to claim' when resumable.attestation is set", () => {
    setBridge({
      step: "idle",
      resumable: { ...RESUMABLE, attestation: { foo: "bar" } },
    });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Ready to claim");
  });

  it("banner shows 'Picking up the attestation poll' when no attestation yet", () => {
    setBridge({ step: "idle", resumable: RESUMABLE });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Picking up the attestation poll");
  });

  it("Resume click calls bridge.resume()", () => {
    setBridge({ step: "idle", resumable: RESUMABLE });
    const { getByText } = render(<Bridge />);
    fireEvent.click(getByText("Resume"));
    expect(resumeMock).toHaveBeenCalled();
  });

  it("Discard click calls bridge.reset()", () => {
    setBridge({ step: "idle", resumable: RESUMABLE });
    const { getByText } = render(<Bridge />);
    fireEvent.click(getByText("Discard"));
    expect(resetMock).toHaveBeenCalled();
  });

  it("banner HIDDEN when step !== idle (mid-bridge already)", () => {
    setBridge({ step: "burning", resumable: RESUMABLE });
    const { container } = render(<Bridge />);
    expect(container.textContent).not.toContain("Unfinished bridge");
  });

  it("banner HIDDEN when no resumable state", () => {
    setBridge({ step: "idle", resumable: null });
    const { container } = render(<Bridge />);
    expect(container.textContent).not.toContain("Unfinished bridge");
  });
});

describe("Bridge — tx-hash explorer links (§15.x)", () => {
  it("approve + burn + mint hashes render explorer links with correct chain", () => {
    setBridge({
      txHashes: {
        approve: "0x" + "1".repeat(64),
        burn: "0x" + "2".repeat(64),
        mint: "0x" + "3".repeat(64),
      },
    });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Burn");
    expect(container.textContent).toContain("Mint");

    const links = container.querySelectorAll("a[target='_blank']");
    expect(links.length).toBeGreaterThanOrEqual(3);
    // Approve + Burn live on the source chain (sepolia.etherscan); Mint on dest.
    const approveLink = Array.from(links).find((l) => l.getAttribute("href")?.includes("1".repeat(64)));
    expect(approveLink?.getAttribute("href")).toContain("sepolia.etherscan.io/tx/");

    const mintLink = Array.from(links).find((l) => l.getAttribute("href")?.includes("3".repeat(64)));
    expect(mintLink?.getAttribute("href")).toContain("sepolia.basescan.org/tx/");
  });

  it("explorer links have tabnabbing guard (rel=noopener+noreferrer)", () => {
    setBridge({ txHashes: { burn: "0x" + "2".repeat(64) } });
    const { container } = render(<Bridge />);
    const link = container.querySelector("a[target='_blank']") as HTMLAnchorElement;
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("tx-hash card HIDDEN when no hashes available (idle state)", () => {
    setBridge({ txHashes: {} });
    const { container } = render(<Bridge />);
    expect(container.textContent).not.toContain("Transactions");
  });
});

describe("Bridge — diagnostic details (§15.x)", () => {
  it("collapsed by default + visible only when quote + step !== idle", () => {
    setBridge({ step: "polling", quote: { destDomain: 6, minFinalityThreshold: 1000 } });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("Bridge details");
    expect(container.textContent).toContain("Min finality");
    expect(container.textContent).toContain("(Fast)"); // 1000 -> Fast
  });

  it("minFinalityThreshold !== 1000 -> '(Finalized)' label", () => {
    setBridge({ step: "polling", quote: { destDomain: 6, minFinalityThreshold: 2000 } });
    const { container } = render(<Bridge />);
    expect(container.textContent).toContain("(Finalized)");
  });

  it("HIDDEN when quote null OR step === idle", () => {
    setBridge({ step: "idle", quote: null });
    const { container } = render(<Bridge />);
    expect(container.textContent).not.toContain("Bridge details");
  });
});
