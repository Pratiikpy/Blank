import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// §15.x test for SendForm. The amount + recipient + note input
// surface on the payment flow. Hero amount input at top with $
// prefix + token pill + encrypted preview below; recipient
// input with contact-autocomplete dropdown + address validation;
// optional note input with 'Notes are public' hint; live
// privacy preview card showing the public vs encrypted split;
// cofhe-connection warning when encryption engine still
// connecting; primary 'Encrypt & Send' CTA with disabled-reason
// hint underneath.
//
// CRITICAL pins:
//   - Hero amount input: borderless huge centered field with
//     $ prefix that flips color when amount is empty ('text-
//     neutral-600' dim) vs filled ('text-neutral-400' brighter);
//     inputMode='decimal' so mobile keyboards open the decimal-
//     focused keypad; aria-label='Payment amount'.
//   - Encrypted preview '= ••••.•• encrypted' (U+2022 BULLET
//     chars via ENCRYPTED_PLACEHOLDER) below the hero amount —
//     teaches the privacy invariant at the input stage, NOT
//     just at the confirm screen.
//   - Available balance row rendered ONLY when availableBalance
//     prop is provided; format 'Available: <bal> USDC' with
//     mono tabular-nums for clean digit alignment.
//   - Address validation regex /^0x[a-fA-F0-9]{40}$/: error
//     shown inline 'Invalid Ethereum address' when recipient
//     is non-empty AND fails regex; empty recipient -> no
//     error (don't yell at the user before they type).
//   - Contact autocomplete dropdown: shows up to 5 filtered
//     contacts when input is focused AND has any text; filter
//     is case-INsensitive on nickname OR address substring;
//     onMouseDown e.preventDefault() prevents blur firing
//     BEFORE click handler so the dropdown click works (without
//     preventDefault, the input's blur would close the dropdown
//     before onClick fires).
//   - Contact click -> onRecipientChange with the address (NOT
//     nickname) + closes dropdown immediately (not via blur
//     timeout).
//   - Note input has 'Notes are public. Everyone can see them'
//     hint — pinned literally because this is the
//     privacy-mode-mismatch warning that prevents users from
//     putting sensitive info into a public field.
//   - Privacy preview card 2-section split: Public row shows
//     'You → <recipient-truncated> "<note>"' (note only when
//     set); Encrypted row shows 'Amount: ••••.••'; dashed
//     divider between them mirrors the confirm-screen layout.
//   - cofheConnected=false -> 'Connecting to encryption
//     engine...' warning visible with animate-pulse class.
//   - Send button: 'Encrypt & Send' label + disabled when
//     !canProceed OR address invalid; disabledReason hint
//     shown underneath ('Enter recipient address' / 'Invalid
//     Ethereum address' / 'Enter amount' / null when all OK).

vi.mock("@/lib/constants", () => ({
  ENCRYPTED_PLACEHOLDER: "••••.••",
}));

vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

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
    variant,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    className?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      className={className}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/Input", () => ({
  Input: ({
    label,
    placeholder,
    value,
    onChange,
    onFocus,
    onBlur,
    error,
    hint,
    rightElement,
  }: {
    label?: string;
    placeholder?: string;
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    error?: string;
    hint?: string;
    rightElement?: React.ReactNode;
  }) => (
    <div data-input-label={label}>
      {label && <label>{label}</label>}
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {rightElement}
      {error && <span role="alert">{error}</span>}
      {hint && !error && <span>{hint}</span>}
    </div>
  ),
}));

import { SendForm } from "./SendForm";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function renderForm(overrides: Partial<Parameters<typeof SendForm>[0]> = {}) {
  const onRecipientChange = vi.fn();
  const onAmountChange = vi.fn();
  const onNoteChange = vi.fn();
  const onSend = vi.fn();
  const utils = render(
    <SendForm
      recipient=""
      amount=""
      note=""
      token="USDC"
      canProceed={false}
      onRecipientChange={onRecipientChange}
      onAmountChange={onAmountChange}
      onNoteChange={onNoteChange}
      onSend={onSend}
      {...overrides}
    />,
  );
  return { ...utils, onRecipientChange, onAmountChange, onNoteChange, onSend };
}

// ───────────────────────────────────────────────────────────
//  Hero amount input
// ───────────────────────────────────────────────────────────

describe("SendForm — hero amount input (§15.x)", () => {
  it("renders amount input with aria-label='Payment amount' + inputMode='decimal'", () => {
    renderForm();
    const input = screen.getByLabelText("Payment amount") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });

  it("amount input fires onAmountChange on typing", () => {
    const { onAmountChange } = renderForm();
    const input = screen.getByLabelText("Payment amount") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42.50" } });
    expect(onAmountChange).toHaveBeenCalledWith("42.50");
  });

  it("dollar sign color: dim 'text-neutral-600' when amount='' / brighter 'text-neutral-400' when filled", () => {
    const { container, rerender } = renderForm({ amount: "" });
    const dollar = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "$");
    expect(dollar?.className).toContain("text-neutral-600");
    rerender(
      <SendForm
        recipient=""
        amount="42"
        note=""
        token="USDC"
        canProceed={false}
        onRecipientChange={vi.fn()}
        onAmountChange={vi.fn()}
        onNoteChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    const dollar2 = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "$");
    expect(dollar2?.className).toContain("text-neutral-400");
    expect(dollar2?.className).not.toContain("text-neutral-600");
  });

  it("token pill shows the token prop (default USDC)", () => {
    renderForm({ token: "USDT" });
    expect(screen.getByText("USDT")).toBeInTheDocument();
  });

  it("encrypted preview '= ••••.•• encrypted' below hero amount", () => {
    renderForm();
    expect(screen.getByText(/= ••••\.•• encrypted/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Available balance (conditional)
// ───────────────────────────────────────────────────────────

describe("SendForm — available balance (§15.x)", () => {
  it("availableBalance set -> 'Available: <bal> USDC' rendered", () => {
    renderForm({ availableBalance: "1,250.00" });
    expect(screen.getByText(/Available:/)).toBeInTheDocument();
    expect(screen.getByText("1,250.00")).toBeInTheDocument();
  });

  it("availableBalance omitted -> Available row NOT rendered", () => {
    renderForm();
    expect(screen.queryByText(/Available:/)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Recipient input + address validation
// ───────────────────────────────────────────────────────────

describe("SendForm — recipient + address validation (§15.x)", () => {
  it("recipient input fires onRecipientChange on typing", () => {
    const { onRecipientChange } = renderForm();
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.change(input, { target: { value: ALICE } });
    expect(onRecipientChange).toHaveBeenCalledWith(ALICE);
  });

  it("invalid address (non-empty + bad regex) -> 'Invalid Ethereum address' inline error", () => {
    renderForm({ recipient: "not-an-address" });
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Ethereum address");
  });

  it("empty recipient -> NO error shown (don't yell at user before typing)", () => {
    renderForm({ recipient: "" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("valid full 0x address -> NO error shown", () => {
    renderForm({ recipient: ALICE });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Contact autocomplete dropdown
// ───────────────────────────────────────────────────────────

describe("SendForm — contact autocomplete (§15.x)", () => {
  const contacts = [
    { address: ALICE, nickname: "Alice" },
    { address: BOB, nickname: "Bob" },
  ];

  it("focus on recipient input + typing 'A' -> dropdown shows matching contacts", () => {
    renderForm({ contacts, recipient: "A" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("filter is case-INsensitive on nickname", () => {
    renderForm({ contacts, recipient: "alice" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("filter is case-INsensitive on address substring", () => {
    renderForm({ contacts, recipient: "0xAAAA" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("contact click -> onRecipientChange called with the ADDRESS (not nickname)", () => {
    const { onRecipientChange } = renderForm({ contacts, recipient: "A" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.click(screen.getByText("Alice"));
    expect(onRecipientChange).toHaveBeenCalledWith(ALICE);
  });

  it("empty recipient -> dropdown NOT shown even when contacts exist", () => {
    renderForm({ contacts, recipient: "" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("contacts array undefined -> graceful (no crash, no dropdown)", () => {
    expect(() => renderForm({ recipient: "Alice" })).not.toThrow();
  });

  it("dropdown limits to first 5 matches", () => {
    const many = Array.from({ length: 10 }).map((_, i) => ({
      address: `0x${i.toString(16).padStart(40, "0")}`,
      nickname: `User-${i}`,
    }));
    renderForm({ contacts: many, recipient: "User" });
    const input = screen.getByLabelText("Recipient") as HTMLInputElement;
    fireEvent.focus(input);
    const rendered = screen.queryAllByText(/^User-\d$/);
    expect(rendered.length).toBeLessThanOrEqual(5);
  });
});

// ───────────────────────────────────────────────────────────
//  Note input
// ───────────────────────────────────────────────────────────

describe("SendForm — note input (§15.x)", () => {
  it("note input fires onNoteChange on typing", () => {
    const { onNoteChange } = renderForm();
    const input = screen.getByLabelText("Note (optional)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Rent" } });
    expect(onNoteChange).toHaveBeenCalledWith("Rent");
  });

  it("hint 'Notes are public. Everyone can see them' rendered", () => {
    renderForm();
    expect(
      screen.getByText("Notes are public. Everyone can see them"),
    ).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Privacy preview card (public + encrypted)
// ───────────────────────────────────────────────────────────

describe("SendForm — privacy preview card (§15.x)", () => {
  it("renders BOTH 'Public' + 'Encrypted' section headers", () => {
    renderForm();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Encrypted")).toBeInTheDocument();
  });

  it("recipient empty -> public row shows 'Recipient' placeholder", () => {
    renderForm();
    // 'Recipient' appears in BOTH the Input label AND the privacy-preview
    // placeholder; both are expected so use getAllByText (>=2).
    expect(screen.getAllByText("Recipient").length).toBeGreaterThanOrEqual(2);
  });

  it("recipient set -> public row shows truncated 0xfirst6...last4", () => {
    renderForm({ recipient: ALICE });
    expect(screen.getByText("0xaaaa...aaaa")).toBeInTheDocument();
  });

  it("note set -> public row includes note in quotes", () => {
    renderForm({ recipient: ALICE, note: "Coffee" });
    expect(screen.getByText(/"Coffee"|“Coffee”/)).toBeInTheDocument();
  });

  it("encrypted row shows 'Amount: ••••.••' (literal bullet chars)", () => {
    renderForm();
    expect(screen.getByText(/Amount: ••••\.••/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  CoFHE connection warning
// ───────────────────────────────────────────────────────────

describe("SendForm — cofhe connection warning (§15.x)", () => {
  it("cofheConnected=false -> 'Connecting to encryption engine...' warning visible", () => {
    renderForm({ cofheConnected: false });
    expect(
      screen.getByText("Connecting to encryption engine..."),
    ).toBeInTheDocument();
  });

  it("cofheConnected=true -> NO warning", () => {
    renderForm({ cofheConnected: true });
    expect(
      screen.queryByText("Connecting to encryption engine..."),
    ).toBeNull();
  });

  it("cofheConnected omitted -> NO warning (only the explicit false triggers it)", () => {
    renderForm();
    expect(
      screen.queryByText("Connecting to encryption engine..."),
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Send button + disabled-reason hint
// ───────────────────────────────────────────────────────────

describe("SendForm — send button + disabled reasons (§15.x)", () => {
  it("'Encrypt & Send' button label", () => {
    renderForm();
    expect(screen.getByText("Encrypt & Send")).toBeInTheDocument();
  });

  it("disabled when canProceed=false", () => {
    renderForm({ canProceed: false });
    const btn = screen.getByText("Encrypt & Send").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("disabled when address is invalid even if canProceed=true", () => {
    renderForm({ canProceed: true, recipient: "0xinvalid" });
    const btn = screen.getByText("Encrypt & Send").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("enabled when canProceed=true AND address is valid", () => {
    renderForm({ canProceed: true, recipient: ALICE, amount: "10" });
    const btn = screen.getByText("Encrypt & Send").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("click -> onSend fires when enabled", () => {
    const { onSend } = renderForm({ canProceed: true, recipient: ALICE, amount: "10" });
    fireEvent.click(screen.getByText("Encrypt & Send"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disabledReason hint: empty recipient -> 'Enter recipient address'", () => {
    renderForm({ recipient: "", amount: "10" });
    expect(screen.getByText("Enter recipient address")).toBeInTheDocument();
  });

  it("disabledReason hint: invalid recipient -> 'Invalid Ethereum address'", () => {
    renderForm({ recipient: "0xbad", amount: "10" });
    // Both the inline alert AND the disabled-reason hint render the message
    expect(screen.getAllByText("Invalid Ethereum address").length).toBeGreaterThanOrEqual(1);
  });

  it("disabledReason hint: empty amount -> 'Enter amount'", () => {
    renderForm({ recipient: ALICE, amount: "" });
    expect(screen.getByText("Enter amount")).toBeInTheDocument();
  });

  it("disabledReason hint: zero amount -> 'Enter amount' (parseFloat <= 0)", () => {
    renderForm({ recipient: ALICE, amount: "0" });
    expect(screen.getByText("Enter amount")).toBeInTheDocument();
  });

  it("disabledReason hint hidden when all fields valid", () => {
    renderForm({ canProceed: true, recipient: ALICE, amount: "10" });
    expect(screen.queryByText("Enter recipient address")).toBeNull();
    expect(screen.queryByText("Enter amount")).toBeNull();
  });
});
