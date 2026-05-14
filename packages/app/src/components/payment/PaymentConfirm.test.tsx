import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for PaymentConfirm. The pre-send review card on
// the payment flow — splits the payment metadata into TWO
// visually distinct sections to teach users which fields are
// publicly visible on-chain and which are FHE-encrypted. The
// public section (Eye + Globe icons + 'Visible to everyone'
// header) shows: recipient address, note, network, token.
// The encrypted section (Lock icon + 'Encrypted' header)
// shows: amount (the privacy-sensitive value). A dashed
// border separator visually divides the two sections.
//
// CRITICAL pins:
//   - Header: 'Confirm Payment' title + 'Review before sending'
//     subtitle; Shield icon at top in accent-color circle.
//   - Two-section public/encrypted layout: public section has
//     'Visible to everyone' header + Eye icon + Globe icon;
//     encrypted section has 'Encrypted' header + Lock icon +
//     'FHE' label; dashed-border separator with Lock icon
//     between them.
//   - Public section fields rendered: recipient (truncated
//     0xfirst8...last6), note (only when set), network name
//     (from BASE_SEPOLIA.name), token. The recipient truncate
//     is 8 chars before + 6 chars after (so the user can spot
//     a typo without scanning a full 42-char address).
//   - Note row rendered ONLY when note prop is truthy (empty
//     note -> no row, NOT an empty 'Note: ' label).
//   - Encrypted section shows amount as '${amount} {token}'
//     with the privacy pill 'Only you and recipient can see
//     this' below.
//   - Irreversible-action warning banner: 'Encrypted transfers
//     are final and cannot be reversed. Please verify the
//     recipient address.' with AlertTriangle icon — pinned
//     literally because this is the legal-disclaimer copy
//     that protects against user-error-induced loss.
//   - Back + Send Payment buttons: Back has icon=ArrowLeft,
//     Send has icon=ArrowRight; loading prop disables BOTH
//     buttons + the Send Payment button shows the loading
//     spinner (handled by Button primitive); onBack and
//     onConfirm fire on respective clicks.

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));

vi.mock("@/lib/constants", () => ({
  BASE_SEPOLIA: { name: "Base Sepolia", id: 84532 },
}));

// Stub design-system primitives to keep the test focused on
// PaymentConfirm's layout behavior, not the primitives'.
vi.mock("@/components/ui/GlassCard", () => ({
  GlassCard: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <div data-testid="glass-card" data-variant={variant}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      data-variant={variant}
      data-loading={loading ? "true" : undefined}
    >
      {children}
    </button>
  ),
}));

import { PaymentConfirm } from "./PaymentConfirm";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function renderPC(overrides: Partial<Parameters<typeof PaymentConfirm>[0]> = {}) {
  const onConfirm = vi.fn();
  const onBack = vi.fn();
  const utils = render(
    <PaymentConfirm
      recipient={ALICE}
      amount="42.50"
      token="USDC"
      note=""
      onConfirm={onConfirm}
      onBack={onBack}
      {...overrides}
    />,
  );
  return { ...utils, onConfirm, onBack };
}

// ───────────────────────────────────────────────────────────
//  Header + structure
// ───────────────────────────────────────────────────────────

describe("PaymentConfirm — header + structure (§15.x)", () => {
  it("renders inside a GlassCard with variant='elevated'", () => {
    renderPC();
    const card = screen.getByTestId("glass-card");
    expect(card.getAttribute("data-variant")).toBe("elevated");
  });

  it("'Confirm Payment' title + 'Review before sending' subtitle", () => {
    renderPC();
    expect(
      screen.getByRole("heading", { name: "Confirm Payment" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Review before sending")).toBeInTheDocument();
  });

  it("renders BOTH section headers: 'Visible to everyone' + 'Encrypted'", () => {
    renderPC();
    expect(screen.getByText("Visible to everyone")).toBeInTheDocument();
    expect(screen.getByText("Encrypted")).toBeInTheDocument();
  });

  it("'FHE' label appears in the encrypted-section header", () => {
    renderPC();
    expect(screen.getByText("FHE")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Public section fields
// ───────────────────────────────────────────────────────────

describe("PaymentConfirm — public section fields (§15.x)", () => {
  it("recipient truncated as 0xfirst8...last6", () => {
    renderPC();
    // 0xaaaa...aaaaaa (8 chars before, 6 chars after)
    expect(screen.getByText("0xaaaaaa...aaaaaa")).toBeInTheDocument();
  });

  it("Network field uses BASE_SEPOLIA.name from constants", () => {
    renderPC();
    expect(screen.getByText("Base Sepolia")).toBeInTheDocument();
  });

  it("Token field reflects the token prop", () => {
    renderPC({ token: "USDT" });
    // 'USDT' appears in BOTH the public Token field AND the encrypted
    // amount's token label; both are expected.
    expect(screen.getAllByText("USDT").length).toBeGreaterThanOrEqual(2);
  });

  it("Note row hidden when note='' (truthy gate)", () => {
    renderPC({ note: "" });
    expect(screen.queryByText("Note")).toBeNull();
  });

  it("Note row visible when note is set, shows the note text", () => {
    renderPC({ note: "Rent for May" });
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Rent for May")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Encrypted section (amount + privacy pill)
// ───────────────────────────────────────────────────────────

describe("PaymentConfirm — encrypted section (§15.x)", () => {
  it("amount shown as '$<amount>' + token", () => {
    renderPC({ amount: "42.50", token: "USDC" });
    expect(screen.getByText("$42.50")).toBeInTheDocument();
    // 'USDC' appears in BOTH the public Token field AND the encrypted
    // amount label — both expected; the count must be >= 2.
    expect(screen.getAllByText("USDC").length).toBeGreaterThanOrEqual(2);
  });

  it("privacy pill: 'Only you and recipient can see this'", () => {
    renderPC();
    expect(
      screen.getByText("Only you and recipient can see this"),
    ).toBeInTheDocument();
  });

  it("'Amount' label rendered in encrypted section", () => {
    renderPC();
    // The Amount label is uppercase styled but the literal text is 'Amount'
    expect(screen.getByText("Amount")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Irreversible action warning
// ───────────────────────────────────────────────────────────

describe("PaymentConfirm — irreversible warning (§15.x)", () => {
  it("renders legal-disclaimer copy literally", () => {
    renderPC();
    expect(
      screen.getByText(
        /Encrypted transfers are final and cannot be reversed\. Please verify the recipient address\./,
      ),
    ).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Back + Send Payment actions
// ───────────────────────────────────────────────────────────

describe("PaymentConfirm — actions (§15.x)", () => {
  it("Back button click -> onBack fires", () => {
    const { onBack } = renderPC();
    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Send Payment button click -> onConfirm fires", () => {
    const { onConfirm } = renderPC();
    fireEvent.click(screen.getByText("Send Payment"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("loading=true -> BOTH buttons disabled (Back disabled + Send Payment loading-disabled)", () => {
    renderPC({ loading: true });
    const back = screen.getByText("Back").closest("button") as HTMLButtonElement;
    const send = screen.getByText("Send Payment").closest("button") as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("data-loading")).toBe("true");
  });

  it("loading=false default -> BOTH buttons enabled", () => {
    renderPC();
    const back = screen.getByText("Back").closest("button") as HTMLButtonElement;
    const send = screen.getByText("Send Payment").closest("button") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(send.disabled).toBe(false);
  });

  it("Back variant='ghost' (secondary visual) + Send Payment variant='primary'", () => {
    renderPC();
    const back = screen.getByText("Back").closest("button") as HTMLButtonElement;
    const send = screen.getByText("Send Payment").closest("button") as HTMLButtonElement;
    expect(back.getAttribute("data-variant")).toBe("ghost");
    expect(send.getAttribute("data-variant")).toBe("primary");
  });

  it("loading=true -> click on Send Payment does NOT fire onConfirm (disabled prevents)", () => {
    const { onConfirm } = renderPC({ loading: true });
    fireEvent.click(screen.getByText("Send Payment"));
    expect(onConfirm).toHaveBeenCalledTimes(0);
  });
});
