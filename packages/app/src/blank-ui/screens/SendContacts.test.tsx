import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for SendContacts screen. Send-flow entry point with
// Single|Many mode toggle + contact list + direct address/ENS
// input + clipboard paste. CRITICAL pins:
//
//   - Single mode: click contact -> setMode("single") +
//     setRecipient + navigate("/app/send/amount") with state.
//   - Many mode: click contact toggles selectedSet; cap at
//     MAX_BATCH_RECIPIENTS with toast. Click on already-selected
//     row REMOVES (toggle, not add-only).
//   - selectedSet hydrates from shared recipients on mount, AND
//     re-hydrates when recipients changes from outside (e.g.
//     SendAmount calls reset() on success). Without re-hydrate,
//     a returning user sees a stale checkbox state.
//   - continueBatch pre-validates every selected address before
//     navigate (defense in depth even though contact list is
//     vetted -- belt-and-braces because direct-input added below).
//   - submitDirectInput dispatch: hex address -> advance
//     immediately; ENS name -> async resolve + dismissable
//     loading toast + branch on resolved/null; non-matching ->
//     "Invalid address or ENS name". Empty -> "Enter a wallet
//     address or ENS name".
//   - Many-mode direct input ADDS to selection instead of
//     navigating (so user can mix contact picks + typed
//     addresses in one batch).
//   - Bottom dock visible only when mode=many AND
//     selectedSet.size > 0; "X recipient(s)" singular/plural.

const useNavigateMock = vi.hoisted(() => vi.fn());
const useContactsMock = vi.hoisted(() => vi.fn());
const useSendPaymentMock = vi.hoisted(() => vi.fn());
const useResolveNameMock = vi.hoisted(() => vi.fn());
const looksLikeEnsNameMock = vi.hoisted(() => vi.fn());
const resolveNameMock = vi.hoisted(() => vi.fn());
const isAddressMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn(() => "toast-id"));
const toastDismissMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));
vi.mock("@/hooks/useContacts", () => ({ useContacts: useContactsMock }));
vi.mock("@/hooks/useSendPayment", () => ({
  useSendPayment: useSendPaymentMock,
  MAX_BATCH_RECIPIENTS: 50,
}));
vi.mock("@/hooks/useAddressResolver", () => ({ useResolveName: useResolveNameMock }));
vi.mock("@/lib/address-resolver", () => ({
  looksLikeEnsName: looksLikeEnsNameMock,
  resolveName: resolveNameMock,
}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    isAddress: isAddressMock,
  };
});
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
    dismiss: toastDismissMock,
  }),
}));

import SendContacts from "./SendContacts";

const ALICE_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHARLIE_ADDR = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = "0x0000000000000000000000000000000000000000";

type Contact = { id: string; address: string; nickname: string };

let setModeMock: ReturnType<typeof vi.fn>;
let setRecipientMock: ReturnType<typeof vi.fn>;
let setRecipientsMock: ReturnType<typeof vi.fn>;
let resetSendMock: ReturnType<typeof vi.fn>;

function setSend(overrides: Partial<{
  mode: "single" | "many";
  recipients: string[];
}> = {}) {
  useSendPaymentMock.mockReturnValue({
    mode: overrides.mode ?? "single",
    recipients: overrides.recipients ?? [],
    setMode: setModeMock,
    setRecipients: setRecipientsMock,
    setRecipient: setRecipientMock,
    reset: resetSendMock,
  });
}

function setContacts(contacts: Contact[], isLoading = false) {
  useContactsMock.mockReturnValue({ contacts, isLoading });
}

beforeEach(() => {
  useNavigateMock.mockReset();
  useContactsMock.mockReset();
  useSendPaymentMock.mockReset();
  useResolveNameMock.mockReset();
  looksLikeEnsNameMock.mockReset();
  resolveNameMock.mockReset();
  isAddressMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  toastDismissMock.mockReset();

  setModeMock = vi.fn();
  setRecipientMock = vi.fn();
  setRecipientsMock = vi.fn();
  resetSendMock = vi.fn();
  setSend();

  setContacts([
    { id: "1", address: ALICE_ADDR, nickname: "Alice" },
    { id: "2", address: BOB_ADDR, nickname: "Bob" },
  ]);

  useResolveNameMock.mockReturnValue({ data: null, isFetching: false, isFetched: false });
  looksLikeEnsNameMock.mockReturnValue(false);
  resolveNameMock.mockResolvedValue(null);
  isAddressMock.mockImplementation((v: string) => /^0x[a-fA-F0-9]{40}$/.test(v));

  toastLoadingMock.mockReturnValue("toast-id");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SendContacts — page chrome (§15.x)", () => {
  it("renders 'Send Money' heading + single-mode subtitle by default", () => {
    const { container } = render(<SendContacts />);
    expect(container.textContent).toContain("Send Money");
    expect(container.textContent).toContain("Transfer money privately with encrypted amounts");
  });

  it("Single mode pill aria-selected=true by default", () => {
    const { getByTestId } = render(<SendContacts />);
    expect(getByTestId("send-mode-single").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("send-mode-many").getAttribute("aria-selected")).toBe("false");
  });

  it("Many-mode subtitle reads 'Pick up to <MAX_BATCH_RECIPIENTS> recipients'", () => {
    setSend({ mode: "many" });
    const { container } = render(<SendContacts />);
    expect(container.textContent).toContain("Pick up to 50 recipients");
    expect(container.textContent).toContain("One batched, encrypted tx");
  });

  it("clicking Many toggle calls setMode('many')", () => {
    const { getByTestId } = render(<SendContacts />);
    fireEvent.click(getByTestId("send-mode-many"));
    expect(setModeMock).toHaveBeenCalledWith("many");
  });

  it("Many badge shows selectedSet.size when > 0 (hydrated from recipients)", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR, BOB_ADDR] });
    const { getByTestId } = render(<SendContacts />);
    const manyTab = getByTestId("send-mode-many");
    expect(manyTab.textContent).toContain("2");
  });
});

describe("SendContacts — search filter (§15.x)", () => {
  it("nickname substring match (case-insensitive)", () => {
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "ALICE" } });
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("Bob");
  });

  it("address substring match", () => {
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: ALICE_ADDR.slice(2, 8) } });
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("Bob");
  });

  it("Recent section HIDDEN when search is active", () => {
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "Alice" } });
    expect(container.textContent).not.toContain("Recent");
  });

  it("'Results' label shown when search is active (vs 'All Contacts')", () => {
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "Alice" } });
    expect(container.textContent).toContain("Results");
    expect(container.textContent).not.toContain("All Contacts");
  });

  it("Recent section visible when search empty AND contacts present", () => {
    const { container } = render(<SendContacts />);
    expect(container.textContent).toContain("Recent");
    expect(container.textContent).toContain("All Contacts");
  });
});

describe("SendContacts — empty state + search-as-address (§15.x)", () => {
  it("no contacts -> 'No contacts yet. Add one to get started.'", () => {
    setContacts([]);
    const { container } = render(<SendContacts />);
    expect(container.textContent).toContain("No contacts yet. Add one to get started");
  });

  it("search returns no match -> 'No contacts found'", () => {
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "zzz-not-a-contact" } });
    expect(container.textContent).toContain("No contacts found");
  });

  it("search IS a valid hex address (no match in contacts) -> 'Send to <truncated>' link visible", () => {
    setContacts([]);
    const { getByLabelText, getByText } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: CHARLIE_ADDR } });
    expect(getByText(/Send to 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/i)).toBeDefined();
  });

  it("search is ENS name + isFetching -> 'Resolving <name>…' spinner", () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    useResolveNameMock.mockReturnValue({ data: null, isFetching: true, isFetched: false });
    setContacts([]);
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "alice.eth" } });
    expect(container.textContent).toContain("Resolving alice.eth");
  });

  it("search is ENS + resolved -> 'Send to <name> (<truncated>)' link", () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    useResolveNameMock.mockReturnValue({ data: ALICE_ADDR, isFetching: false, isFetched: true });
    setContacts([]);
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "alice.eth" } });
    expect(container.textContent).toContain("Send to alice.eth");
    expect(container.textContent).toMatch(/\(0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}\)/i);
  });

  it("search is ENS + failed -> 'Couldn't resolve <name>' rose-colored error", () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    useResolveNameMock.mockReturnValue({ data: null, isFetching: false, isFetched: true });
    setContacts([]);
    const { getByLabelText, container } = render(<SendContacts />);
    fireEvent.change(getByLabelText("Search contacts"), { target: { value: "missing.eth" } });
    expect(container.textContent).toContain("Couldn't resolve missing.eth");
  });
});

describe("SendContacts — single-mode contact click (§15.x)", () => {
  it("clicking contact -> setMode('single') + setRecipient(addr) + navigate with state", () => {
    const { container } = render(<SendContacts />);
    // "Alice" appears in BOTH the Recent strip AND All Contacts row. Either
    // fires handleSelectContact in single mode. Pick the first matching
    // button by walking the rendered tree.
    const aliceButton = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    fireEvent.click(aliceButton);
    expect(setModeMock).toHaveBeenCalledWith("single");
    expect(setRecipientMock).toHaveBeenCalledWith(ALICE_ADDR);
    expect(useNavigateMock).toHaveBeenCalledWith("/app/send/amount", {
      state: { recipient: ALICE_ADDR, nickname: "Alice" },
    });
  });

  it("single mode: row shows ChevronRight (no checkbox)", () => {
    const { container } = render(<SendContacts />);
    // ChevronRight has class 'lucide-chevron-right' from lucide-react
    const chevrons = container.querySelectorAll(".lucide-chevron-right");
    expect(chevrons.length).toBeGreaterThanOrEqual(2); // one per contact
  });
});

describe("SendContacts — many-mode toggle + cap (§15.x)", () => {
  beforeEach(() => {
    setSend({ mode: "many" });
  });

  it("clicking contact in many mode toggles selection (aria-pressed flips)", () => {
    const { container } = render(<SendContacts />);
    // The contact "Alice" appears in BOTH the Recent strip + All Contacts list.
    // Only the All-Contacts row has aria-pressed (mode === "many" branch);
    // the Recent strip uses bare buttons. Find by aria-pressed selector.
    let aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    fireEvent.click(aliceRow);
    aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    expect(aliceRow.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking already-selected row REMOVES (toggle, not add-only)", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR] });
    const { container } = render(<SendContacts />);
    // Alice should start selected (aria-pressed=true).
    const aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    expect(aliceRow.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(aliceRow);
    // After click: should now be aria-pressed=false.
    const afterRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    expect(afterRow.getAttribute("aria-pressed")).toBe("false");
  });

  it("CRITICAL cap at MAX_BATCH_RECIPIENTS: 51st add -> toast.error 'Max 50 recipients per batch'", () => {
    // Pre-fill 50 recipients via hydrate.
    const fullList = Array.from({ length: 50 }, (_, i) =>
      `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`,
    );
    setSend({ mode: "many", recipients: fullList });
    const { container } = render(<SendContacts />);
    // Try to add Alice (not in the 50). Alice row is aria-pressed=false.
    const aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    fireEvent.click(aliceRow);
    expect(toastErrorMock).toHaveBeenCalledWith("Max 50 recipients per batch");
  });

  it("many mode: row shows checkbox circle (no ChevronRight)", () => {
    const { container } = render(<SendContacts />);
    // In many mode rows don't get ChevronRight indicator; check at least one Check icon present after selection.
    const aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    fireEvent.click(aliceRow);
    // After selection, Check icon should be rendered inside the row's checkbox circle.
    expect(container.querySelectorAll(".lucide-check").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SendContacts — batch-send dock (§15.x)", () => {
  it("dock HIDDEN in single mode regardless of recipients", () => {
    setSend({ mode: "single", recipients: [ALICE_ADDR] });
    const { queryByTestId } = render(<SendContacts />);
    expect(queryByTestId("batch-send-dock")).toBeNull();
  });

  it("dock HIDDEN in many mode when selectedSet is empty", () => {
    setSend({ mode: "many", recipients: [] });
    const { queryByTestId } = render(<SendContacts />);
    expect(queryByTestId("batch-send-dock")).toBeNull();
  });

  it("dock visible in many mode + selection -> shows count + truncated addresses + Continue + Clear", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR, BOB_ADDR] });
    const { getByTestId, container } = render(<SendContacts />);
    const dock = getByTestId("batch-send-dock");
    expect(dock.textContent).toContain("2 recipients");
    expect(container.textContent).toMatch(/0xaaaa.{1,3}aaaa/i);
    expect(container.textContent).toMatch(/0xbbbb.{1,3}bbbb/i);
    expect(getByTestId("batch-send-continue")).toBeDefined();
  });

  it("dock singular 'recipient' when count = 1", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR] });
    const { getByTestId } = render(<SendContacts />);
    const dock = getByTestId("batch-send-dock");
    expect(dock.textContent).toContain("1 recipient");
    expect(dock.textContent).not.toContain("1 recipients");
  });

  it("dock with > 3 recipients shows '+N more' suffix", () => {
    setSend({
      mode: "many",
      recipients: [ALICE_ADDR, BOB_ADDR, CHARLIE_ADDR, "0xdddddddddddddddddddddddddddddddddddddddd"],
    });
    const { getByTestId } = render(<SendContacts />);
    const dock = getByTestId("batch-send-dock");
    expect(dock.textContent).toContain("+1 more");
  });

  it("Clear all button clears selection + calls reset on the hook", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR, BOB_ADDR] });
    const { getByLabelText } = render(<SendContacts />);
    fireEvent.click(getByLabelText("Clear all selected recipients"));
    expect(setRecipientsMock).toHaveBeenCalledWith([]);
    expect(resetSendMock).toHaveBeenCalled();
  });

  it("Continue click: setRecipients(list) + setMode('many') + navigate with state.mode='many'", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR, BOB_ADDR] });
    const { getByTestId } = render(<SendContacts />);
    fireEvent.click(getByTestId("batch-send-continue"));
    expect(setRecipientsMock).toHaveBeenCalled();
    expect(setModeMock).toHaveBeenCalledWith("many");
    expect(useNavigateMock).toHaveBeenCalledWith("/app/send/amount", { state: { mode: "many" } });
  });

  it("CRITICAL Continue pre-validates: invalid hex in selection -> toast + navigate NOT called", () => {
    // Force isAddress to return false for one of the addresses.
    isAddressMock.mockImplementation((v: string) => v !== ALICE_ADDR);
    setSend({ mode: "many", recipients: [ALICE_ADDR, BOB_ADDR] });
    const { getByTestId } = render(<SendContacts />);
    fireEvent.click(getByTestId("batch-send-continue"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("Invalid address in selection");
    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  it("CRITICAL Continue pre-validates: zero-address in selection rejected (independent of isAddress)", () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR, ZERO] });
    const { getByTestId } = render(<SendContacts />);
    fireEvent.click(getByTestId("batch-send-continue"));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(useNavigateMock).not.toHaveBeenCalled();
  });
});

describe("SendContacts — direct address input (Continue + Enter key) (§15.x)", () => {
  it("empty input -> 'Enter a wallet address or ENS name' toast", async () => {
    const { getByText } = render(<SendContacts />);
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a wallet address or ENS name");
  });

  it("valid hex address -> handleSelectContact (single-mode flow)", async () => {
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = CHARLIE_ADDR;
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
    });
    expect(setModeMock).toHaveBeenCalledWith("single");
    expect(setRecipientMock).toHaveBeenCalledWith(CHARLIE_ADDR);
    expect(useNavigateMock).toHaveBeenCalledWith("/app/send/amount", expect.objectContaining({ state: expect.any(Object) }));
  });

  it("Enter key on input -> submits", async () => {
    const { getByLabelText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = CHARLIE_ADDR;
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(setRecipientMock).toHaveBeenCalledWith(CHARLIE_ADDR);
  });

  it("ENS name input -> toast.loading + resolveName + dismiss + advance on success", async () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    resolveNameMock.mockResolvedValue(CHARLIE_ADDR);
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = "charlie.eth";
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastLoadingMock).toHaveBeenCalledWith("Resolving charlie.eth…");
    expect(resolveNameMock).toHaveBeenCalledWith("charlie.eth");
    expect(toastDismissMock).toHaveBeenCalledWith("toast-id");
    expect(setRecipientMock).toHaveBeenCalledWith(CHARLIE_ADDR);
  });

  it("ENS resolves to null -> error toast", async () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    resolveNameMock.mockResolvedValue(null);
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = "missing.eth";
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("Couldn't resolve missing.eth");
  });

  it("ENS resolves to ZERO address -> 'resolves to an invalid address' toast", async () => {
    looksLikeEnsNameMock.mockReturnValue(true);
    resolveNameMock.mockResolvedValue(ZERO);
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = "zero.eth";
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("resolves to an invalid address");
  });

  it("non-hex non-ENS input -> 'Invalid address or ENS name' toast", async () => {
    looksLikeEnsNameMock.mockReturnValue(false);
    isAddressMock.mockReturnValue(false);
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = "garbage";
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid address or ENS name");
  });

  it("CRITICAL many-mode direct hex input ADDS to set (instead of navigating)", async () => {
    setSend({ mode: "many" });
    const { getByLabelText, getByText } = render(<SendContacts />);
    const input = getByLabelText("Wallet address or ENS name") as HTMLInputElement;
    input.value = CHARLIE_ADDR;
    await act(async () => {
      fireEvent.click(getByText("Continue"));
      await Promise.resolve();
    });
    // Should NOT navigate -- toggleRecipient ADDS to the set; user keeps adding.
    expect(useNavigateMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
    expect((toastSuccessMock.mock.calls[0][0] as string)).toContain("Added");
  });
});

describe("SendContacts — paste from clipboard (§15.x)", () => {
  it("clipboard.readText returns a valid hex address -> auto-selects via handleSelectContact", async () => {
    const readTextMock = vi.fn().mockResolvedValue(CHARLIE_ADDR);
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: readTextMock },
      configurable: true,
      writable: true,
    });
    const { getByLabelText } = render(<SendContacts />);
    await act(async () => {
      fireEvent.click(getByLabelText("Paste address from clipboard"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readTextMock).toHaveBeenCalled();
    expect(setRecipientMock).toHaveBeenCalledWith(CHARLIE_ADDR);
  });

  it("clipboard rejection -> 'Could not read clipboard' toast", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
      writable: true,
    });
    const { getByLabelText } = render(<SendContacts />);
    await act(async () => {
      fireEvent.click(getByLabelText("Paste address from clipboard"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Could not read clipboard");
  });
});

describe("SendContacts — loading state (§15.x)", () => {
  it("isLoading=true -> 4 shimmer skeleton rows", () => {
    setContacts([], true);
    const { container } = render(<SendContacts />);
    const shimmers = container.querySelectorAll(".shimmer");
    expect(shimmers.length).toBeGreaterThanOrEqual(4);
  });
});

describe("SendContacts — re-hydrate selectedSet on recipients change (§15.x)", () => {
  it("CRITICAL: external reset() (recipients changes to []) re-hydrates selectedSet to empty", async () => {
    setSend({ mode: "many", recipients: [ALICE_ADDR] });
    const { rerender, container } = render(<SendContacts />);
    // Alice starts selected.
    let aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
      .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
    expect(aliceRow.getAttribute("aria-pressed")).toBe("true");

    // External reset: recipients = []
    setSend({ mode: "many", recipients: [] });
    rerender(<SendContacts />);

    await waitFor(() => {
      aliceRow = Array.from(container.querySelectorAll("button[aria-pressed]"))
        .find((b) => b.textContent?.includes("Alice")) as HTMLButtonElement;
      expect(aliceRow.getAttribute("aria-pressed")).toBe("false");
    });
  });
});

describe("SendContacts — encryption disclosure (§15.x)", () => {
  it("renders 'Amount will be encrypted' + 'Only you and recipient can see the value' framing", () => {
    const { container } = render(<SendContacts />);
    expect(container.textContent).toContain("Amount will be encrypted");
    expect(container.textContent).toContain("Only you and recipient can see the value");
  });
});
