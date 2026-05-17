import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for ClaimLinkPage. The public Wave 4 deep-link
// landing for /claim/:chainId/:linkId#<mode>:<secret>. Pins:
//   - render-state PRIORITY: !parsed (missing #fragment) takes
//     precedence over loadError. The order matters: a missing
//     fragment is a more specific UX error (broken URL) than a
//     wrong linkId, and surfacing the wrong error first sends
//     the user looking at the wrong problem.
//   - 4-state status machine derived from on-chain fields:
//     claimed -> refunded -> expired -> claimable. The else-if
//     ordering means a single row never lands in two terminal
//     states.
//   - 5-branch load error: invalid chainId/linkId, unsupported
//     chain, zero contract address, sender===zero, RPC throw
//   - handleClaim validation: missing parsed -> toast; EmailBound
//     mode without email -> toast; else claim() called with the
//     fragment fields
//   - cancellation guard via `let cancelled = false` so a fast
//     unmount during the on-chain readContract does not setState
//     on an unmounted component
//   - MODE_LABEL renders the right copy per mode

const useParamsMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useClaimLinksMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const parseClaimUrlMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useParams: useParamsMock }));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useClaimLinks", () => ({ useClaimLinks: useClaimLinksMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/lib/claim-links", () => ({
  parseClaimUrl: parseClaimUrlMock,
  MODE: { Bearer: 0, EmailBound: 1, AddressBound: 2 },
}));
vi.mock("@/lib/constants", () => ({
  CONTRACTS_BY_CHAIN: {
    11155111: { ClaimLinks: "0x1111111111111111111111111111111111111111" },
    84532: { ClaimLinks: "0x2222222222222222222222222222222222222222" },
    // unsupported chain id 1 is intentionally absent from this map
    // (used by the unsupported-chain branch test).
    9999: { ClaimLinks: "0x0000000000000000000000000000000000000000" },
  },
}));
vi.mock("@/lib/abis", () => ({ ClaimLinksAbi: [] }));
vi.mock("@/components/payment/FhePipelineProgress", () => ({
  FhePipelineProgress: (props: { state: { phase: string } }) => (
    <div data-testid="fhe-pipeline-progress" data-phase={props.state.phase} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import ClaimLinkPage from "./ClaimLinkPage";

const SENDER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0x0000000000000000000000000000000000000000";

let readContractMock: ReturnType<typeof vi.fn>;
let claimMock: ReturnType<typeof vi.fn>;

function buildOnChainTuple(over: Partial<{
  sender: string;
  vault: string;
  mode: number;
  boundAddress: string;
  createdAt: bigint;
  expiryTimestamp: bigint;
  claimed: boolean;
  refunded: boolean;
  note: string;
  claimer: string;
  claimedAt: bigint;
}> = {}): readonly unknown[] {
  const o = {
    sender: SENDER,
    vault: VAULT,
    mode: 0,
    boundAddress: ZERO,
    createdAt: 1000n,
    expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
    claimed: false,
    refunded: false,
    note: "",
    claimer: ZERO,
    claimedAt: 0n,
    ...over,
  };
  return [
    o.sender, o.vault, o.mode, o.boundAddress, o.createdAt, o.expiryTimestamp,
    o.claimed, o.refunded, o.note, o.claimer, o.claimedAt,
  ];
}

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "claiming" | "success" | "error";
  isProcessing: boolean;
  error: string | null;
  pipelinePhase: string;
}> = {}) {
  useClaimLinksMock.mockReturnValue({
    state: {
      step: overrides.step ?? "idle",
      isProcessing: overrides.isProcessing ?? false,
      error: overrides.error ?? null,
    },
    pipeline: { phase: overrides.pipelinePhase ?? "idle" },
    claim: claimMock,
  });
}

beforeEach(() => {
  useParamsMock.mockReset();
  usePublicClientMock.mockReset();
  useClaimLinksMock.mockReset();
  useEffectiveAddressMock.mockReset();
  parseClaimUrlMock.mockReset();
  toastErrorMock.mockReset();

  useParamsMock.mockReturnValue({ chainId: "11155111", linkId: "42" });
  // Default: no connected wallet. Tests that need a specific viewer
  // address (AddressBound wrong-wallet check) override per case.
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });

  readContractMock = vi.fn().mockResolvedValue(buildOnChainTuple());
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });

  claimMock = vi.fn().mockResolvedValue(undefined);
  setHook();

  // Default: parseClaimUrl returns a valid Bearer fragment.
  parseClaimUrlMock.mockReturnValue({
    linkId: 42n,
    mode: 0, // Bearer
    secret: "0xdeadbeef",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaimLinkPage — !parsed PRIORITY error (§15.x)", () => {
  it("CRITICAL: missing #fragment renders 'Missing secret' BEFORE any loadError", async () => {
    parseClaimUrlMock.mockReturnValue(null);
    // Even with an invalid chain (would normally trigger loadError),
    // missing fragment takes precedence per the source comment.
    useParamsMock.mockReturnValue({ chainId: "not-a-number", linkId: "42" });
    const { container, findByText } = render(<ClaimLinkPage />);
    await findByText("Missing secret");
    expect(container.textContent).toContain("missing its secret part");
    expect(container.textContent).toContain("# at the end");
    expect(container.textContent).not.toContain("Invalid link");
  });
});

describe("ClaimLinkPage — load-error branches (§15.x)", () => {
  it("invalid chainId param (NaN) -> 'Invalid link'", async () => {
    useParamsMock.mockReturnValue({ chainId: "abc", linkId: "42" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Invalid link")).toBeDefined();
  });

  it("invalid linkId param -> 'Invalid link'", async () => {
    useParamsMock.mockReturnValue({ chainId: "11155111", linkId: "xyz" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Invalid link")).toBeDefined();
  });

  it("unsupported chain (chainId not in CONTRACTS_BY_CHAIN) -> 'Unsupported chain'", async () => {
    useParamsMock.mockReturnValue({ chainId: "1", linkId: "42" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Unsupported chain")).toBeDefined();
  });

  it("zero-address ClaimLinks contract -> 'Claim links not available on this chain yet'", async () => {
    useParamsMock.mockReturnValue({ chainId: "9999", linkId: "42" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Claim links not available on this chain yet")).toBeDefined();
  });

  it("on-chain sender = address(0) -> 'Link not found'", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ sender: ZERO }));
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Link not found")).toBeDefined();
  });

  it("readContract throws transient error (rate-limit) -> 'Network busy' headline + Retry CTA, raw err.message NOT in headline", async () => {
    // F1 fix: previously rendered "HTTPProviderError: 429 Too Many
    // Requests" as the full-page headline. Now classified as transient
    // with a retry CTA + raw message hidden behind a Details summary.
    readContractMock.mockRejectedValueOnce(new Error("HTTP 429 Too Many Requests"));
    const { findByText, container } = render(<ClaimLinkPage />);
    expect(await findByText("Network busy")).toBeDefined();
    expect(await findByText("Retry")).toBeDefined();
    // Headline must be the friendly classification, not the raw message.
    const headline = container.querySelector("h1");
    expect(headline?.textContent).toBe("Network busy");
    expect(headline?.textContent).not.toContain("429");
    // Raw cause preserved in the details element for debugging.
    expect(container.textContent).toContain("HTTP 429 Too Many Requests");
  });

  it("readContract throws permanent error (reverted) -> 'Link not found' headline + Go home CTA (no retry)", async () => {
    readContractMock.mockRejectedValueOnce(
      new Error("execution reverted: ClaimLinks: not found"),
    );
    const { findByText, queryByText } = render(<ClaimLinkPage />);
    expect(await findByText("Link not found")).toBeDefined();
    expect(await findByText("Go home")).toBeDefined();
    // No retry on permanent errors — retrying won't help.
    expect(queryByText("Retry")).toBeNull();
  });

  it("readContract throws unknown error -> defaults to transient (recoverable)", async () => {
    readContractMock.mockRejectedValueOnce("string rejection");
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Couldn't load")).toBeDefined();
    expect(await findByText("Retry")).toBeDefined();
  });

  it("Retry CTA bumps reloadKey and re-runs the on-chain read", async () => {
    readContractMock.mockRejectedValueOnce(new Error("429"));
    readContractMock.mockResolvedValueOnce(buildOnChainTuple());
    const { findByText } = render(<ClaimLinkPage />);
    await findByText("Network busy");
    const retryBtn = await findByText("Retry");
    await act(async () => {
      fireEvent.click(retryBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    // After retry, the page should render the successful claimable state.
    await findByText(/Claim private payment/);
  });
});

describe("ClaimLinkPage — status state machine (§15.x)", () => {
  it("claimed=true -> 'Already claimed' card", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ claimed: true }));
    const { findByText, container } = render(<ClaimLinkPage />);
    await findByText("Already claimed");
    expect(container.textContent).toContain("Each link can be used only once");
  });

  it("refunded=true -> 'Link refunded' card", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ refunded: true }));
    const { findByText, container } = render(<ClaimLinkPage />);
    await findByText("Link refunded");
    expect(container.textContent).toContain("sender pulled the funds back");
  });

  it("expiryTimestamp in past -> 'Link expired' card", async () => {
    readContractMock.mockResolvedValueOnce(
      buildOnChainTuple({ expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) - 1) }),
    );
    const { findByText, container } = render(<ClaimLinkPage />);
    await findByText("Link expired");
    expect(container.textContent).toContain("claim window passed");
  });

  it("CRITICAL else-if priority: claimed wins over refunded wins over expired", async () => {
    // Both claimed AND expired: should show "Already claimed" (claimed wins).
    readContractMock.mockResolvedValueOnce(
      buildOnChainTuple({
        claimed: true,
        expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) - 1),
      }),
    );
    const { findByText, container } = render(<ClaimLinkPage />);
    await findByText("Already claimed");
    expect(container.textContent).not.toContain("Link expired");
  });

  it("refunded wins over expired when both true", async () => {
    readContractMock.mockResolvedValueOnce(
      buildOnChainTuple({
        refunded: true,
        expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) - 1),
      }),
    );
    const { findByText, container } = render(<ClaimLinkPage />);
    await findByText("Link refunded");
    expect(container.textContent).not.toContain("Link expired");
  });

  it("happy-path claimable state shows 'Claim private payment' button", async () => {
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Claim private payment")).toBeDefined();
  });
});

describe("ClaimLinkPage — mode labels (§15.x)", () => {
  it("Bearer mode renders 'Open link. Anyone can claim' label", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 0, secret: "0xabc" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Open link. Anyone can claim")).toBeDefined();
  });

  it("EmailBound mode renders 'Email-protected link' label", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 1, secret: "0xabc" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Email-protected link")).toBeDefined();
  });

  it("AddressBound mode renders 'Address-protected link' label", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 2, secret: "0xabc" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Address-protected link")).toBeDefined();
  });
});

describe("ClaimLinkPage — handleClaim flow (§15.x)", () => {
  it("Bearer mode click Claim -> calls claim({linkId, mode, secret}) with no email", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 0, secret: "0xdeadbeef" });
    const { findByText } = render(<ClaimLinkPage />);
    const btn = await findByText("Claim private payment");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(claimMock).toHaveBeenCalled();
    const arg = claimMock.mock.calls[0][0];
    expect(arg.linkId).toBe(42n);
    expect(arg.mode).toBe(0);
    expect(arg.secret).toBe("0xdeadbeef");
    expect(arg.email).toBeUndefined();
  });

  it("EmailBound mode without email -> toast 'Enter your email' + claim NOT called", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 1, secret: "0xabc" });
    const { findByText } = render(<ClaimLinkPage />);
    const btn = await findByText("Claim private payment");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter your email to claim");
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("EmailBound mode WITH email -> claim called with email field", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 1, secret: "0xabc" });
    const { findByText, findByPlaceholderText } = render(<ClaimLinkPage />);
    const emailInput = await findByPlaceholderText("you@example.com") as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "alice@example.com" } });
    await act(async () => {
      fireEvent.click(await findByText("Claim private payment"));
      await Promise.resolve();
    });
    expect(claimMock).toHaveBeenCalled();
    expect(claimMock.mock.calls[0][0].email).toBe("alice@example.com");
  });

  it("Bearer mode: email input HIDDEN (no Mail field)", async () => {
    parseClaimUrlMock.mockReturnValue({ linkId: 42n, mode: 0, secret: "0xabc" });
    const { findByText, queryByPlaceholderText } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    expect(queryByPlaceholderText("you@example.com")).toBeNull();
  });
});

describe("ClaimLinkPage — claim state + pipeline progress (§15.x)", () => {
  it("state.isProcessing -> 'Claiming…' label + button disabled", async () => {
    setHook({ isProcessing: true });
    const { findByText } = render(<ClaimLinkPage />);
    const btn = (await findByText("Claiming…")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("state.error renders inline (NOT silent)", async () => {
    setHook({ error: "Insufficient gas" });
    const { findByText } = render(<ClaimLinkPage />);
    expect(await findByText("Insufficient gas")).toBeDefined();
  });

  it("pipeline.phase !== 'idle' renders FhePipelineProgress", async () => {
    setHook({ pipelinePhase: "encrypting" });
    const { findByTestId } = render(<ClaimLinkPage />);
    const pipe = await findByTestId("fhe-pipeline-progress");
    expect(pipe.getAttribute("data-phase")).toBe("encrypting");
  });

  it("pipeline.phase === 'idle' HIDES FhePipelineProgress", async () => {
    setHook({ pipelinePhase: "idle" });
    const { findByText, queryByTestId } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    expect(queryByTestId("fhe-pipeline-progress")).toBeNull();
  });

  it("state.step === 'success' shows 'Claimed' card + 'Open Blank' deep link to /app", async () => {
    setHook({ step: "success" });
    const { findByText } = render(<ClaimLinkPage />);
    await findByText("Claimed");
    const link = (await findByText("Open Blank")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/app");
  });
});

describe("ClaimLinkPage — note + sender preview (§15.x)", () => {
  it("renders sender's truncated address with mid-ellipsis", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ sender: SENDER }));
    const { container, findByText } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    // Source format: sender.slice(0,6) + "…" + sender.slice(-4) -> "0xaaaa…aaaa"
    expect(container.textContent).toMatch(/0xaaaa.{1,3}aaaa/i);
  });

  it("renders quoted note when present", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ note: "for coffee" }));
    const { container, findByText } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    expect(container.textContent).toContain('"for coffee"');
  });

  it("HIDES note section when note is empty string", async () => {
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ note: "" }));
    const { container, findByText } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    // No bare quote-quote substring in display.
    expect(container.textContent).not.toContain('""');
  });

  it("renders Expires <localized date> at the bottom", async () => {
    const future = BigInt(Math.floor(Date.now() / 1000) + 86400 * 7);
    readContractMock.mockResolvedValueOnce(buildOnChainTuple({ expiryTimestamp: future }));
    const { container, findByText } = render(<ClaimLinkPage />);
    await findByText("Claim private payment");
    expect(container.textContent).toMatch(/Expires .+/);
  });
});

describe("ClaimLinkPage — cancellation guard (§15.x)", () => {
  it("CRITICAL: unmount during pending readContract does NOT setState on unmounted component", async () => {
    let resolveRead!: (v: unknown) => void;
    readContractMock.mockReturnValue(
      new Promise((res) => { resolveRead = res; }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<ClaimLinkPage />);
    unmount();

    await act(async () => {
      resolveRead(buildOnChainTuple());
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((c) => c.includes("unmounted component"))).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});

describe("ClaimLinkPage — loading skeleton (§15.x)", () => {
  it("publicClient pending (no result yet) -> shows 'Loading link…' state", async () => {
    readContractMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<ClaimLinkPage />);
    await waitFor(() => {
      expect(container.textContent).toContain("Loading link");
    });
  });

  it("no publicClient -> stays in loading state (no crash)", async () => {
    usePublicClientMock.mockReturnValue(undefined);
    const { container } = render(<ClaimLinkPage />);
    await waitFor(() => {
      expect(container.textContent).toContain("Loading link");
    });
  });
});
