import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for CreateClaimLink screen. Third sibling in the
// Wave 4 producer triad (CreateCampaign + CreateListing +
// CreateClaimLink). Unlike its siblings, this screen does NOT
// build the share URL locally; the hook returns
// `state.shareableUrl` directly (the secret is hook-owned). So
// the test pins the dispatch shape per mode + the validation
// cascade, not a URL contract.
//
// CRITICAL pins:
//   - 3-mode discriminated dispatch: Bearer -> {mode}; EmailBound
//     -> {mode, email}; AddressBound -> {mode, boundAddress}.
//     The discriminated union shape is the contract with
//     useClaimLinks; a refactor that flattens it (always passes
//     all fields) would break hook validation.
//   - default mode = EmailBound (the most common case; pin so a
//     refactor doesn't change the default and surprise users).
//   - validation cascade per mode: amount checked FIRST, then
//     mode-specific second-factor. EmailBound uses a deliberately
//     LAX check (email.indexOf("@") < 1, accepts "a@" with no
//     domain) because real validation happens at claim time via
//     EIP-712 signature. AddressBound uses isAddress (strict).
//   - amount sanitizer (ninth independent enforcement of precision-
//     input contract).
//   - mode-conditional fields: Bearer renders no second-factor
//     field at all; EmailBound shows email; AddressBound shows
//     wallet-address input.
//   - success state shareableUrl comes from the HOOK (not built
//     locally) -- distinguishes this screen from Campaign/Listing
//     which compute their URL from chainId + lastId.
//   - expiry computation: "Expires <new Date(now + expirySeconds *
//     1000).toLocaleString()>" so a user picks 7 days at submit
//     time and sees the absolute expiry timestamp.

const useChainMock = vi.hoisted(() => vi.fn());
const useClaimLinksMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const isAddressMock = vi.hoisted(() => vi.fn());
const getEnsAddressMock = vi.hoisted(() => vi.fn());

vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useClaimLinks", () => ({ useClaimLinks: useClaimLinksMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/claim-links", () => ({
  MODE: { Bearer: 0, EmailBound: 1, AddressBound: 2 },
  buildClaimUrl: vi.fn((args: { chainId: number; linkId: number | string; mode: number; secret: string }) =>
    `https://test.app/claim/${args.chainId}/${args.linkId}#${args.mode}:${args.secret}`,
  ),
}));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
// §1.14 C7: ENS resolution via mainnet client. Mock the ensClient so
// tests don't make real RPC calls; specific test cases override
// getEnsAddressMock per case.
vi.mock("@/lib/ens-client", () => ({
  ensClient: { getEnsAddress: getEnsAddressMock },
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));
vi.mock("viem", () => ({
  isAddress: isAddressMock,
}));

import CreateClaimLink from "./CreateClaimLink";

const VAULT_USDC = "0xfffffffffffffffffffffffffffffffffffffff1";
const VALID_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHARE_URL = "https://www.myblank.app/claim/11155111/42#e:0xdeadbeef";

let createLinkMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let writeTextMock: ReturnType<typeof vi.fn>;

let finishFundingMock: ReturnType<typeof vi.fn>;
let cancelPendingMock: ReturnType<typeof vi.fn>;
let fetchSentLinksMock: ReturnType<typeof vi.fn>;
let fetchLinkMock: ReturnType<typeof vi.fn>;

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "funding" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  shareableUrl: string | null;
  pipelinePhase: string;
  funding: "active" | "pending" | "void" | null;
  linkId: number | null;
}> = {}) {
  useClaimLinksMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
      shareableUrl: overrides.shareableUrl ?? null,
      funding: overrides.funding ?? null,
      linkId: overrides.linkId ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    createLink: createLinkMock,
    reset: resetMock,
    // §1.15 B3 — sent-links surface. Default mocks return empty so the
    // "Your sent links" empty-state shows.
    refund: vi.fn().mockResolvedValue(true),
    finishFunding: finishFundingMock,
    cancelPending: cancelPendingMock,
    fetchSentLinks: fetchSentLinksMock,
    fetchLink: fetchLinkMock,
  });
}

beforeEach(() => {
  useChainMock.mockReset();
  useClaimLinksMock.mockReset();
  useEffectiveAddressMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  isAddressMock.mockReset();
  getEnsAddressMock.mockReset();

  useChainMock.mockReturnValue({
    contracts: { FHERC20Vault_USDC: VAULT_USDC, ClaimLinks: "0x0000000000000000000000000000000000000099" },
    activeChainId: 11155111,
    activeChain: { name: "Ethereum Sepolia", explorerUrl: "https://sepolia.etherscan.io" },
  });
  // Default: no connected wallet -> "Your sent links" section hides.
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });

  createLinkMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  finishFundingMock = vi.fn().mockResolvedValue("funded");
  cancelPendingMock = vi.fn().mockResolvedValue(true);
  fetchSentLinksMock = vi.fn().mockResolvedValue([]);
  fetchLinkMock = vi.fn().mockResolvedValue(null);
  setHook();

  // Default: isAddress matches the standard 40-hex pattern.
  isAddressMock.mockImplementation((v: string) => /^0x[a-fA-F0-9]{40}$/.test(v));
  // Default ENS lookup returns null (no name resolves) so specific
  // tests can opt in by overriding getEnsAddressMock per case.
  getEnsAddressMock.mockResolvedValue(null);

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

describe("CreateClaimLink — page chrome (§15.x)", () => {
  it("renders 'Send by link' heading + 'Encrypted. Refundable if unclaimed' framing", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Send by link");
    expect(container.textContent).toContain("Encrypted");
    expect(container.textContent).toContain("Refundable if unclaimed");
  });

  it("renders 3 mode pills: Anyone / Email / Address", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Anyone");
    expect(container.textContent).toContain("Email");
    expect(container.textContent).toContain("Address");
  });

  it("CRITICAL default mode = EmailBound (Email pill aria-pressed=true, marked 'Default')", () => {
    const { container } = render(<CreateClaimLink />);
    const emailPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Email") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    expect(emailPill.getAttribute("aria-pressed")).toBe("true");
    expect(emailPill.textContent).toContain("Default");
  });

  it("submit button reads 'Create link' at rest", () => {
    const { getByText } = render(<CreateClaimLink />);
    expect(getByText("Create link")).toBeDefined();
  });
});

describe("CreateClaimLink — mode-pill switching + conditional fields (§15.x)", () => {
  it("default EmailBound: shows 'Recipient email' input (alice@example.com placeholder)", () => {
    const { queryByPlaceholderText } = render(<CreateClaimLink />);
    expect(queryByPlaceholderText("alice@example.com")).not.toBeNull();
  });

  it("clicking 'Anyone' (Bearer) HIDES both email and address fields", () => {
    const { container, queryByPlaceholderText } = render(<CreateClaimLink />);
    const bearerPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Anyone") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(bearerPill);
    expect(queryByPlaceholderText("alice@example.com")).toBeNull();
    expect(queryByPlaceholderText("0x… or alice.eth")).toBeNull();
  });

  it("clicking 'Address' (AddressBound) reveals address input + hides email input", () => {
    const { container, queryByPlaceholderText } = render(<CreateClaimLink />);
    const addrPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Address") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(addrPill);
    expect(queryByPlaceholderText("0x… or alice.eth")).not.toBeNull();
    expect(queryByPlaceholderText("alice@example.com")).toBeNull();
  });

  it("switching modes preserves the amount + note state (state lives in the parent)", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "25" } });
    fireEvent.change(getByPlaceholderText("Lunch tab"), { target: { value: "rent" } });
    const bearerPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Anyone") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(bearerPill);
    expect((getByPlaceholderText("10.00") as HTMLInputElement).value).toBe("25");
    expect((getByPlaceholderText("Lunch tab") as HTMLInputElement).value).toBe("rent");
  });
});

describe("CreateClaimLink — validation cascade (§15.x)", () => {
  it("amount empty -> 'Enter an amount above zero' (cascade ROOT)", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Enter an amount above zero");
  });

  it("amount = 0 -> still 'Enter an amount above zero'", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "0" } });
    expect(container.textContent).toContain("Enter an amount above zero");
  });

  it("CRITICAL cascade priority: empty-amount wins over empty-email (amount checked FIRST)", () => {
    const { container } = render(<CreateClaimLink />);
    // Default mode is EmailBound; both amount AND email are empty.
    expect(container.textContent).toContain("Enter an amount above zero");
    expect(container.textContent).not.toContain("Enter a valid email");
  });

  it("EmailBound + valid amount + empty email -> 'Enter a valid email'", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("§1.14 C12: 'a@' REJECTED by the tighter regex (no domain after the @)", () => {
    // Audit-fix update: the prior lax check (`indexOf("@") < 1`) accepted
    // "a@" because the @ was at index 1. The new regex
    // /^[^\s@]+@[^\s@]+\.[^\s@]+$/ requires a non-empty domain with a
    // dot, rejecting "a@" + "@b" + "a@b" (no TLD).
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "a@" } });
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("§1.14 C12: 'a@b' (no TLD) REJECTED — regex requires the dot", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "a@b" } });
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("§1.14 C12: 'alice@example.com' ACCEPTED", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), {
      target: { value: "alice@example.com" },
    });
    expect(container.textContent).not.toContain("Enter a valid email");
  });

  it("EmailBound rejects email with leading '@' (indexOf returns 0, fails < 1 check)", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "@example.com" } });
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("EmailBound rejects email with NO '@' (indexOf returns -1)", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "not-an-email" } });
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("AddressBound + invalid hex -> 'Enter a valid address' (isAddress mock returns false)", () => {
    const { container, getByPlaceholderText } = render(<CreateClaimLink />);
    const addrPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Address") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(addrPill);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("0x… or alice.eth"), { target: { value: "garbage" } });
    expect(container.textContent).toContain("Enter a valid address");
  });

  it("AddressBound + valid hex -> validation cleared (isAddress mock returns true)", () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateClaimLink />);
    const addrPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Address") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(addrPill);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("0x… or alice.eth"), { target: { value: VALID_ADDR } });
    expect(container.textContent).not.toContain("Enter a valid address");
    const btn = getByText("Create link").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("Bearer mode skips second-factor validation entirely (amount alone is enough)", () => {
    const { container, getByText } = render(<CreateClaimLink />);
    const bearerPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Anyone") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(bearerPill);
    fireEvent.change(container.querySelector("input[placeholder='10.00']") as HTMLInputElement, {
      target: { value: "10" },
    });
    expect(container.textContent).not.toContain("Enter a valid email");
    expect(container.textContent).not.toContain("Enter a valid address");
    const btn = getByText("Create link").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("CreateClaimLink — amount sanitizer (§15.x)", () => {
  it("strips non-numeric (ninth independent enforcement of precision-input contract)", () => {
    const { getByPlaceholderText } = render(<CreateClaimLink />);
    const input = getByPlaceholderText("10.00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc12.34$" } });
    expect(input.value).toBe("12.34");
  });
});

describe("CreateClaimLink — expiry picker (§15.x)", () => {
  it("3 preset buttons: 1 day / 7 days / 30 days + 'refund yourself' footnote", () => {
    const { getByText, container } = render(<CreateClaimLink />);
    expect(getByText("1 day")).toBeDefined();
    expect(getByText("7 days")).toBeDefined();
    expect(getByText("30 days")).toBeDefined();
    expect(container.textContent).toContain("If unclaimed by then, you can refund yourself");
  });

  it("default expiry = 7 days (EXPIRY_OPTIONS[1])", () => {
    const { getByText } = render(<CreateClaimLink />);
    expect(getByText("7 days").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("1 day").getAttribute("aria-pressed")).toBe("false");
    expect(getByText("30 days").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking '30 days' switches active preset", () => {
    const { getByText } = render(<CreateClaimLink />);
    fireEvent.click(getByText("30 days"));
    expect(getByText("30 days").getAttribute("aria-pressed")).toBe("true");
    expect(getByText("7 days").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("CreateClaimLink — handleCreate discriminated dispatch (§15.x)", () => {
  it("CRITICAL Bearer dispatch: input = { mode: Bearer } ONLY (no email, no boundAddress)", async () => {
    const { container, getByText } = render(<CreateClaimLink />);
    const bearerPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Anyone") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(bearerPill);
    fireEvent.change(container.querySelector("input[placeholder='10.00']") as HTMLInputElement, {
      target: { value: "10" },
    });
    await act(async () => {
      fireEvent.click(getByText("Create link"));
      await Promise.resolve();
    });
    const arg = createLinkMock.mock.calls[0][0];
    expect(arg.input).toEqual({ mode: 0 }); // Bearer
    expect(arg.input.email).toBeUndefined();
    expect(arg.input.boundAddress).toBeUndefined();
  });

  it("CRITICAL EmailBound dispatch: input = { mode: EmailBound, email }", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "alice@example.com" } });
    await act(async () => {
      fireEvent.click(getByText("Create link"));
      await Promise.resolve();
    });
    expect(createLinkMock.mock.calls[0][0].input).toEqual({
      mode: 1, // EmailBound
      email: "alice@example.com",
    });
  });

  it("CRITICAL AddressBound dispatch: input = { mode: AddressBound, boundAddress }", async () => {
    const { container, getByPlaceholderText, getByText } = render(<CreateClaimLink />);
    const addrPill = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Address") && b.hasAttribute("aria-pressed")) as HTMLButtonElement;
    fireEvent.click(addrPill);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "10" } });
    fireEvent.change(getByPlaceholderText("0x… or alice.eth"), { target: { value: VALID_ADDR } });
    await act(async () => {
      fireEvent.click(getByText("Create link"));
      await Promise.resolve();
    });
    expect(createLinkMock.mock.calls[0][0].input).toEqual({
      mode: 2, // AddressBound
      boundAddress: VALID_ADDR,
    });
  });

  it("createLink dispatch includes vault + amountTokens + decimals=6 + note + expirySeconds", async () => {
    const { getByPlaceholderText, getByText } = render(<CreateClaimLink />);
    fireEvent.change(getByPlaceholderText("10.00"), { target: { value: "5.50" } });
    fireEvent.change(getByPlaceholderText("alice@example.com"), { target: { value: "alice@example.com" } });
    fireEvent.change(getByPlaceholderText("Lunch tab"), { target: { value: "for coffee" } });
    fireEvent.click(getByText("30 days"));
    await act(async () => {
      fireEvent.click(getByText("Create link"));
      await Promise.resolve();
    });
    const arg = createLinkMock.mock.calls[0][0];
    expect(arg.vault).toBe(VAULT_USDC);
    expect(arg.amountTokens).toBe("5.50");
    expect(arg.decimals).toBe(6);
    expect(arg.note).toBe("for coffee");
    expect(arg.expirySeconds).toBe(30 * 86_400);
  });

  it("isProcessing -> 'Creating…' label + button disabled", () => {
    setHook({ isProcessing: true });
    const { getByText } = render(<CreateClaimLink />);
    const btn = getByText("Creating…").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("CreateClaimLink — pipeline + error (§15.x)", () => {
  it("pipeline.phase !== 'idle' renders FhePipelineProgress", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<CreateClaimLink />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("state.error renders inline (not silent)", () => {
    setHook({ error: "Vault not approved" });
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Vault not approved");
  });
});

describe("CreateClaimLink — success state (§15.x)", () => {
  beforeEach(() => {
    setHook({ step: "success", shareableUrl: SHARE_URL });
  });

  it("CRITICAL: shareableUrl comes from HOOK (state.shareableUrl), NOT computed locally (distinct from Campaign/Listing)", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain(SHARE_URL);
  });

  it("renders 'Link ready' headline + 'amount stays encrypted until they claim it' copy", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Link ready");
    expect(container.textContent).toContain("amount stays encrypted until they claim it");
  });

  it("Copy link click writes shareableUrl to clipboard + 'Link copied' toast", async () => {
    const { getByText } = render(<CreateClaimLink />);
    await act(async () => {
      fireEvent.click(getByText("Copy link"));
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(SHARE_URL);
    expect(toastSuccessMock).toHaveBeenCalledWith("Link copied");
  });

  it("renders 'Expires <date>' footnote with refund reassurance", () => {
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).toContain("Expires");
    expect(container.textContent).toContain("If unclaimed, you can refund");
  });

  it("'Create another link' click calls reset", () => {
    const { getByText } = render(<CreateClaimLink />);
    fireEvent.click(getByText("Create another link"));
    expect(resetMock).toHaveBeenCalled();
  });

  it("success state with NULL shareableUrl falls through to FORM (defensive)", () => {
    setHook({ step: "success", shareableUrl: null });
    const { container } = render(<CreateClaimLink />);
    expect(container.textContent).not.toContain("Link ready");
    expect(container.textContent).toContain("Send by link");
  });
});

// ───────────────────────────────────────────────────────────
//  Funding gate: a link is only shareable once its funding check passed
// ───────────────────────────────────────────────────────────

describe("CreateClaimLink: funding gate", () => {
  it("pending: withholds the share URL, explains why, and offers Finish and Cancel", async () => {
    setHook({ step: "success", shareableUrl: SHARE_URL, funding: "pending", linkId: 42 });
    const { findByTestId, queryByTestId, queryByText, findByText, container } = render(<CreateClaimLink />);
    await findByTestId("claim-link-pending");
    expect(container.textContent).toContain("Confirming funding");
    expect(container.textContent).toContain("Link #42");
    expect(container.textContent).toContain("Keep this tab open");
    // The URL and its copy button must not exist until the link is claimable.
    expect(queryByTestId("claim-link-share-url")).toBeNull();
    expect(container.textContent).not.toContain(SHARE_URL);
    expect(queryByText("Copy link")).toBeNull();
    await act(async () => { fireEvent.click(await findByText("Finish funding")); });
    expect(finishFundingMock).toHaveBeenCalledWith(42);
    await act(async () => { fireEvent.click(await findByText("Cancel this link")); });
    expect(cancelPendingMock).toHaveBeenCalledWith(42);
  });

  it("pending: stays on the pending screen while the finish runs, with a disabled button", async () => {
    setHook({ step: "funding", isProcessing: true, shareableUrl: SHARE_URL, funding: "pending", linkId: 42 });
    const { findByTestId, findByText } = render(<CreateClaimLink />);
    await findByTestId("claim-link-pending");
    expect(((await findByText("Finish funding")).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("pending: a failed finish attempt shows its reason on the pending screen", async () => {
    setHook({
      step: "success",
      shareableUrl: SHARE_URL,
      funding: "pending",
      linkId: 42,
      error: "Link #42 was created but its funding is not confirmed (the funding check is not ready yet).",
    });
    const { findByText } = render(<CreateClaimLink />);
    await findByText(/funding check is not ready yet/);
  });

  it("funded: shows the share URL and the copy button", async () => {
    setHook({ step: "success", shareableUrl: SHARE_URL, funding: "active", linkId: 42 });
    const { findByTestId, findByText } = render(<CreateClaimLink />);
    expect((await findByTestId("claim-link-share-url")).textContent).toBe(SHARE_URL);
    await findByText("Copy link");
  });

  it("creating: the button says 'Confirming funding…' during the check", async () => {
    setHook({ step: "funding", isProcessing: true });
    const { findByText } = render(<CreateClaimLink />);
    await findByText("Confirming funding…");
  });

  it("unfunded: back on the form with the error, and no share URL", async () => {
    setHook({
      step: "error",
      shareableUrl: null,
      funding: "void",
      linkId: 42,
      error: "The link was not funded: your private balance was too low. Nothing was locked.",
    });
    const { findByText, queryByTestId } = render(<CreateClaimLink />);
    await findByText(/Nothing was locked/);
    expect(queryByTestId("claim-link-share-url")).toBeNull();
  });

  describe("Your sent links", () => {
    const record = (id: bigint, funding: "active" | "pending" | "void") => ({
      id,
      sender: VALID_ADDR,
      vault: VAULT_USDC,
      mode: 0,
      boundAddress: "0x0000000000000000000000000000000000000000",
      createdAt: id,
      expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
      claimed: false,
      refunded: false,
      note: `note ${id}`,
      claimer: "0x0000000000000000000000000000000000000000",
      claimedAt: 0n,
      legacy: false,
      legacyRefundOnly: false,
      funding,
    });

    beforeEach(() => {
      useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VALID_ADDR });
      fetchSentLinksMock.mockResolvedValue([1n, 2n, 3n]);
      fetchLinkMock.mockImplementation(async (id: bigint) =>
        record(id, id === 1n ? "pending" : id === 2n ? "void" : "active"),
      );
    });

    it("pending shows 'funding' with Finish and Cancel; void shows 'not funded'; neither can be copied or refunded", async () => {
      setHook();
      const { findByLabelText, findByText, queryByLabelText, container } = render(<CreateClaimLink />);
      await findByText("note 1");
      expect(container.textContent).toContain("funding");
      expect(container.textContent).toContain("not funded");
      expect(container.textContent).toContain("cancel this link and create a new one");
      expect(container.textContent).toContain("Nothing was locked");
      // Active link keeps its copy button; pending and void do not get one.
      await findByLabelText("Copy link 3");
      expect(queryByLabelText("Copy link 1")).toBeNull();
      expect(queryByLabelText("Copy link 2")).toBeNull();
      expect(queryByLabelText("Refund link 1")).toBeNull();
      expect(queryByLabelText("Refund link 2")).toBeNull();

      await act(async () => { fireEvent.click(await findByLabelText("Finish funding link 1")); });
      expect(finishFundingMock).toHaveBeenCalledWith(1);
      await act(async () => { fireEvent.click(await findByLabelText("Cancel pending link 1")); });
      expect(cancelPendingMock).toHaveBeenCalledWith(1);
    });
  });
});
