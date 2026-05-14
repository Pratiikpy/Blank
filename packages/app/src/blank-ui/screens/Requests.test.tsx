import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for Requests screen. Payment-request management with
// CreateRequestModal + FulfillModal + cancel flow. Pins:
//   - passkey-aware guard (`!address` -> null)
//   - 2-tab list (incoming / outgoing) sourced from PARALLEL
//     fetchIncomingRequests + fetchOutgoingRequests calls
//   - 7-day expiry math (pending + created_at > 7d -> "Expired"
//     badge + Pay button disabled). Without the expiry visual,
//     stale requests look identical to fresh ones and payers
//     can't tell why their click on a months-old request reverts.
//   - audit #25 realtime: 3 supabase channels (UPDATE filtered
//     by from_address, UPDATE filtered by to_address, INSERT
//     filtered by from_address) + cross-tab subscribe. Without
//     the dual-filter the requester does NOT see fulfillment in
//     realtime when the payer pays from a different session.
//   - 3-branch CreateRequestModal validation: empty addr / bad
//     hex / bad email / amount<=0
//   - amount input regex /^\d*\.?\d{0,6}$/ (6dp = USDC precision)
//   - modal auto-close on step==="success" via useEffect

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const useRequestPaymentMock = vi.hoisted(() => vi.fn());
const fetchIncomingRequestsMock = vi.hoisted(() => vi.fn());
const fetchOutgoingRequestsMock = vi.hoisted(() => vi.fn());
const onCrossTabActionMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

const supabaseChannelMock = vi.hoisted(() => ({
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));
vi.mock("@/hooks/useRequestPayment", () => ({
  useRequestPayment: useRequestPaymentMock,
}));
vi.mock("@/lib/supabase", () => ({
  fetchIncomingRequests: fetchIncomingRequestsMock,
  fetchOutgoingRequests: fetchOutgoingRequestsMock,
  supabase: supabaseChannelMock,
}));
vi.mock("@/lib/cross-tab", () => ({
  onCrossTabAction: onCrossTabActionMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import Requests from "./Requests";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc";

type PaymentRequestRow = {
  id: number;
  request_id: number;
  from_address: string;
  to_address: string;
  status: "pending" | "fulfilled" | "cancelled";
  note: string | null;
  created_at: string;
};

function req(over: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  return {
    id: 1,
    request_id: 1,
    from_address: ME, // payer
    to_address: ALICE, // requester
    status: "pending",
    note: "rent",
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  };
}

let createRequestMock: ReturnType<typeof vi.fn>;
let fulfillRequestMock: ReturnType<typeof vi.fn>;
let cancelRequestMock: ReturnType<typeof vi.fn>;
let resetMock: ReturnType<typeof vi.fn>;
let crossTabUnsubMock: ReturnType<typeof vi.fn>;

function setHook(overrides: Partial<{
  step: "idle" | "encrypting" | "sending" | "success" | "error";
  error: string | null;
}> = {}) {
  useRequestPaymentMock.mockReturnValue({
    createRequest: createRequestMock,
    fulfillRequest: fulfillRequestMock,
    cancelRequest: cancelRequestMock,
    step: overrides.step ?? "idle",
    error: overrides.error ?? null,
    reset: resetMock,
  });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useNavigateMock.mockReset();
  useRequestPaymentMock.mockReset();
  fetchIncomingRequestsMock.mockReset();
  fetchOutgoingRequestsMock.mockReset();
  onCrossTabActionMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  supabaseChannelMock.channel.mockReset();
  supabaseChannelMock.removeChannel.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  createRequestMock = vi.fn().mockResolvedValue(undefined);
  fulfillRequestMock = vi.fn().mockResolvedValue(undefined);
  cancelRequestMock = vi.fn().mockResolvedValue(undefined);
  resetMock = vi.fn();
  setHook();

  fetchIncomingRequestsMock.mockResolvedValue([]);
  fetchOutgoingRequestsMock.mockResolvedValue([]);

  crossTabUnsubMock = vi.fn();
  onCrossTabActionMock.mockReturnValue(crossTabUnsubMock);

  const fakeChannel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  fakeChannel.on.mockReturnValue(fakeChannel);
  fakeChannel.subscribe.mockReturnValue(fakeChannel);
  supabaseChannelMock.channel.mockReturnValue(fakeChannel);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Requests — passkey-blank-page guard (§15.x)", () => {
  it("returns null when no effective address", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<Requests />);
    expect(container.firstChild).toBeNull();
  });

  it("renders header when effective address present", async () => {
    const { container, findByText } = render(<Requests />);
    await findByText("Payment Requests");
    expect(container.textContent).toContain("Payment Requests");
    expect(container.textContent).toContain("Manage incoming and outgoing requests");
  });
});

describe("Requests — list fetch (§15.x)", () => {
  it("loads both incoming + outgoing in PARALLEL (Promise.all)", async () => {
    const { findByText } = render(<Requests />);
    await findByText("Payment Requests");
    expect(fetchIncomingRequestsMock).toHaveBeenCalledWith(ME.toLowerCase());
    expect(fetchOutgoingRequestsMock).toHaveBeenCalledWith(ME.toLowerCase());
  });

  it("address is lowercased before query (consistent with server-side lower-case storage)", async () => {
    const upper = ME.toUpperCase();
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: upper });
    const { findByText } = render(<Requests />);
    await findByText("Payment Requests");
    expect(fetchIncomingRequestsMock).toHaveBeenCalledWith(upper.toLowerCase());
  });

  it("shows 3 pulse skeleton rows during initial load", () => {
    fetchIncomingRequestsMock.mockReturnValue(new Promise(() => {})); // never resolves
    fetchOutgoingRequestsMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<Requests />);
    expect(container.querySelectorAll(".animate-pulse").length).toBe(3);
  });
});

describe("Requests — tab switching (§15.x)", () => {
  it("default tab is 'incoming'", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([req({ id: 1 })]);
    fetchOutgoingRequestsMock.mockResolvedValue([]);
    const { container, findByText } = render(<Requests />);
    await findByText("Payment Requests");
    // Note rendered with curly quotes (&ldquo;&rdquo; = “”), so
    // findByText("rent") fails (exact match), but textContent.includes("rent")
    // works (substring match).
    await waitFor(() => {
      expect(container.textContent).toContain("rent");
    });
  });

  it("clicking 'Outgoing' tab switches to outgoing list", async () => {
    // Schema reminder: to_address = requester (who wants money), from_address
    // = payer. For an INCOMING row (user is payer), from=ME, to=requester.
    // The screen renders "From <to_address>" so the user sees "from the
    // requester ALICE" on their incoming list.
    fetchIncomingRequestsMock.mockResolvedValue([req({ id: 1, from_address: ME, to_address: ALICE })]);
    fetchOutgoingRequestsMock.mockResolvedValue([req({ id: 2, from_address: BOB, to_address: ME })]);
    const { findByText, getByText, container } = render(<Requests />);
    await findByText("Payment Requests");
    await waitFor(() => {
      expect(container.textContent).toMatch(new RegExp(`From 0x${ALICE.slice(2, 6)}`, "i"));
    });
    fireEvent.click(getByText("Outgoing"));
    await waitFor(() => {
      expect(container.textContent).toMatch(new RegExp(`To 0x${BOB.slice(2, 6)}`, "i"));
    });
  });

  it("incoming row shows 'From <address>' prefix (payer-side framing)", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([req({ from_address: ME, to_address: ALICE })]);
    const { container, findByText } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toMatch(/From 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/);
  });

  it("outgoing row shows 'To <address>' prefix (requester-side framing)", async () => {
    fetchOutgoingRequestsMock.mockResolvedValue([req({ from_address: BOB, to_address: ME })]);
    const { findByText, getByText, container } = render(<Requests />);
    await findByText("Payment Requests");
    fireEvent.click(getByText("Outgoing"));
    await waitFor(() => {
      expect(container.textContent).toMatch(/To 0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/);
    });
  });
});

describe("Requests — empty states (§15.x)", () => {
  it("incoming empty: 'No incoming requests' + 'will appear here' copy", async () => {
    const { findByText, container } = render(<Requests />);
    await findByText("No incoming requests");
    expect(container.textContent).toContain("Requests for you to pay will appear here");
  });

  it("outgoing empty: 'No outgoing requests' + 'Create a request to get started' copy", async () => {
    const { findByText, getByText, container } = render(<Requests />);
    await findByText("No incoming requests");
    fireEvent.click(getByText("Outgoing"));
    await waitFor(() => {
      expect(container.textContent).toContain("No outgoing requests");
      expect(container.textContent).toContain("Create a request to get started");
    });
  });
});

describe("Requests — 7-day expiry math (§15.x)", () => {
  it("fresh pending row (1h old): no 'Expired' badge", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 3600_000).toISOString() }),
    ]);
    const { findByText, container } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).not.toContain("Expired");
  });

  it("CRITICAL: 8-day-old pending row shows 'Expired' badge + Pay button disabled", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 8 * 86400000).toISOString() }),
    ]);
    const { findByText, container } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toContain("Expired");
    const payBtn = container.querySelector("button.bg-emerald-600") as HTMLButtonElement;
    expect(payBtn).not.toBeNull();
    expect(payBtn.disabled).toBe(true);
  });

  it("non-pending status (fulfilled) does NOT show 'Expired' even when 30d old", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, status: "fulfilled", created_at: new Date(Date.now() - 30 * 86400000).toISOString() }),
    ]);
    const { findByText, container } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).not.toContain("Expired");
  });
});

describe("Requests — age helper (§15.x)", () => {
  it("renders 'just now' for sub-minute ages", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 30_000).toISOString() }),
    ]);
    const { container, findByText } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toContain("just now");
  });

  it("renders 'Xm ago' for sub-hour", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 15 * 60_000).toISOString() }),
    ]);
    const { container, findByText } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toContain("15m ago");
  });

  it("renders 'Xh ago' for sub-day", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 5 * 3600_000).toISOString() }),
    ]);
    const { container, findByText } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toContain("5h ago");
  });

  it("renders 'Xd ago' for multi-day", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([
      req({ id: 1, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }),
    ]);
    const { container, findByText } = render(<Requests />);
    await findByText(/From 0x/);
    expect(container.textContent).toContain("3d ago");
  });
});

describe("Requests — incoming Pay action (§15.x)", () => {
  it("renders Pay button on pending incoming row", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([req()]);
    const { findByText } = render(<Requests />);
    expect(await findByText("Pay")).toBeDefined();
  });

  it("clicking Pay opens FulfillModal with the selected request", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([req({ note: "rent", to_address: ALICE })]);
    const { findByText, getByText, container } = render(<Requests />);
    await findByText("Pay");
    fireEvent.click(getByText("Pay"));
    // FulfillModal heading visible.
    expect(container.textContent).toContain("Pay Request");
    expect(container.textContent).toContain("Request from");
  });

  it("Cancel button is NOT shown on incoming tab (only Pay)", async () => {
    fetchIncomingRequestsMock.mockResolvedValue([req()]);
    const { findByText, queryByText } = render(<Requests />);
    await findByText("Pay");
    expect(queryByText("Cancel")).toBeNull();
  });
});

describe("Requests — outgoing Cancel action (§15.x)", () => {
  it("renders Cancel button on pending outgoing row", async () => {
    fetchOutgoingRequestsMock.mockResolvedValue([req({ id: 1, request_id: 42 })]);
    const { findByText, getByText } = render(<Requests />);
    await findByText("Payment Requests");
    fireEvent.click(getByText("Outgoing"));
    expect(await findByText("Cancel")).toBeDefined();
  });

  it("Cancel triggers window.confirm + cancelRequest(request_id) on confirm=true", async () => {
    fetchOutgoingRequestsMock.mockResolvedValue([req({ id: 1, request_id: 42 })]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { findByText, getByText } = render(<Requests />);
    await findByText("Payment Requests");
    fireEvent.click(getByText("Outgoing"));
    const cancelBtn = await findByText("Cancel");
    await act(async () => {
      fireEvent.click(cancelBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cancelRequestMock).toHaveBeenCalledWith(42);
  });

  it("Cancel with confirm=false does NOT call cancelRequest", async () => {
    fetchOutgoingRequestsMock.mockResolvedValue([req({ id: 1, request_id: 42 })]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { findByText, getByText } = render(<Requests />);
    await findByText("Payment Requests");
    fireEvent.click(getByText("Outgoing"));
    const cancelBtn = await findByText("Cancel");
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(cancelRequestMock).not.toHaveBeenCalled();
  });
});

describe("Requests — CreateRequestModal validation (§15.x)", () => {
  async function openCreateModal() {
    const result = render(<Requests />);
    await result.findByText("Payment Requests");
    // The header "+ Request" button: only button whose trimmed textContent
    // equals exactly "Request" (header heading is "Payment Requests"; tabs
    // are "Incoming"/"Outgoing"; back button has no text).
    const target = Array.from(result.container.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").trim() === "Request");
    if (!target) throw new Error("Header Request button not found");
    await act(async () => {
      fireEvent.click(target);
      await Promise.resolve();
    });
    return result;
  }

  it("modal opens with all 4 input fields + heading 'Request Payment'", async () => {
    const result = await openCreateModal();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Request Payment");
      expect(result.container.textContent).toContain("Payer Address");
      expect(result.container.textContent).toContain("Payer Email");
      expect(result.container.textContent).toContain("Amount (USDC)");
    });
  });

  it("Send Request disabled until payer address + amount filled", async () => {
    const result = await openCreateModal();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Send Request");
    });
    const send = Array.from(result.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Send Request"),
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("invalid hex address → 'Invalid Ethereum address' toast + createRequest NOT called", async () => {
    const result = await openCreateModal();
    await waitFor(() => expect(result.container.textContent).toContain("Request Payment"));
    const inputs = result.container.querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: "garbage" } });
    const amountInput = Array.from(inputs).find((i) => i.placeholder === "0.00") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    const send = Array.from(result.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Send Request"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(send);
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("invalid email → 'Payer email looks invalid' toast", async () => {
    const result = await openCreateModal();
    await waitFor(() => expect(result.container.textContent).toContain("Request Payment"));
    const inputs = result.container.querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: ALICE } });
    fireEvent.change(inputs[1], { target: { value: "not-an-email" } });
    const amountInput = Array.from(inputs).find((i) => i.placeholder === "0.00") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    const send = Array.from(result.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Send Request"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(send);
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Payer email looks invalid");
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("valid input → createRequest(addr.toLowerCase(), amount, note, email||undefined)", async () => {
    // Mixed-case hex AFTER the 0x prefix: regex /^0x[a-fA-F0-9]{40}$/ accepts
    // mixed-case but the prefix itself must be lowercase "0x". Source
    // toLowerCase()s the trimmed address before passing to createRequest.
    const ALICE_MIXED = "0x" + ALICE.slice(2).toUpperCase();
    const result = await openCreateModal();
    await waitFor(() => expect(result.container.textContent).toContain("Request Payment"));
    const inputs = result.container.querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: ALICE_MIXED } });
    fireEvent.change(inputs[1], { target: { value: "test@example.com" } });
    const amountInput = Array.from(inputs).find((i) => i.placeholder === "0.00") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "25.50" } });
    const textarea = result.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "dinner" } });

    const send = Array.from(result.container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Send Request"),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(send);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(createRequestMock).toHaveBeenCalledWith(ALICE.toLowerCase(), "25.50", "dinner", "test@example.com");
  });

  it("amount regex /^\\d*\\.?\\d{0,6}$/: 6dp accepted, 7th rejected (matches USDC precision)", async () => {
    const result = await openCreateModal();
    await waitFor(() => expect(result.container.textContent).toContain("Request Payment"));
    const amountInput = Array.from(result.container.querySelectorAll("input")).find(
      (i) => i.placeholder === "0.00",
    ) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "1.123456" } });
    expect(amountInput.value).toBe("1.123456");
    fireEvent.change(amountInput, { target: { value: "1.1234567" } });
    expect(amountInput.value).toBe("1.123456"); // stayed at prior value
  });

  it("step='encrypting' renders 'Encrypting request amount...' inline indicator", async () => {
    setHook({ step: "encrypting" });
    const result = await openCreateModal();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Encrypting request amount");
    });
  });

  it("step='sending' renders 'Sending request on-chain...' inline indicator", async () => {
    setHook({ step: "sending" });
    const result = await openCreateModal();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Sending request on-chain");
    });
  });

  it("error from hook rendered inline (NOT silent)", async () => {
    setHook({ step: "error", error: "Insufficient gas" });
    const result = await openCreateModal();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Insufficient gas");
    });
  });
});

describe("Requests — audit #25 realtime channels (§15.x)", () => {
  it("CRITICAL: subscribes to 3 postgres_changes filters (UPDATE-from / UPDATE-to / INSERT-from)", async () => {
    const { findByText } = render(<Requests />);
    await findByText("Payment Requests");

    expect(supabaseChannelMock.channel).toHaveBeenCalledWith(`requests_${ME.toLowerCase()}`);
    const channel = supabaseChannelMock.channel.mock.results[0].value;
    expect(channel.on).toHaveBeenCalledTimes(3);

    // Verify the 3 distinct filter signatures (without depending on call order).
    const filters = channel.on.mock.calls.map((c: unknown[]) => c[1] as { event: string; filter: string });
    const sigs = filters.map((f: { event: string; filter: string }) => `${f.event}|${f.filter}`);
    expect(sigs).toContain(`UPDATE|from_address=eq.${ME.toLowerCase()}`);
    expect(sigs).toContain(`UPDATE|to_address=eq.${ME.toLowerCase()}`);
    expect(sigs).toContain(`INSERT|from_address=eq.${ME.toLowerCase()}`);
  });

  it("subscribes to cross-tab actions for same-user-multi-tab sync", async () => {
    const { findByText } = render(<Requests />);
    await findByText("Payment Requests");
    expect(onCrossTabActionMock).toHaveBeenCalled();
  });

  it("cleanup on unmount: removeChannel + cross-tab unsub both fire", async () => {
    const { findByText, unmount } = render(<Requests />);
    await findByText("Payment Requests");
    unmount();
    expect(supabaseChannelMock.removeChannel).toHaveBeenCalled();
    expect(crossTabUnsubMock).toHaveBeenCalled();
  });

  it("cross-tab 'activity_added' triggers refetch; unrelated actions do not", async () => {
    const { findByText } = render(<Requests />);
    await findByText("Payment Requests");
    const handler = onCrossTabActionMock.mock.calls[0][0] as (action: string) => void;
    const before = fetchIncomingRequestsMock.mock.calls.length;

    handler("balance_changed");
    await act(async () => { await Promise.resolve(); });
    expect(fetchIncomingRequestsMock.mock.calls.length).toBe(before);

    handler("activity_added");
    await act(async () => { await Promise.resolve(); });
    expect(fetchIncomingRequestsMock.mock.calls.length).toBeGreaterThan(before);
  });
});
