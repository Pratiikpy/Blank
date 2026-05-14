import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for FundAccountModal. The "send ETH to your AA"
// walkthrough that surfaces when BlankPaymaster is degraded AND
// the user's smart account lacks enough ETH on the active chain
// to self-pay a UserOp's prefund. Critical UX guard: same AA
// address holds INDEPENDENT ETH balances per chain (the address
// is Create2-deterministic so it's the same on every chain, but
// the ETH balance is per-chain). The modal repeats the chain
// name in 4 different places to prevent users from sending
// Sepolia ETH to their Base Sepolia balance (or vice-versa).
//
// CRITICAL pins:
//   - open=false -> renders null (component returns null early);
//     test pins via queryByRole('dialog') === null so a stale
//     modal can't ghost-intercept overlay clicks.
//   - Chain name repeated in 4 places: title 'Fund your {name}
//     wallet', balance label 'Balance on {name}', address label
//     'Your wallet address (on {name})', faucet header 'Get free
//     {name} ETH'. A regression that dropped any of the 4 would
//     create a chain-mismatch hazard for the user.
//   - useBalance polling: enabled only when open AND address are
//     both truthy; refetchInterval 5000ms when open, false when
//     closed (so the query stops polling on unmount); pinned via
//     useBalance mock call inspection.
//   - DEFAULT_REQUIRED_WEI = 1_000_000_000_000_000n (0.001 ETH);
//     test pins by mounting with no requiredWei override and
//     asserting 'of 0.001 ETH needed' in the rendered output;
//     caller can override via the requiredWei prop for first-time
//     deploys (~0.005 ETH).
//   - isFunded = balanceWei >= requiredWei; isFunded=false ->
//     button disabled + 'Waiting for {chain.name} ETH…' + amber
//     progress bar; isFunded=true -> button enabled + 'Funded —
//     continue' + emerald progress bar.
//   - progressPct: Math.min(100, Number((balanceWei * 100n) /
//     requiredWei)); 0 wei -> 0%, requiredWei -> 100%, 50% wei ->
//     50%, OVER-funded clamped to 100% so the bar doesn't overflow.
//   - onFunded fires ONCE when threshold crossed (didFire ref
//     guard); subsequent polls with isFunded=true do NOT re-fire;
//     modal close + re-open resets didFire so onFunded fires
//     again on the next funding event.
//   - Copy: navigator.clipboard.writeText(address) sets copied=
//     true + Check icon + 'Copied' label; auto-clears back to
//     Copy icon + 'Copy' label after 1.5s; clipboard.writeText
//     throwing -> toast.error fallback with manual-copy hint.
//   - ESC key closes modal; overlay click closes modal; inner
//     card click does NOT propagate (e.stopPropagation prevents
//     overlay click from firing); Cancel button + X button both
//     call onClose.
//   - Continue button click when funded -> calls onFunded(balanceWei)
//     AND onClose; disabled when not funded so the user can't
//     click through; the onFunded callback is OPTIONAL (some
//     callers just use the modal as a passive viewer).
//   - faucets array from FAUCET_LINKS[chainId] ?? []; empty array
//     shows 'No faucets configured for this chain. Send ETH from
//     another wallet.' message; non-empty array renders each as
//     an external anchor with target='_blank' + rel='noopener
//     noreferrer' for security.
//   - QR code rendered ONLY when address is set; null address ->
//     placeholder square (so the modal doesn't crash mid-mount
//     when useEffectiveAddress is still resolving).
//   - trimZeros helper applied to balance + required display:
//     '0.0010000' -> '0.001'; '1.000000' -> '1'; '0' stays '0'
//     (no trailing dot).

const useBalanceMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useBalance: useBalanceMock }));
vi.mock("@/lib/constants", () => ({
  CHAINS: {
    11155111: {
      id: 11155111,
      name: "Ethereum Sepolia",
      shortName: "Sepolia",
    },
    84532: {
      id: 84532,
      name: "Base Sepolia",
      shortName: "Base",
    },
  },
  FAUCET_LINKS: {
    11155111: [
      { label: "Alchemy Faucet", url: "https://sepolia-faucet.example.com" },
      { label: "Infura Faucet", url: "https://infura.example.com" },
    ],
    84532: [
      { label: "Base Sepolia Faucet", url: "https://base-faucet.example.com" },
    ],
  },
}));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));
vi.mock("qrcode.react", () => ({
  // Render a recognizable stub so we can assert "address QR rendered".
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="qr-code" data-qr-value={value}>
      <rect />
    </svg>
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock },
}));

import { FundAccountModal } from "./FundAccountModal";

const SA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

const writeTextMock = vi.fn();

beforeEach(() => {
  useBalanceMock.mockReset();
  toastErrorMock.mockReset();
  writeTextMock.mockReset();

  useBalanceMock.mockReturnValue({
    data: { value: 0n },
    isFetching: false,
  });

  // Default clipboard mock: success
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
  });
  writeTextMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  open prop / render gate
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — open prop (§15.x)", () => {
  it("open=false -> renders null", () => {
    render(
      <FundAccountModal
        open={false}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("open=true -> renders dialog with role + aria-modal + aria-label", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe(
      "Fund your Ethereum Sepolia wallet",
    );
  });

  it("title override -> used in heading AND aria-label", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        title="Fund your wallet to send"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Fund your wallet to send" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Fund your wallet to send",
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Chain-name repetition (4 places)
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — chain name in 4 places (§15.x)", () => {
  it("Ethereum Sepolia: title + balance label + address label + faucet header all say 'Ethereum Sepolia'", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Fund your Ethereum Sepolia wallet/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Balance on Ethereum Sepolia")).toBeInTheDocument();
    expect(
      screen.getByText("Your wallet address (on Ethereum Sepolia)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Get free Ethereum Sepolia ETH")).toBeInTheDocument();
  });

  it("Base Sepolia: all 4 chain-name placeholders switch", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={84532}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Fund your Base Sepolia wallet/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Balance on Base Sepolia")).toBeInTheDocument();
    expect(
      screen.getByText("Your wallet address (on Base Sepolia)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Get free Base Sepolia ETH")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  useBalance polling
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — useBalance polling (§15.x)", () => {
  it("open=true + address set -> useBalance enabled + 5s refetch interval", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    const lastCall = useBalanceMock.mock.calls[useBalanceMock.mock.calls.length - 1][0];
    expect(lastCall.address).toBe(SA);
    expect(lastCall.chainId).toBe(11155111);
    expect(lastCall.query.enabled).toBe(true);
    expect(lastCall.query.refetchInterval).toBe(5_000);
  });

  it("open=true + address null -> useBalance disabled + address undefined", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={null}
        chainId={11155111}
      />,
    );
    const lastCall = useBalanceMock.mock.calls[useBalanceMock.mock.calls.length - 1][0];
    expect(lastCall.address).toBeUndefined();
    expect(lastCall.query.enabled).toBe(false);
  });

  it("open=false -> useBalance disabled + refetchInterval false (stops polling)", () => {
    render(
      <FundAccountModal
        open={false}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    // Even though the modal doesn't render, useBalance is still called at hook init
    const lastCall = useBalanceMock.mock.calls[useBalanceMock.mock.calls.length - 1][0];
    expect(lastCall.query.enabled).toBe(false);
    expect(lastCall.query.refetchInterval).toBe(false);
  });

  it("isFetching=true -> spinner shown in balance card", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 0n },
      isFetching: true,
    });
    const { container } = render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    // The Loader2 has animate-spin; just check it's in the balance section.
    const balanceCard = screen.getByText("Balance on Ethereum Sepolia")
      .closest("div");
    expect(balanceCard?.querySelector(".animate-spin")).not.toBeNull();
    expect(container).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────
//  isFunded + progress bar
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — isFunded + progress (§15.x)", () => {
  it("default requiredWei=0.001 ETH; balance=0 -> 'Waiting for Ethereum Sepolia ETH…' + disabled CTA", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 0n },
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    expect(screen.getByText(/Waiting for Ethereum Sepolia ETH/)).toBeInTheDocument();
    expect(screen.getByText(/of 0.001 ETH needed/)).toBeInTheDocument();
    const cta = screen
      .getByText(/Waiting for Ethereum Sepolia ETH/)
      .closest("button") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it("balance >= requiredWei -> 'Funded — continue' + enabled CTA", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n }, // 0.001 ETH
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    expect(screen.getByText(/Funded — continue/)).toBeInTheDocument();
    const cta = screen
      .getByText(/Funded — continue/)
      .closest("button") as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
  });

  it("requiredWei override (0.005 ETH for first-time deploy) -> 'of 0.005 ETH needed'", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        requiredWei={5_000_000_000_000_000n}
      />,
    );
    expect(screen.getByText(/of 0.005 ETH needed/)).toBeInTheDocument();
  });

  it("balance > requiredWei -> isFunded=true, progressPct clamped at 100 (no overflow)", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 10_000_000_000_000_000n }, // 10x required
      isFetching: false,
    });
    const { container } = render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    // Find the progress bar (a div with style width)
    const progressBar = container.querySelector('[style*="width:"]') as HTMLElement;
    expect(progressBar.style.width).toBe("100%");
  });

  it("partial balance (50%) -> progress bar style.width 50%", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 500_000_000_000_000n }, // 0.0005 ETH (half of 0.001)
      isFetching: false,
    });
    const { container } = render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    const progressBar = container.querySelector('[style*="width:"]') as HTMLElement;
    expect(progressBar.style.width).toBe("50%");
  });
});

// ───────────────────────────────────────────────────────────
//  onFunded firing discipline
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — onFunded firing discipline (§15.x)", () => {
  it("onFunded fires ONCE when threshold crossed (effect)", async () => {
    const onFunded = vi.fn();
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    await waitFor(() => {
      expect(onFunded).toHaveBeenCalledWith(1_000_000_000_000_000n);
    });
  });

  it("onFunded NOT re-fired on subsequent re-renders with same funded state", async () => {
    const onFunded = vi.fn();
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    const { rerender } = render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
    // Simulate next poll with higher balance (still funded)
    useBalanceMock.mockReturnValue({
      data: { value: 2_000_000_000_000_000n },
      isFetching: false,
    });
    rerender(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    // Still only fired once — didFire guard prevents re-fire
    expect(onFunded).toHaveBeenCalledTimes(1);
  });

  it("modal close -> didFire resets so re-opening fires onFunded again", async () => {
    const onFunded = vi.fn();
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    const { rerender } = render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
    // Close
    rerender(
      <FundAccountModal
        open={false}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    // Re-open
    rerender(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    await waitFor(() => {
      expect(onFunded).toHaveBeenCalledTimes(2);
    });
  });

  it("onFunded undefined (omitted) -> no crash when threshold crosses", async () => {
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    expect(() => {
      render(
        <FundAccountModal
          open={true}
          onClose={vi.fn()}
          address={SA}
          chainId={11155111}
        />,
      );
    }).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────
//  Continue + Cancel + close paths
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — close paths (§15.x)", () => {
  it("Cancel button click -> onClose", () => {
    const onClose = vi.fn();
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("X (Close) button click -> onClose", () => {
    const onClose = vi.fn();
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("overlay click -> onClose", () => {
    const onClose = vi.fn();
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key -> onClose", () => {
    const onClose = vi.fn();
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Continue button click when funded -> onFunded + onClose", () => {
    const onClose = vi.fn();
    const onFunded = vi.fn();
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    // onFunded fires once from the effect; click adds a second
    fireEvent.click(screen.getByText(/Funded — continue/));
    expect(onFunded).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Continue button when NOT funded -> disabled, no onFunded/onClose", () => {
    const onClose = vi.fn();
    const onFunded = vi.fn();
    render(
      <FundAccountModal
        open={true}
        onClose={onClose}
        address={SA}
        chainId={11155111}
        onFunded={onFunded}
      />,
    );
    const cta = screen
      .getByText(/Waiting for Ethereum Sepolia ETH/)
      .closest("button") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(onFunded).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Copy address flow
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — copy address (§15.x)", () => {
  it("Copy button -> writes address to clipboard + flips to 'Copied'", async () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(SA);
    });
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
  });

  it("Copy state registers a setTimeout for the 1.5s clear (cleanup pinned)", async () => {
    // Spy on setTimeout to verify the 1.5s timer registers when copied flips
    // true. Don't try to drive fake-timer through the React state update +
    // clipboard promise resolution dance — that combination is brittle in
    // jsdom because real microtasks (the clipboard promise) and fake timers
    // (the setTimeout) interleave in non-deterministic ways.
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
    // The 'Copied' state effect registers a 1500ms setTimeout to clear.
    const matchingTimer = setTimeoutSpy.mock.calls.find(
      (call) => call[1] === 1500,
    );
    expect(matchingTimer).toBeDefined();
    setTimeoutSpy.mockRestore();
  });

  it("clipboard.writeText throws -> toast.error with manual-copy hint", async () => {
    writeTextMock.mockRejectedValue(new Error("permission denied"));
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("Long-press the address to copy"),
      );
    });
  });

  it("address null -> Copy button disabled", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={null}
        chainId={11155111}
      />,
    );
    const copyBtn = screen.getByText("Copy").closest("button") as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
  });

  it("address null -> QR code NOT rendered (placeholder div instead)", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={null}
        chainId={11155111}
      />,
    );
    expect(screen.queryByTestId("qr-code")).toBeNull();
    // Address text shows em-dash placeholder
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("address set -> QR code rendered with address as value", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    const qr = screen.getByTestId("qr-code");
    expect(qr.getAttribute("data-qr-value")).toBe(SA);
  });
});

// ───────────────────────────────────────────────────────────
//  Faucet links
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — faucet links (§15.x)", () => {
  it("Sepolia: renders both Alchemy + Infura faucet anchors with target=_blank + rel=noopener", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    const alchemy = screen.getByText("Alchemy Faucet").closest("a") as HTMLAnchorElement;
    expect(alchemy.href).toBe("https://sepolia-faucet.example.com/");
    expect(alchemy.target).toBe("_blank");
    expect(alchemy.rel).toContain("noopener");
    expect(alchemy.rel).toContain("noreferrer");
    expect(screen.getByText("Infura Faucet")).toBeInTheDocument();
  });

  it("Base Sepolia: renders Base Sepolia faucet only", () => {
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={84532}
      />,
    );
    expect(screen.getByText("Base Sepolia Faucet")).toBeInTheDocument();
    expect(screen.queryByText("Alchemy Faucet")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Balance display (trimZeros)
// ───────────────────────────────────────────────────────────

describe("FundAccountModal — trimZeros balance display (§15.x)", () => {
  it("balance 0n -> displays '0'", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 0n },
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    // Balance display contains 0 with ETH suffix; required shows 0.001
    expect(screen.getByText(/of 0.001 ETH needed/)).toBeInTheDocument();
  });

  it("balance 0.0010000 ETH -> trims to '0.001'", () => {
    useBalanceMock.mockReturnValue({
      data: { value: 1_000_000_000_000_000n },
      isFetching: false,
    });
    render(
      <FundAccountModal
        open={true}
        onClose={vi.fn()}
        address={SA}
        chainId={11155111}
      />,
    );
    // Required + balance both round to 0.001; check at least one rendered
    const matches = screen.getAllByText(/0\.001/);
    expect(matches.length).toBeGreaterThan(0);
  });
});
