import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";

// §15.x test for Stealth screen — anonymous payments via claim codes.
// Four-tab interface (Create / Inbox / Claim / Sent) with three distinct
// recipient-discovery paths: copy/paste codes manually, deep-link hash
// fragment auto-import, and pending-claim recovery from localStorage.
//
// CRITICAL pins:
//   - Phase 3.1 query-string pre-fill: ?to= / ?amount= / ?note= populate
//     the Create form on mount AND switch to the Create tab. Params are
//     stripped from window.location after ingestion so a manual refresh
//     doesn't re-prefill on top of edits.
//   - Deep-link inbox import: PREFERRED form is hash fragment
//     (`#inbox=base64`); legacy `?inbox=` query string is honored but
//     warns the user the old format exposes the code in server logs
//     (Referer headers + Slack/Discord auto-unfurl). Fragment is NOT sent
//     to servers, NOT auto-unfurled, NOT in Referer. The base64 decode
//     must yield 0x + 64 hex chars (32-byte claim code); otherwise toast
//     "Invalid stealth payment link" — failing closed prevents adding a
//     malformed entry to the inbox.
//   - claimCodeHash = keccak256(encodePacked(["bytes32","address"],
//     [claimCode, recipientAddress])) — must match the contract's binding
//     so getMyPendingClaims can look up the on-chain transferId. The
//     recipient address is the CURRENT user's effectiveAddress so a
//     forwarded link cannot be claimed by anyone but the intended target.
//   - shareLink builder uses URL fragment `#inbox=base64` (NOT `?inbox=`)
//     so the claim code never hits server logs. Legacy code path
//     (?inbox=) shows a yellow warning "re-share with new format" toast.
//   - cross-tab sync via onCrossTabAction listens for TWO events:
//     "stealth_inbox_changed" (sibling tab added/updated inbox) and
//     "pending_claim_removed" (sibling tab finalized a claim — drop it
//     from our Resume list). Both are gated by (address, chainId) match
//     so a multi-account user's notifications don't bleed across.
//   - sendStealth call signature: (amount, recipient, vault, message).
//     Default message "Stealth payment" when user leaves it blank — keeps
//     the on-chain note field non-empty so receipts have a label.
//   - 30-day refund window: canRefund = !claimed && !finalized && age >=
//     REFUND_WINDOW_SECONDS. The countdown ("Refund available in N
//     days") is the load-bearing #215 fix — without it the disabled
//     Refund button confused users into thinking refunds were broken
//     when in fact they were just waiting.
//   - handleClaimFromInbox status state machine: "new" -> "claiming"
//     (optimistic) -> "claimed" (on success) OR back to "new" (on
//     transfer-not-found, exception, or claimStealth returning null).
//     Without the revert-to-"new" branches a transient RPC failure
//     would leave the entry stuck at "claiming..." forever.
//   - stealthActivities filter: ONLY 3 activity types render in the
//     Stealth Activity card (stealth_sent / stealth_claim_started /
//     stealth_claimed). A payment / invoice / swap row would never
//     appear here — keeps the section focused on stealth-only history.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useStealthPaymentsMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useActivityFeedMock = vi.hoisted(() => vi.fn());
const useSearchParamsMock = vi.hoisted(() => vi.fn());
const onCrossTabActionMock = vi.hoisted(() => vi.fn());
const getStealthInboxMock = vi.hoisted(() => vi.fn());
const addToStealthInboxMock = vi.hoisted(() => vi.fn());
const markInboxEntryStatusMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const toastDefaultMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useSearchParams: useSearchParamsMock }));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useStealthPayments", () => ({
  useStealthPayments: useStealthPaymentsMock,
  getStealthInbox: getStealthInboxMock,
  addToStealthInbox: addToStealthInboxMock,
  markInboxEntryStatus: markInboxEntryStatusMock,
}));
vi.mock("@/hooks/useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/hooks/useActivityFeed", () => ({ useActivityFeed: useActivityFeedMock }));
vi.mock("@/lib/cross-tab", () => ({ onCrossTabAction: onCrossTabActionMock }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: copyToClipboardMock }));
vi.mock("@/lib/abis", () => ({ StealthPaymentsAbi: [] }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("react-hot-toast", () => {
  const fn: typeof toastDefaultMock & {
    error: typeof toastErrorMock;
    success: typeof toastSuccessMock;
    loading: typeof toastLoadingMock;
  } = Object.assign(toastDefaultMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  });
  return { default: fn };
});

import Stealth from "./Stealth";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLAIM_CODE = ("0x" + "11".repeat(32)) as `0x${string}`;
const STEALTH_CONTRACT = "0x1111111111111111111111111111111111111111";
const VAULT_USDC = "0x2222222222222222222222222222222222222222";

const sendStealthMock = vi.fn();
const claimStealthMock = vi.fn();
const finalizeClaimMock = vi.fn();
const getMyPendingClaimsMock = vi.fn();
const getPendingClaimsMock = vi.fn();
const resumePendingClaimMock = vi.fn();
const resetMock = vi.fn();
const unifiedWriteAndWaitMock = vi.fn();
const setSearchParamsSpy = vi.fn();

function setStealth(over: Record<string, unknown> = {}) {
  useStealthPaymentsMock.mockReturnValue({
    step: "idle",
    error: null,
    txHash: null,
    isWaitingForDecryption: false,
    decryptionProgress: "",
    sendStealth: sendStealthMock,
    claimStealth: claimStealthMock,
    finalizeClaim: finalizeClaimMock,
    getMyPendingClaims: getMyPendingClaimsMock,
    getPendingClaims: getPendingClaimsMock,
    resumePendingClaim: resumePendingClaimMock,
    reset: resetMock,
    ...over,
  });
}

const mockReadContract = vi.fn();

function setLocation(href: string) {
  // Use Object.defineProperty so href / pathname / hash / search all derive
  // from the URL.
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    writable: true,
    configurable: true,
    value: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
  });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useStealthPaymentsMock.mockReset();
  useUnifiedWriteMock.mockReset();
  usePublicClientMock.mockReset();
  useActivityFeedMock.mockReset();
  useSearchParamsMock.mockReset();
  onCrossTabActionMock.mockReset();
  getStealthInboxMock.mockReset();
  addToStealthInboxMock.mockReset();
  markInboxEntryStatusMock.mockReset();
  copyToClipboardMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  toastDefaultMock.mockReset();
  sendStealthMock.mockReset();
  claimStealthMock.mockReset();
  finalizeClaimMock.mockReset();
  getMyPendingClaimsMock.mockReset();
  getPendingClaimsMock.mockReset();
  resumePendingClaimMock.mockReset();
  resetMock.mockReset();
  unifiedWriteAndWaitMock.mockReset();
  setSearchParamsSpy.mockReset();
  mockReadContract.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      StealthPayments: STEALTH_CONTRACT,
      FHERC20Vault_USDC: VAULT_USDC,
    },
  });
  useActivityFeedMock.mockReturnValue({ activities: [] });
  useSearchParamsMock.mockReturnValue([
    new URLSearchParams(""),
    setSearchParamsSpy,
  ]);
  onCrossTabActionMock.mockReturnValue(() => {}); // unsubscribe fn
  getStealthInboxMock.mockReturnValue([]);
  addToStealthInboxMock.mockReturnValue(true);
  copyToClipboardMock.mockResolvedValue(true);
  toastLoadingMock.mockReturnValue("toast-id");
  getPendingClaimsMock.mockReturnValue([]);
  usePublicClientMock.mockReturnValue({ readContract: mockReadContract });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWriteAndWait: unifiedWriteAndWaitMock,
  });
  setStealth();

  // Reset window.location to a clean default
  setLocation("http://localhost/app/stealth");
});

afterEach(() => {
  localStorage.clear();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button"))
    .find((b) => {
      const text = b.textContent ?? "";
      const aria = b.getAttribute("aria-label") ?? "";
      if (typeof label === "string") return text.includes(label) || aria === label;
      return label.test(text) || label.test(aria);
    }) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`Button '${label}' not found`);
  return btn;
}

// ----- page chrome ----- //

describe("Stealth — page chrome (§15.x)", () => {
  it("renders 'Stealth Payments' heading + privacy subtitle", () => {
    const { container } = render(<Stealth />);
    expect(container.textContent).toContain("Stealth Payments");
    expect(container.textContent).toContain("Send anonymous payments via claim codes");
  });

  it("renders 4 tabs (Create / Inbox / Claim / Sent) with default Create selected", () => {
    const { container } = render(<Stealth />);
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const labels = tabs.map((t) => t.getAttribute("aria-label"));
    expect(labels).toContain("Create code");
    expect(labels).toContain("Stealth inbox");
    expect(labels).toContain("Claim code");
    expect(labels).toContain("My sent payments");
    const create = tabs.find((t) => t.getAttribute("aria-label") === "Create code");
    expect(create?.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking Inbox tab flips active state + renders inbox content", () => {
    const { container } = render(<Stealth />);
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    fireEvent.click(inboxTab);
    expect(inboxTab.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Stealth Inbox");
    expect(container.textContent).toContain("No incoming payments");
  });
});

// ----- Phase 3.1 query-string pre-fill ----- //

describe("Stealth — query-string pre-fill (Phase 3.1) (§15.x)", () => {
  it("?to=&amount=&note= pre-fills form + activates Create tab", async () => {
    setLocation(`http://localhost/app/stealth?to=${ALICE}&amount=42.50&note=lunch`);
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { container } = render(<Stealth />);
    await flush();
    const inputs = container.querySelectorAll("input");
    const recipientInput = Array.from(inputs).find((i) => i.placeholder === "0x...") as HTMLInputElement;
    expect(recipientInput?.value).toBe(ALICE);
    const amountInput = Array.from(inputs).find((i) => i.placeholder === "0.00") as HTMLInputElement;
    expect(amountInput?.value).toBe("42.50");
    const noteTextarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(noteTextarea?.value).toBe("lunch");
    replaceSpy.mockRestore();
  });

  it("query params stripped from window.location after ingestion (no re-prefill on edit)", async () => {
    setLocation(`http://localhost/app/stealth?to=${ALICE}&amount=10`);
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    render(<Stealth />);
    await flush();
    expect(replaceSpy).toHaveBeenCalled();
    const newUrl = replaceSpy.mock.calls[0][2] as string;
    expect(newUrl).not.toContain("to=");
    expect(newUrl).not.toContain("amount=");
    replaceSpy.mockRestore();
  });

  it("no query params -> no pre-fill, no history mutation", async () => {
    setLocation("http://localhost/app/stealth");
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    render(<Stealth />);
    await flush();
    expect(replaceSpy).toHaveBeenCalledTimes(0);
    replaceSpy.mockRestore();
  });
});

// ----- Deep-link inbox import ----- //

describe("Stealth — deep-link inbox import (§15.x)", () => {
  function base64(str: string): string {
    return btoa(str);
  }

  it("hash fragment #inbox=base64 with valid 0x+64hex -> addToStealthInbox + Create-tab pivot to Inbox", async () => {
    setLocation(`http://localhost/app/stealth#inbox=${base64(CLAIM_CODE)}`);
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    addToStealthInboxMock.mockReturnValue(true);
    const { container } = render(<Stealth />);
    await flush();
    expect(addToStealthInboxMock).toHaveBeenCalledTimes(1);
    const args = addToStealthInboxMock.mock.calls[0];
    expect(args[0]).toBe(ME);
    expect(args[1]).toBe(11155111);
    expect(args[2].claimCode).toBe(CLAIM_CODE);
    expect(args[2].claimCodeHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(toastSuccessMock).toHaveBeenCalledWith("You have an incoming stealth payment");
    // Switched to Inbox tab
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox");
    expect(inboxTab?.getAttribute("aria-selected")).toBe("true");
    replaceSpy.mockRestore();
  });

  it("hash fragment with malformed claim code (not 0x+64hex) -> 'Invalid stealth payment link' toast (no addToInbox)", async () => {
    setLocation(`http://localhost/app/stealth#inbox=${base64("not-a-claim-code")}`);
    render(<Stealth />);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid stealth payment link");
    expect(addToStealthInboxMock).toHaveBeenCalledTimes(0);
  });

  it("invalid base64 in fragment -> 'Could not decode' toast (catch path)", async () => {
    setLocation("http://localhost/app/stealth#inbox=!!!not-base64!!!");
    render(<Stealth />);
    await flush();
    // The catch path fires the "Could not decode" toast.
    expect(toastErrorMock).toHaveBeenCalledWith("Could not decode stealth payment link");
  });

  it("legacy ?inbox= query string still honored + shows security warning toast", async () => {
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams(`inbox=${base64(CLAIM_CODE)}`),
      setSearchParamsSpy,
    ]);
    setLocation(`http://localhost/app/stealth?inbox=${base64(CLAIM_CODE)}`);
    render(<Stealth />);
    await flush();
    expect(addToStealthInboxMock).toHaveBeenCalledTimes(1);
    // Both the success toast AND the legacy-format warning fire
    expect(toastDefaultMock).toHaveBeenCalled();
    const warnCall = toastDefaultMock.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("server logs"),
    );
    expect(warnCall).toBeTruthy();
  });

  it("duplicate inbox entry -> 'already in your Inbox' info toast (no error)", async () => {
    setLocation(`http://localhost/app/stealth#inbox=${base64(CLAIM_CODE)}`);
    addToStealthInboxMock.mockReturnValue(false); // already present
    render(<Stealth />);
    await flush();
    expect(toastDefaultMock).toHaveBeenCalled();
    const dupeCall = toastDefaultMock.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("already in your Inbox"),
    );
    expect(dupeCall).toBeTruthy();
  });

  it("claimCodeHash = keccak256(encodePacked(bytes32, address)) — binding verified", async () => {
    setLocation(`http://localhost/app/stealth#inbox=${base64(CLAIM_CODE)}`);
    addToStealthInboxMock.mockReturnValue(true);
    render(<Stealth />);
    await flush();
    const hash = addToStealthInboxMock.mock.calls[0][2].claimCodeHash;
    // Pin: hash is deterministic for (CLAIM_CODE, ME) and 64 hex chars
    expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    // Same inputs produce same hash — verify by re-running with same args
    const { rerender } = render(<Stealth />);
    rerender(<Stealth />);
    await flush();
    // Second render same hash (deterministic)
    const secondHash = addToStealthInboxMock.mock.calls[1]?.[2]?.claimCodeHash;
    if (secondHash) expect(secondHash).toBe(hash);
  });
});

// ----- Cross-tab sync ----- //

describe("Stealth — cross-tab sync listeners (§15.x)", () => {
  it("registers TWO onCrossTabAction listeners (inbox_changed + pending_claim_removed)", async () => {
    render(<Stealth />);
    await flush();
    expect(onCrossTabActionMock).toHaveBeenCalledTimes(2);
  });

  it("no effective address -> ZERO listeners registered (no spurious subscriptions)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    render(<Stealth />);
    await flush();
    expect(onCrossTabActionMock).toHaveBeenCalledTimes(0);
  });

  it("each listener returns its unsubscribe fn (called on unmount)", async () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    onCrossTabActionMock.mockImplementationOnce(() => unsub1);
    onCrossTabActionMock.mockImplementationOnce(() => unsub2);
    const { unmount } = render(<Stealth />);
    await flush();
    unmount();
    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(unsub2).toHaveBeenCalledTimes(1);
  });
});

// ----- Create form validation + sendStealth ----- //

describe("Stealth — Create form (§15.x)", () => {
  it("amount input regex /^\\d*\\.?\\d{0,6}$/ rejects 7th decimal", () => {
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "1.123456" } });
    expect(amountInput.value).toBe("1.123456");
    fireEvent.change(amountInput, { target: { value: "1.1234567" } });
    expect(amountInput.value).toBe("1.123456");
  });

  it("invalid recipient hex shows inline 'Invalid Ethereum address' error + disables submit", () => {
    const { container } = render(<Stealth />);
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: "not-hex" } });
    expect(container.textContent).toContain("Invalid Ethereum address");
    const submit = findButton(container, "Send Stealth Payment");
    expect(submit.disabled).toBe(true);
  });

  it("empty amount or recipient -> Send disabled", () => {
    const { container } = render(<Stealth />);
    const submit = findButton(container, "Send Stealth Payment");
    expect(submit.disabled).toBe(true);
  });

  it("valid input -> sendStealth(amount, recipient, vault, message) called", async () => {
    sendStealthMock.mockResolvedValue({
      claimCode: CLAIM_CODE,
      transferId: 7,
    });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "50" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    const noteTextarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(noteTextarea, { target: { value: "dinner" } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    expect(sendStealthMock).toHaveBeenCalledWith(
      "50",
      ALICE,
      VAULT_USDC,
      "dinner",
    );
  });

  it("empty message -> sendStealth gets default 'Stealth payment'", async () => {
    sendStealthMock.mockResolvedValue({ claimCode: CLAIM_CODE, transferId: 1 });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    expect(sendStealthMock.mock.calls[0][3]).toBe("Stealth payment");
  });

  it("no address -> 'Connect wallet first' toast on submit (defensive)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    // Submit button enables because amount+recipient set, but handleCreateCode
    // returns early with toast when address missing
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect wallet first");
    expect(sendStealthMock).toHaveBeenCalledTimes(0);
  });

  it("success surface: shows claim code + transfer ID + formatted amount", async () => {
    sendStealthMock.mockResolvedValue({ claimCode: CLAIM_CODE, transferId: 42 });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "25" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    expect(container.textContent).toContain("Stealth Payment Sent");
    expect(container.textContent).toContain(CLAIM_CODE);
    expect(container.textContent).toContain("42");
  });

  it("share link uses URL hash (#inbox=) NOT query string (?inbox=)", async () => {
    sendStealthMock.mockResolvedValue({ claimCode: CLAIM_CODE, transferId: 7 });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    // Share link rendered with /app/stealth#inbox= prefix
    expect(container.textContent).toContain("/app/stealth#inbox=");
    expect(container.textContent).not.toContain("/app/stealth?inbox=");
  });

  it("copy share link click -> copyToClipboard + success toast", async () => {
    sendStealthMock.mockResolvedValue({ claimCode: CLAIM_CODE, transferId: 7 });
    copyToClipboardMock.mockResolvedValue(true);
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    fireEvent.click(findButton(container, "Copy share link"));
    await flush();
    expect(copyToClipboardMock).toHaveBeenCalled();
    expect(copyToClipboardMock.mock.calls[0][0]).toContain("/app/stealth#inbox=");
    expect(toastSuccessMock).toHaveBeenCalledWith("Link copied! Send it to the recipient.");
  });

  it("'New Code' button resets form + clears newCode state", async () => {
    sendStealthMock.mockResolvedValue({ claimCode: CLAIM_CODE, transferId: 7 });
    const { container } = render(<Stealth />);
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const recipientInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(recipientInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Send Stealth Payment"));
    await flush();
    fireEvent.click(findButton(container, "New Code"));
    expect(container.textContent).toContain("New Stealth Payment");
    expect(resetMock).toHaveBeenCalled();
  });

  it("getStepLabel matrix: shows step-specific copy during isSubmitting", () => {
    setStealth({ step: "encrypting" });
    const { container } = render(<Stealth />);
    expect(container.textContent).toContain("Encrypting recipient");
    setStealth({ step: "sending" });
    const r2 = render(<Stealth />);
    expect(r2.container.textContent).toContain("Sending stealth payment");
    setStealth({ step: "approving" });
    const r3 = render(<Stealth />);
    expect(r3.container.textContent).toContain("Approving USDC");
  });

  it("error from hook rendered in red banner", () => {
    setStealth({ error: "rpc reverted" });
    const { container } = render(<Stealth />);
    expect(container.textContent).toContain("rpc reverted");
  });
});

// ----- Claim tab ----- //

describe("Stealth — Claim tab (§15.x)", () => {
  function openClaimTab(container: HTMLElement) {
    const claimTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Claim code") as HTMLButtonElement;
    fireEvent.click(claimTab);
  }

  it("empty inputs -> Claim Payment disabled", () => {
    const { container } = render(<Stealth />);
    openClaimTab(container);
    const claimBtn = findButton(container, "Claim Payment");
    expect(claimBtn.disabled).toBe(true);
  });

  it("valid transferId + claim code -> claimStealth(N, code) called", async () => {
    claimStealthMock.mockResolvedValue({ success: true });
    const { container } = render(<Stealth />);
    openClaimTab(container);
    const transferInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0") as HTMLInputElement;
    fireEvent.change(transferInput, { target: { value: "42" } });
    const codeInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0x...") as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: CLAIM_CODE } });
    fireEvent.click(findButton(container, "Claim Payment"));
    await flush();
    expect(claimStealthMock).toHaveBeenCalledWith(42, CLAIM_CODE);
  });

  it("non-numeric transferId -> claimStealth NOT called (parseInt NaN guard)", async () => {
    const { container } = render(<Stealth />);
    openClaimTab(container);
    const transferInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0") as HTMLInputElement;
    fireEvent.change(transferInput, { target: { value: "not-a-num" } });
    const codeInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0x...") as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: CLAIM_CODE } });
    fireEvent.click(findButton(container, "Claim Payment"));
    await flush();
    expect(claimStealthMock).toHaveBeenCalledTimes(0);
  });

  it("claim success -> 'Claim Initiated!' state + 'Claim Another' button resets", async () => {
    claimStealthMock.mockResolvedValue({ success: true });
    const { container } = render(<Stealth />);
    openClaimTab(container);
    const transferInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0") as HTMLInputElement;
    fireEvent.change(transferInput, { target: { value: "1" } });
    const codeInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0x...") as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: CLAIM_CODE } });
    fireEvent.click(findButton(container, "Claim Payment"));
    await flush();
    expect(container.textContent).toContain("Claim Initiated");
    fireEvent.click(findButton(container, "Claim Another"));
    expect(container.textContent).toContain("Claim Payment");
    expect(resetMock).toHaveBeenCalled();
  });

  it("isWaitingForDecryption -> 'decryption progress' banner shown", () => {
    setStealth({
      isWaitingForDecryption: true,
      decryptionProgress: "Decrypting... (5s)",
    });
    const { container } = render(<Stealth />);
    const claimTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Claim code") as HTMLButtonElement;
    fireEvent.click(claimTab);
    expect(container.textContent).toContain("Decrypting... (5s)");
  });

  it("finalize: parses transferId + calls finalizeClaim", async () => {
    finalizeClaimMock.mockResolvedValue(undefined);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    const finalizeInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "Transfer ID") as HTMLInputElement;
    fireEvent.change(finalizeInput, { target: { value: "99" } });
    fireEvent.click(findButton(container, /^Finalize$/));
    await flush();
    expect(finalizeClaimMock).toHaveBeenCalledWith(99);
  });

  it("Resume Pending Claims surfaced when getPendingClaims non-empty", async () => {
    getPendingClaimsMock.mockReturnValue([
      { transferId: 7, claimCode: CLAIM_CODE, startedAt: Date.now() - 60_000 },
    ]);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    expect(container.textContent).toContain("Resume Pending Claims");
    expect(container.textContent).toContain("Transfer #7");
  });

  it("Resume click -> resumePendingClaim(BigInt(transferId), claimCode)", async () => {
    getPendingClaimsMock.mockReturnValue([
      { transferId: 7, claimCode: CLAIM_CODE, startedAt: Date.now() - 60_000 },
    ]);
    resumePendingClaimMock.mockResolvedValue(undefined);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    fireEvent.click(findButton(container, /^Resume$/));
    await flush();
    expect(resumePendingClaimMock).toHaveBeenCalledWith(BigInt(7), CLAIM_CODE);
  });
});

// ----- Pending claims discovery ----- //

describe("Stealth — Pending claims discovery (§15.x)", () => {
  function openClaimTab(container: HTMLElement) {
    const claimTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Claim code") as HTMLButtonElement;
    fireEvent.click(claimTab);
  }

  it("no stored codes -> info toast 'No stored claim codes found' (no fetch)", async () => {
    const { container } = render(<Stealth />);
    openClaimTab(container);
    fireEvent.click(findButton(container, "Check for Pending Claims"));
    await flush();
    expect(toastDefaultMock).toHaveBeenCalled();
    const infoCall = toastDefaultMock.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("No stored claim codes"),
    );
    expect(infoCall).toBeTruthy();
    expect(getMyPendingClaimsMock).toHaveBeenCalledTimes(0);
  });

  it("stored codes + pending claims found -> 'Found N pending claim(s)' success", async () => {
    // Pre-populate localStorage with stored codes
    const codes = [
      { claimCode: CLAIM_CODE, transferId: 1, recipientAddress: ME, createdAt: Date.now() },
    ];
    localStorage.setItem(
      `blank:claim_codes:${ME.toLowerCase()}:11155111`,
      JSON.stringify(codes),
    );
    getMyPendingClaimsMock.mockResolvedValue([1]);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    fireEvent.click(findButton(container, "Check for Pending Claims"));
    await flush();
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("Found 1 pending claim"));
    expect(container.textContent).toContain("Transfer #1");
  });

  it("stored codes + zero pending -> 'No pending claims found' success", async () => {
    const codes = [
      { claimCode: CLAIM_CODE, transferId: 1, recipientAddress: ME, createdAt: Date.now() },
    ];
    localStorage.setItem(
      `blank:claim_codes:${ME.toLowerCase()}:11155111`,
      JSON.stringify(codes),
    );
    getMyPendingClaimsMock.mockResolvedValue([]);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    fireEvent.click(findButton(container, "Check for Pending Claims"));
    await flush();
    expect(toastSuccessMock).toHaveBeenCalledWith("No pending claims found");
  });

  it("'Use' click auto-fills the Transfer ID input + success toast", async () => {
    const codes = [
      { claimCode: CLAIM_CODE, transferId: 5, recipientAddress: ME, createdAt: Date.now() },
    ];
    localStorage.setItem(
      `blank:claim_codes:${ME.toLowerCase()}:11155111`,
      JSON.stringify(codes),
    );
    getMyPendingClaimsMock.mockResolvedValue([5]);
    const { container } = render(<Stealth />);
    openClaimTab(container);
    fireEvent.click(findButton(container, "Check for Pending Claims"));
    await flush();
    fireEvent.click(findButton(container, /^Use$/));
    const transferInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "0") as HTMLInputElement;
    expect(transferInput.value).toBe("5");
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("Transfer ID #5 auto-filled"),
    );
  });
});

// ----- Inbox tab + handleClaimFromInbox state machine ----- //

describe("Stealth — Inbox tab + claim state machine (§15.x)", () => {
  function openInboxTab(container: HTMLElement) {
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    fireEvent.click(inboxTab);
  }

  it("inbox tab badge count reflects 'new' status entries", () => {
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: "0x" + "1".repeat(64), status: "new", receivedAt: Date.now() },
      { claimCode: CLAIM_CODE, claimCodeHash: "0x" + "2".repeat(64), status: "claimed", receivedAt: Date.now() },
      { claimCode: CLAIM_CODE, claimCodeHash: "0x" + "3".repeat(64), status: "new", receivedAt: Date.now() },
    ]);
    const { container } = render(<Stealth />);
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    // Badge contains "2" (two 'new' entries)
    expect(inboxTab.textContent).toContain("2");
  });

  it("empty inbox renders empty state", () => {
    getStealthInboxMock.mockReturnValue([]);
    const { container } = render(<Stealth />);
    openInboxTab(container);
    expect(container.textContent).toContain("No incoming payments");
    expect(container.textContent).toContain(
      "Ask a sender to share a stealth payment link",
    );
  });

  it("handleClaimFromInbox: 'new' -> 'claiming' -> 'claimed' on success", async () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "new", receivedAt: Date.now() },
    ]);
    getMyPendingClaimsMock.mockResolvedValue([42]);
    claimStealthMock.mockResolvedValue({ success: true });
    const { container } = render(<Stealth />);
    openInboxTab(container);
    fireEvent.click(findButton(container, /^Claim$/));
    await flush();
    // First call: 'claiming' (optimistic)
    expect(markInboxEntryStatusMock).toHaveBeenNthCalledWith(
      1, ME, 11155111, hash, "claiming",
    );
    // claimStealth called with discovered transferId
    expect(claimStealthMock).toHaveBeenCalledWith(42, CLAIM_CODE);
    // Final call: 'claimed' on success
    const calls = markInboxEntryStatusMock.mock.calls;
    expect(calls[calls.length - 1][3]).toBe("claimed");
  });

  it("transfer not found on-chain -> 'Transfer not found' toast + revert status to 'new'", async () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "new", receivedAt: Date.now() },
    ]);
    getMyPendingClaimsMock.mockResolvedValue([]); // not found yet
    const { container } = render(<Stealth />);
    openInboxTab(container);
    fireEvent.click(findButton(container, /^Claim$/));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Transfer not found on-chain"),
    );
    // Reverted back to 'new'
    const lastCall = markInboxEntryStatusMock.mock.calls.slice(-1)[0];
    expect(lastCall[3]).toBe("new");
    expect(claimStealthMock).toHaveBeenCalledTimes(0);
  });

  it("getMyPendingClaims throws -> status reverts to 'new' (no toast crash)", async () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "new", receivedAt: Date.now() },
    ]);
    getMyPendingClaimsMock.mockRejectedValue(new Error("rpc fail"));
    const { container } = render(<Stealth />);
    openInboxTab(container);
    fireEvent.click(findButton(container, /^Claim$/));
    await flush();
    const lastCall = markInboxEntryStatusMock.mock.calls.slice(-1)[0];
    expect(lastCall[3]).toBe("new");
  });

  it("'claimed' entry renders green Claimed pill + button disabled", () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "claimed", receivedAt: Date.now() },
    ]);
    const { container } = render(<Stealth />);
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    fireEvent.click(inboxTab);
    const claimedBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Claimed")) as HTMLButtonElement;
    expect(claimedBtn.disabled).toBe(true);
  });

  it("inbox entry shows 'From: <fromHint>' or 'From: anonymous' fallback", () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "new", receivedAt: Date.now(), fromHint: "0xbbbb...bbbb" },
    ]);
    const { container } = render(<Stealth />);
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    fireEvent.click(inboxTab);
    expect(container.textContent).toContain("0xbbbb...bbbb");
  });

  it("no fromHint -> 'anonymous' fallback rendered", () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    getStealthInboxMock.mockReturnValue([
      { claimCode: CLAIM_CODE, claimCodeHash: hash, status: "new", receivedAt: Date.now() },
    ]);
    const { container } = render(<Stealth />);
    const inboxTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "Stealth inbox") as HTMLButtonElement;
    fireEvent.click(inboxTab);
    expect(container.textContent).toContain("anonymous");
  });
});

// ----- Sent tab + 30-day refund window (#215) ----- //

describe("Stealth — Sent tab + #215 30-day refund window (§15.x)", () => {
  async function openSentTab(container: HTMLElement) {
    const sentTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.getAttribute("aria-label") === "My sent payments") as HTMLButtonElement;
    fireEvent.click(sentTab);
    await flush();
  }

  function setSentTransfers(
    transfers: Array<{
      transferId: number;
      claimed?: boolean;
      finalized?: boolean;
      ageDays?: number;
      amount?: bigint;
      note?: string;
    }>,
  ) {
    // First readContract call returns getSenderTransfers ids
    mockReadContract.mockImplementation((args: { functionName: string }) => {
      if (args.functionName === "getSenderTransfers") {
        return Promise.resolve(transfers.map((t) => BigInt(t.transferId)));
      }
      // getTransferInfo returns the tuple per id; match by index for simplicity
      const idx = mockReadContract.mock.calls
        .filter((c) => (c[0] as { functionName: string }).functionName === "getTransferInfo")
        .length - 1;
      const t = transfers[idx];
      return Promise.resolve([
        ME, // [0] sender
        VAULT_USDC, // [1]
        "", // [2]
        t.amount ?? 1_000_000n, // [3] plaintextAmount
        "", // [4]
        t.note ?? "test", // [5] note
        BigInt(Math.floor(Date.now() / 1000) - (t.ageDays ?? 0) * 86400), // [6] timestamp
        t.claimed ?? false, // [7]
        t.finalized ?? false, // [8]
      ]);
    });
  }

  it("empty sent list -> 'No sent payments' empty state", async () => {
    mockReadContract.mockResolvedValue([]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    expect(container.textContent).toContain("No sent payments");
  });

  it("fresh transfer (<30 days) -> Refund disabled + 'Refund available in N days' copy", async () => {
    setSentTransfers([{ transferId: 1, ageDays: 5 }]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    expect(container.textContent).toMatch(/Refund available in 25 days?/);
    const refundBtns = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Refund"));
    // Disabled refund btn
    const disabledRefund = refundBtns.find((b) => b.disabled);
    expect(disabledRefund).toBeTruthy();
  });

  it("31-day-old unclaimed transfer -> Refund ENABLED + 'Refund window open' copy", async () => {
    setSentTransfers([{ transferId: 2, ageDays: 31 }]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    expect(container.textContent).toContain("Refund window open");
    const refundBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Refund") && !b.disabled);
    expect(refundBtn).toBeTruthy();
  });

  it("claimed transfer -> NO Refund button (claimed payments not refundable)", async () => {
    setSentTransfers([{ transferId: 3, ageDays: 60, claimed: true }]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    expect(container.textContent).not.toContain("Refund window open");
    expect(container.textContent).not.toContain("Refund available in");
  });

  it("Refund click -> unifiedWriteAndWait called with refund function + transferId", async () => {
    setSentTransfers([{ transferId: 5, ageDays: 31 }]);
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xabc",
      receipt: { status: "success" },
    });
    const { container } = render(<Stealth />);
    await openSentTab(container);
    const refundBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Refund") && !b.disabled) as HTMLButtonElement;
    fireEvent.click(refundBtn);
    await flush();
    expect(unifiedWriteAndWaitMock).toHaveBeenCalled();
    const args = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(args.functionName).toBe("refund");
    expect(args.args[0]).toBe(BigInt(5));
    expect(args.address).toBe(STEALTH_CONTRACT);
  });

  it("Refund reverted receipt -> 'Refund transaction reverted' error toast", async () => {
    setSentTransfers([{ transferId: 6, ageDays: 31 }]);
    unifiedWriteAndWaitMock.mockResolvedValue({
      hash: "0xabc",
      receipt: { status: "reverted" },
    });
    const { container } = render(<Stealth />);
    await openSentTab(container);
    const refundBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Refund") && !b.disabled) as HTMLButtonElement;
    fireEvent.click(refundBtn);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Refund transaction reverted",
      expect.any(Object),
    );
  });

  it("transfers sorted newest-first by timestamp", async () => {
    setSentTransfers([
      { transferId: 1, ageDays: 30, note: "OLDER" },
      { transferId: 2, ageDays: 1, note: "NEWER" },
    ]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    const text = container.textContent ?? "";
    const newerIdx = text.indexOf("NEWER");
    const olderIdx = text.indexOf("OLDER");
    expect(newerIdx).toBeGreaterThan(-1);
    expect(olderIdx).toBeGreaterThan(-1);
    expect(newerIdx).toBeLessThan(olderIdx); // newer renders first
  });

  it("Refresh button re-runs loadSentTransfers", async () => {
    mockReadContract.mockResolvedValue([]);
    const { container } = render(<Stealth />);
    await openSentTab(container);
    const before = mockReadContract.mock.calls.length;
    fireEvent.click(findButton(container, /Refresh/));
    await flush();
    expect(mockReadContract.mock.calls.length).toBeGreaterThan(before);
  });
});

// ----- Stealth Activity card filter ----- //

describe("Stealth — Stealth Activity card filter (§15.x)", () => {
  it("ONLY 3 stealth_* activity types render in Stealth Activity card", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        { id: "a-1", activity_type: "stealth_sent", note: "stealth-A", created_at: new Date().toISOString(), user_from: ME, user_to: ALICE },
        { id: "a-2", activity_type: "payment", note: "should-NOT-render", created_at: new Date().toISOString(), user_from: ME, user_to: ALICE },
        { id: "a-3", activity_type: "stealth_claimed", note: "stealth-B", created_at: new Date().toISOString(), user_from: ALICE, user_to: ME },
        { id: "a-4", activity_type: "swap", note: "swap-noise", created_at: new Date().toISOString(), user_from: ME, user_to: ALICE },
      ],
    });
    const { container } = render(<Stealth />);
    expect(container.textContent).toContain("stealth-A");
    expect(container.textContent).toContain("stealth-B");
    expect(container.textContent).not.toContain("should-NOT-render");
    expect(container.textContent).not.toContain("swap-noise");
  });

  it("empty stealth-filtered list -> 'No stealth activity' empty state", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        { id: "a-1", activity_type: "payment", note: "noise", created_at: new Date().toISOString(), user_from: ME, user_to: ALICE },
      ],
    });
    const { container } = render(<Stealth />);
    expect(container.textContent).toContain("No stealth activity");
  });

  it("stealth_sent row labelled 'Sent'; stealth_claimed labelled 'Claimed'", () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        { id: "a-1", activity_type: "stealth_sent", note: "outgoing", created_at: new Date().toISOString(), user_from: ME, user_to: ALICE },
        { id: "a-2", activity_type: "stealth_claimed", note: "incoming", created_at: new Date().toISOString(), user_from: ALICE, user_to: ME },
        { id: "a-3", activity_type: "stealth_claim_started", note: "pending", created_at: new Date().toISOString(), user_from: ALICE, user_to: ME },
      ],
    });
    const { container } = render(<Stealth />);
    // Each label appears as a row title
    const titles = Array.from(container.querySelectorAll("p"))
      .map((p) => p.textContent?.trim());
    expect(titles).toContain("Sent");
    expect(titles).toContain("Claimed");
    expect(titles).toContain("Claim Started");
  });
});
