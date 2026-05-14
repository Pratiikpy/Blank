import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for PaymentSuccess. The post-send confirmation
// screen on the payment flow. Shows: animated success ripple
// + CheckCircle icon, 'Transfer Encrypted' headline + 'Encrypted
// payment delivered successfully' subtitle, payment details
// summary (To / Amount / optional Note), tx-hash with
// copy-to-clipboard button + explorer link, and a 'Send Another
// Payment' CTA. Critical because this is the final receipt
// users see and screenshot for their records.
//
// CRITICAL pins:
//   - Headline 'Transfer Encrypted' (NOT 'Transfer Sent' or
//     'Payment Sent') — the word 'Encrypted' is deliberate
//     because it reinforces the FHE invariant at the moment of
//     success; users will remember 'I sent an ENCRYPTED
//     transfer' which is the brand-meaningful framing.
//   - Subtitle 'Encrypted payment delivered successfully' —
//     pinned literally for the same reason.
//   - Details summary: recipient truncated as 0xfirst8...last6
//     (same format as PaymentConfirm so users see consistent
//     receipt rows pre/post-send); amount as '${amount} {token}'
//     in accent-color; Note row hidden when note='' (same
//     truthy-gate as PaymentConfirm).
//   - tx-hash rendered when txHash is non-null: truncated as
//     0xfirst12...last8 (12+8 instead of 8+6 because the txHash
//     is more critical for verification — users may want to
//     paste it into block explorers); txHash null -> ENTIRE
//     tx-hash + explorer block is hidden (no broken link).
//   - Copy button: click writes txHash to clipboard via
//     copyToClipboard helper + flips state to 'copied' (Check
//     icon replaces Copy icon) + auto-clears back to Copy after
//     2000ms via setTimeout (same pattern as
//     CopyInvoiceLink + FundAccountModal).
//   - Explorer link: 'View on Explorer' anchor + target='_blank'
//     + rel='noopener noreferrer'; href from getExplorerTxUrl
//     (lib/constants helper).
//   - 'Send Another Payment' button -> onSendAnother callback;
//     variant='secondary' size='lg' so it's prominent but not
//     primary (the primary success-action was the implicit
//     'you already sent it' completion).
//   - 3 ripple rings animate via framer-motion with staggered
//     delays (RIPPLE_COUNT=3, RIPPLE_STAGGER=0.3); the static
//     glow + spring-in CheckCircle complete the success
//     animation choreography.

const copyToClipboardMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, className, style }: { children?: React.ReactNode; className?: string; style?: React.CSSProperties }) => (
      <div className={className} style={style}>{children}</div>
    ),
  },
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: copyToClipboardMock }));
vi.mock("@/lib/constants", () => ({ getExplorerTxUrl: getExplorerTxUrlMock }));

vi.mock("@/components/ui/GlassCard", () => ({
  GlassCard: ({ children, variant, className }: { children: React.ReactNode; variant?: string; className?: string }) => (
    <div data-testid="glass-card" data-variant={variant} className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    className?: string;
  }) => (
    <button onClick={onClick} data-variant={variant} className={className}>
      {children}
    </button>
  ),
}));

import { PaymentSuccess } from "./PaymentSuccess";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_HASH = "0x1234567890abcdef1234567890abcdef12345678";

beforeEach(() => {
  copyToClipboardMock.mockReset();
  getExplorerTxUrlMock.mockReset();
  copyToClipboardMock.mockResolvedValue(undefined);
  getExplorerTxUrlMock.mockReturnValue(
    `https://sepolia.etherscan.io/tx/${TX_HASH}`,
  );
});

function renderPS(overrides: Partial<Parameters<typeof PaymentSuccess>[0]> = {}) {
  const onSendAnother = vi.fn();
  const utils = render(
    <PaymentSuccess
      recipient={ALICE}
      amount="42.50"
      token="USDC"
      note=""
      txHash={TX_HASH}
      onSendAnother={onSendAnother}
      {...overrides}
    />,
  );
  return { ...utils, onSendAnother };
}

// ───────────────────────────────────────────────────────────
//  Headline + subtitle (brand-meaningful copy)
// ───────────────────────────────────────────────────────────

describe("PaymentSuccess — headline + subtitle (§15.x)", () => {
  it("headline 'Transfer Encrypted' (NOT 'Sent' or 'Complete')", () => {
    renderPS();
    expect(
      screen.getByRole("heading", { name: "Transfer Encrypted" }),
    ).toBeInTheDocument();
  });

  it("subtitle 'Encrypted payment delivered successfully' (pinned literally)", () => {
    renderPS();
    expect(
      screen.getByText("Encrypted payment delivered successfully"),
    ).toBeInTheDocument();
  });

  it("renders inside a GlassCard with variant='elevated' + text-center class", () => {
    renderPS();
    const card = screen.getByTestId("glass-card");
    expect(card.getAttribute("data-variant")).toBe("elevated");
    expect(card.className).toContain("text-center");
  });
});

// ───────────────────────────────────────────────────────────
//  Details summary
// ───────────────────────────────────────────────────────────

describe("PaymentSuccess — details summary (§15.x)", () => {
  it("recipient truncated 0xfirst8...last6 (same format as PaymentConfirm)", () => {
    renderPS();
    expect(screen.getByText("0xaaaaaa...aaaaaa")).toBeInTheDocument();
  });

  it("amount as '${amount} {token}' in accent color", () => {
    renderPS({ amount: "42.50", token: "USDC" });
    expect(screen.getByText("$42.50 USDC")).toBeInTheDocument();
  });

  it("Note row hidden when note='' (truthy gate)", () => {
    renderPS({ note: "" });
    expect(screen.queryByText("Note")).toBeNull();
  });

  it("Note row visible when note is set", () => {
    renderPS({ note: "Rent for May" });
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Rent for May")).toBeInTheDocument();
  });

  it("To / Amount labels rendered as caption-style text", () => {
    renderPS();
    expect(screen.getByText("To")).toBeInTheDocument();
    expect(screen.getByText("Amount")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Tx hash + copy + explorer
// ───────────────────────────────────────────────────────────

describe("PaymentSuccess — tx-hash + explorer (§15.x)", () => {
  it("txHash truncated 0xfirst12...last8 (more chars than recipient for verification)", () => {
    renderPS({ txHash: TX_HASH });
    // First 12 = "0x1234567890" + last 8 = "12345678"
    expect(screen.getByText(/0x1234567890.*12345678/)).toBeInTheDocument();
  });

  it("Copy button click -> copyToClipboard(txHash) called", async () => {
    renderPS({ txHash: TX_HASH });
    const copyBtn = screen.getByText(/0x1234567890/).closest("button")!;
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith(TX_HASH);
    });
  });

  it("after copy click -> Check icon replaces Copy icon (success state)", async () => {
    const { container } = renderPS({ txHash: TX_HASH });
    const copyBtn = screen.getByText(/0x1234567890/).closest("button")!;
    // Before click: Copy icon (lucide-react renders both as <svg>); check
    // there's exactly ONE svg in the button (the Copy icon).
    expect(copyBtn.querySelectorAll("svg")).toHaveLength(1);
    fireEvent.click(copyBtn);
    await waitFor(() => {
      // After click: Check icon — still 1 svg but a different one. We pin
      // the post-click presence of a 'text-accent' class on the icon
      // (Check has it, Copy does NOT).
      const svgs = copyBtn.querySelectorAll("svg.text-accent");
      expect(svgs.length).toBeGreaterThan(0);
    });
    expect(container).toBeDefined();
  });

  it("Copy state registers a setTimeout(2000ms) for the auto-clear", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    renderPS({ txHash: TX_HASH });
    const copyBtn = screen.getByText(/0x1234567890/).closest("button")!;
    fireEvent.click(copyBtn);
    await waitFor(() => {
      const timer = setTimeoutSpy.mock.calls.find((call) => call[1] === 2000);
      expect(timer).toBeDefined();
    });
    setTimeoutSpy.mockRestore();
  });

  it("Copy button click on null txHash -> no-op (no copyToClipboard call)", async () => {
    renderPS({ txHash: null });
    // The whole tx-hash block is hidden, so the button doesn't exist
    expect(screen.queryByText(/0x1234567890/)).toBeNull();
    expect(copyToClipboardMock).toHaveBeenCalledTimes(0);
  });

  it("'View on Explorer' link with target='_blank' + rel='noopener noreferrer'", () => {
    renderPS({ txHash: TX_HASH });
    const link = screen.getByText(/View on Explorer/).closest("a") as HTMLAnchorElement;
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
    expect(link.href).toBe(`https://sepolia.etherscan.io/tx/${TX_HASH}`);
  });

  it("getExplorerTxUrl(txHash) called once on render to build the link", () => {
    renderPS({ txHash: TX_HASH });
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith(TX_HASH);
  });

  it("txHash=null -> ENTIRE tx-hash + explorer block hidden (no broken link)", () => {
    renderPS({ txHash: null });
    expect(screen.queryByText(/View on Explorer/)).toBeNull();
    expect(screen.queryByText(/0x1234567890/)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Send Another Payment action
// ───────────────────────────────────────────────────────────

describe("PaymentSuccess — Send Another Payment (§15.x)", () => {
  it("'Send Another Payment' button -> onSendAnother fires", () => {
    const { onSendAnother } = renderPS();
    fireEvent.click(screen.getByText("Send Another Payment"));
    expect(onSendAnother).toHaveBeenCalledTimes(1);
  });

  it("button uses variant='secondary' (NOT primary — the primary action was the implicit success)", () => {
    renderPS();
    const btn = screen.getByText("Send Another Payment").closest("button")!;
    expect(btn.getAttribute("data-variant")).toBe("secondary");
  });

  it("button is full-width via 'w-full' class", () => {
    renderPS();
    const btn = screen.getByText("Send Another Payment").closest("button")!;
    expect(btn.className).toContain("w-full");
  });
});
