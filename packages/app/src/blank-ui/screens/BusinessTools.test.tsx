import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";

// §15.x test for BusinessTools screen — vendor/client invoice flow, encrypted
// payroll (≤30 employees), and 3-role escrow (depositor + beneficiary +
// optional arbiter). Heavy 3-tab screen with 3 distinct modal forms.
//
// CRITICAL pins:
//   - loadData via Promise.all + dedup on invoice.id (vendor + client rows
//     may overlap when the user is BOTH on the same invoice — never seen
//     in production but the dedup is defensive). Step transitions to
//     "success" trigger an automatic loadData refetch via the second
//     useEffect so completed actions surface immediately.
//   - realtime: SIX channel subscriptions per address (insert + update for
//     each of arbiter/depositor/beneficiary). Without the ARBITER channel,
//     a vendor who's been named as arbiter never sees the escrow until
//     manual reload — the actionable surface (Release/Return) is hidden.
//   - MAX_PAYROLL_SIZE = 30: addresses.length > 30 -> "Maximum 30 employees
//     per payroll batch" toast (audit: above 30 the FHE encryption batch
//     blows the gas budget on Sepolia).
//   - handleCreateInvoice 3-branch validation: empty client/amount,
//     invalid hex via isAddress(), malformed email (regex check only when
//     trimmed email present — empty email is OK because client_email is
//     optional). Email regex fails closed: better to toast than to send a
//     bad invoice.
//   - handleRunPayroll 4-branch validation: zero addresses, count mismatch
//     (addresses.length !== amounts.length), > MAX_PAYROLL_SIZE, invalid
//     hex via isAddress(). The invalid-hex branch names WHICH address is
//     bad ("Invalid address: 0x...") so the user knows where to look.
//   - audit #216 formatDeadline: relative phrase + canonical UTC absolute
//     timestamp. Without UTC, "due today" disagrees by 24h between Tokyo
//     and LA viewers of the same row (the vendor in JP, client in CA).
//     This is the load-bearing fix for cross-timezone invoice reading.
//   - escrowFilter 3-state ("all" / "mine" / "arbitrating") — "arbitrating"
//     filters to escrows where the current user is the named arbiter; the
//     arbitratingCount badge surfaces unread arbiter work even when the
//     user is on the "mine" tab. Both filters use case-INsensitive address
//     compare so checksummed addresses still match.
//   - handleReleaseFunds role-routes by checking beneficiary_address vs
//     depositor_address against the connected address (case-insensitive).
//     Calling both unconditionally breaks the depositor path —
//     markDelivered reverts with "not beneficiary". Wrong role -> "You
//     are neither beneficiary nor depositor" toast.
//   - CSV upload (#256): comma-separated `address,amount` rows; header
//     row auto-detected via first-cell non-hex/non-numeric check; comments
//     starting with `#` stripped; valid rows populate addresses + amounts
//     textareas; zero valid rows -> "CSV had no valid rows" toast. The
//     header-detection heuristic is load-bearing: pasting a real CSV with
//     "address,amount" header line would otherwise drop the first
//     employee.
//   - Pay-invoice 3-mode flow (#payMode standard / swap / oracle). Standard
//     uses FHE-encrypted vault path; swap uses Uniswap router (gated on
//     publicClient + payAltToken + payInvoiceAmount, debounced 500ms);
//     oracle uses backend-signed price quote bound to (payer + invoiceId +
//     payToken + amount + chainId + businessHub) so substitution attacks
//     fail.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useBusinessHubMock = vi.hoisted(() => vi.fn());
const useActivityFeedMock = vi.hoisted(() => vi.fn());
const useRealtimeMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const fetchVendorInvoicesMock = vi.hoisted(() => vi.fn());
const fetchClientInvoicesMock = vi.hoisted(() => vi.fn());
const fetchUserEscrowsMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useBusinessHub", () => ({ useBusinessHub: useBusinessHubMock }));
vi.mock("@/hooks/useActivityFeed", () => ({ useActivityFeed: useActivityFeedMock }));
vi.mock("@/providers/RealtimeProvider", () => ({ useRealtime: useRealtimeMock }));
vi.mock("@/lib/supabase", () => ({
  fetchVendorInvoices: fetchVendorInvoicesMock,
  fetchClientInvoices: fetchClientInvoicesMock,
  fetchUserEscrows: fetchUserEscrowsMock,
}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/blank-ui/components/CopyInvoiceLink", () => ({
  CopyInvoiceLink: ({ invoiceId }: { invoiceId: number }) => (
    <div data-testid={`copy-invoice-link-${invoiceId}`} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock, loading: vi.fn() },
}));

import BusinessTools from "./BusinessTools";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc";
const CAROL = "0xdddddddddddddddddddddddddddddddddddddddd";

function invoiceRow(over: Partial<{
  id: string;
  invoice_id: number;
  vendor_address: string;
  client_address: string;
  description: string;
  due_date: string | null;
  status: "pending" | "paid" | "cancelled" | "payment_pending" | "disputed";
}> = {}) {
  // Spread `over` AFTER defaults so an explicit `due_date: null` survives
  // (nullish-coalescing `?? default` would otherwise replace null with the
  // 7-days-from-now default).
  return {
    id: `inv-${over.invoice_id ?? 1}`,
    invoice_id: 1,
    vendor_address: ME,
    client_address: ALICE,
    description: "Design work",
    due_date: new Date(Date.now() + 7 * 86400_000).toISOString() as string | null,
    status: "pending" as const,
    tx_hash: "0x1234",
    chain_id: 11155111,
    pdf_cid: null,
    client_email: null,
    vendor_email: null,
    last_reminder_at: null,
    created_at: new Date(Date.now() - 86400_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function escrowRow(over: Partial<{
  id: string;
  escrow_id: number;
  depositor_address: string;
  beneficiary_address: string;
  arbiter_address: string;
  description: string;
  deadline: string | null;
  status: "active" | "released" | "disputed" | "expired";
}> = {}) {
  return {
    id: `esc-${over.escrow_id ?? 1}`,
    escrow_id: over.escrow_id ?? 1,
    depositor_address: over.depositor_address ?? ME,
    beneficiary_address: over.beneficiary_address ?? ALICE,
    arbiter_address: over.arbiter_address ?? "",
    description: over.description ?? "Project X",
    plaintext_amount: undefined,
    deadline: over.deadline ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
    status: over.status ?? "active",
    tx_hash: "0x1234",
    chain_id: 11155111,
    attachment_cid: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const createInvoiceMock = vi.fn();
const runPayrollMock = vi.fn();
const createEscrowMock = vi.fn();
const finalizeInvoiceMock = vi.fn();
const markDeliveredMock = vi.fn();
const approveReleaseMock = vi.fn();
const disputeEscrowMock = vi.fn();
const payInvoiceMock = vi.fn();
const payInvoiceWithSwapMock = vi.fn();
const payInvoiceWithOracleQuoteMock = vi.fn();
const cancelInvoiceMock = vi.fn();
const arbiterDecideMock = vi.fn();
const claimExpiredEscrowMock = vi.fn();
const subscribeMock = vi.fn().mockReturnValue(vi.fn());

function setHub(over: Record<string, unknown> = {}) {
  useBusinessHubMock.mockReturnValue({
    step: "idle",
    createInvoice: createInvoiceMock,
    runPayroll: runPayrollMock,
    createEscrow: createEscrowMock,
    finalizeInvoice: finalizeInvoiceMock,
    markDelivered: markDeliveredMock,
    approveRelease: approveReleaseMock,
    disputeEscrow: disputeEscrowMock,
    payInvoice: payInvoiceMock,
    payInvoiceWithSwap: payInvoiceWithSwapMock,
    payInvoiceWithOracleQuote: payInvoiceWithOracleQuoteMock,
    cancelInvoice: cancelInvoiceMock,
    arbiterDecide: arbiterDecideMock,
    claimExpiredEscrow: claimExpiredEscrowMock,
    ...over,
  });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useBusinessHubMock.mockReset();
  useActivityFeedMock.mockReset();
  useRealtimeMock.mockReset();
  usePublicClientMock.mockReset();
  fetchVendorInvoicesMock.mockReset();
  fetchClientInvoicesMock.mockReset();
  fetchUserEscrowsMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  createInvoiceMock.mockReset();
  runPayrollMock.mockReset();
  createEscrowMock.mockReset();
  finalizeInvoiceMock.mockReset();
  markDeliveredMock.mockReset();
  approveReleaseMock.mockReset();
  disputeEscrowMock.mockReset();
  payInvoiceMock.mockReset();
  payInvoiceWithSwapMock.mockReset();
  payInvoiceWithOracleQuoteMock.mockReset();
  cancelInvoiceMock.mockReset();
  arbiterDecideMock.mockReset();
  claimExpiredEscrowMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(vi.fn());

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: {
      BusinessHub: "0x9999999999999999999999999999999999999999",
      TestUSDC: "0x1111111111111111111111111111111111111111",
      FHERC20Vault_USDC: "0x2222222222222222222222222222222222222222",
    },
  });
  useActivityFeedMock.mockReturnValue({ activities: [], isLoading: false });
  useRealtimeMock.mockReturnValue({ subscribe: subscribeMock });
  usePublicClientMock.mockReturnValue(null);
  fetchVendorInvoicesMock.mockResolvedValue([]);
  fetchClientInvoicesMock.mockResolvedValue([]);
  fetchUserEscrowsMock.mockResolvedValue([]);
  setHub();
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

// ----- page chrome + tabs ----- //

describe("BusinessTools — page chrome (§15.x)", () => {
  it("renders 'Business Tools' heading + privacy subtitle", async () => {
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Business Tools");
    expect(container.textContent).toContain(
      "Manage invoices, payroll, and escrow with financial privacy",
    );
  });

  it("renders 3 tabs: Invoices / Payroll / Escrow with default = Invoices selected", async () => {
    const { container } = render(<BusinessTools />);
    await flush();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
      .filter((t) => ["Invoices", "Payroll", "Escrow"].includes(t.textContent?.trim() ?? ""));
    expect(tabs).toHaveLength(3);
    const invoicesTab = tabs.find((t) => t.textContent === "Invoices");
    expect(invoicesTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("tab click flips active tab + content", async () => {
    const { container } = render(<BusinessTools />);
    await flush();
    const payrollTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Payroll") as HTMLButtonElement;
    fireEvent.click(payrollTab);
    expect(payrollTab.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Run encrypted payroll");
  });

  it("step in progress -> isProcessing banner with state-specific copy", async () => {
    setHub({ step: "approving" });
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Approving vault access");
    setHub({ step: "encrypting" });
    const r2 = render(<BusinessTools />);
    await flush();
    expect(r2.container.textContent).toContain("Encrypting amounts with FHE");
    setHub({ step: "sending" });
    const r3 = render(<BusinessTools />);
    await flush();
    expect(r3.container.textContent).toContain("Submitting transaction");
  });
});

// ----- loadData + dedup + step="success" refetch ----- //

describe("BusinessTools — loadData lifecycle (§15.x)", () => {
  it("mount triggers fetchVendorInvoices + fetchClientInvoices + fetchUserEscrows in parallel", async () => {
    render(<BusinessTools />);
    await flush();
    expect(fetchVendorInvoicesMock).toHaveBeenCalledWith(ME.toLowerCase());
    expect(fetchClientInvoicesMock).toHaveBeenCalledWith(ME.toLowerCase());
    expect(fetchUserEscrowsMock).toHaveBeenCalledWith(ME.toLowerCase());
  });

  it("no address -> skip all fetches", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    render(<BusinessTools />);
    await flush();
    expect(fetchVendorInvoicesMock).toHaveBeenCalledTimes(0);
    expect(fetchClientInvoicesMock).toHaveBeenCalledTimes(0);
    expect(fetchUserEscrowsMock).toHaveBeenCalledTimes(0);
  });

  it("dedupes by invoice id when vendor + client lists overlap (same invoice in both)", async () => {
    const shared = invoiceRow({ invoice_id: 7, description: "DEDUPED" });
    fetchVendorInvoicesMock.mockResolvedValue([shared]);
    fetchClientInvoicesMock.mockResolvedValue([shared]); // same id appears twice
    const { container } = render(<BusinessTools />);
    await flush();
    const rows = container.textContent?.match(/DEDUPED/g);
    expect(rows).toHaveLength(1);
  });

  it("fetch rejection -> 'Failed to load data. Tap to retry.' + retry button calls loadData", async () => {
    fetchVendorInvoicesMock.mockRejectedValue(new Error("offline"));
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Failed to load data");
    fetchVendorInvoicesMock.mockResolvedValue([]);
    fetchClientInvoicesMock.mockResolvedValue([]);
    fetchUserEscrowsMock.mockResolvedValue([]);
    const before = fetchVendorInvoicesMock.mock.calls.length;
    const retryBtn = container.querySelector(".text-red-500") as HTMLButtonElement;
    fireEvent.click(retryBtn);
    await flush();
    expect(fetchVendorInvoicesMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("step transitions to 'success' -> automatic loadData refetch", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([]);
    const { rerender } = render(<BusinessTools />);
    await flush();
    const before = fetchVendorInvoicesMock.mock.calls.length;
    setHub({ step: "success" });
    rerender(<BusinessTools />);
    await flush();
    expect(fetchVendorInvoicesMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("loading state shows 'Loading invoices...' spinner", async () => {
    fetchVendorInvoicesMock.mockReturnValue(new Promise(() => {}));
    fetchClientInvoicesMock.mockReturnValue(new Promise(() => {}));
    fetchUserEscrowsMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<BusinessTools />);
    expect(container.textContent).toContain("Loading invoices");
  });
});

// ----- realtime subscriptions (escrow channels) ----- //

describe("BusinessTools — realtime subscriptions (§15.x)", () => {
  it("subscribes to 6 channels: insert+update on arbiter/depositor/beneficiary", async () => {
    render(<BusinessTools />);
    await flush();
    expect(subscribeMock).toHaveBeenCalledTimes(6);
    const cols = subscribeMock.mock.calls.map((c) => c[1].filter.column);
    expect(cols.filter((c) => c === "arbiter_address")).toHaveLength(2);
    expect(cols.filter((c) => c === "depositor_address")).toHaveLength(2);
    expect(cols.filter((c) => c === "beneficiary_address")).toHaveLength(2);
  });

  it("each channel passes lowercased address as filter value", async () => {
    useEffectiveAddressMock.mockReturnValue({
      effectiveAddress: ME.toUpperCase().replace("0X", "0x"),
    });
    render(<BusinessTools />);
    await flush();
    for (const call of subscribeMock.mock.calls) {
      expect(call[1].filter.value).toBe(ME.toLowerCase());
    }
  });

  it("unmount calls every unsubscribe", async () => {
    const unsubs = Array.from({ length: 6 }, () => vi.fn());
    let i = 0;
    subscribeMock.mockImplementation(() => unsubs[i++]);
    const { unmount } = render(<BusinessTools />);
    await flush();
    unmount();
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });
});

// ----- Invoice tab ----- //

describe("BusinessTools — Invoices tab (§15.x)", () => {
  it("empty state -> 'No invoices yet' + 'Create your first invoice' CTA opens modal", async () => {
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("No invoices yet");
    fireEvent.click(findButton(container, "Create your first invoice"));
    expect(container.textContent).toContain("Client Wallet Address");
  });

  it("'New Invoice' header button opens modal", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([invoiceRow()]);
    const { container } = render(<BusinessTools />);
    await flush();
    fireEvent.click(findButton(container, "New Invoice"));
    expect(container.textContent).toContain("Client Wallet Address");
  });

  it("invoice row shows truncated client + due-date + status badge + masked encrypted amount", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ description: "Web work" }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain(ALICE.slice(0, 6));
    expect(container.textContent).toContain("Web work");
    // Status badge "pending"
    expect(container.textContent).toContain("pending");
    // Masked $•••••.•• 6-dot placeholder
    expect(container.textContent).toContain("•••••.••");
  });

  it("pending invoice + client === me -> 'Pay' button visible", async () => {
    fetchClientInvoicesMock.mockResolvedValue([
      invoiceRow({ client_address: ME, vendor_address: ALICE, status: "pending" }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Pay");
  });

  it("pending invoice + vendor === me -> Cancel + Preview link visible (no Pay)", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ vendor_address: ME, client_address: ALICE, status: "pending", invoice_id: 42 }),
    ]);
    const { container, getByTestId } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Cancel");
    expect(getByTestId("invoice-preview-42")).toBeTruthy();
    expect(getByTestId("copy-invoice-link-42")).toBeTruthy();
  });

  it("payment_pending + client === me -> 'Finalize' button", async () => {
    fetchClientInvoicesMock.mockResolvedValue([
      invoiceRow({ client_address: ME, status: "payment_pending" }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Finalize");
  });

  it("invoice preview link uses target='_blank' + rel='noopener noreferrer' (tabnabbing guard)", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ vendor_address: ME, status: "pending", invoice_id: 9 }),
    ]);
    const { getByTestId } = render(<BusinessTools />);
    await flush();
    const link = getByTestId("invoice-preview-9");
    expect(link.getAttribute("target")).toBe("_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("Load more reveals next 10 invoices when > INVOICE_PAGE_SIZE rows", async () => {
    fetchVendorInvoicesMock.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) =>
        invoiceRow({ invoice_id: i, description: `INV-${i}` }),
      ),
    );
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("INV-9");
    expect(container.textContent).not.toContain("INV-10");
    expect(container.textContent).toContain("Load more (5 remaining)");
    fireEvent.click(findButton(container, "Load more"));
    expect(container.textContent).toContain("INV-10");
  });
});

// ----- Invoice modal validation ----- //

describe("BusinessTools — Invoice modal validation (§15.x)", () => {
  async function openInvoiceModal() {
    const r = render(<BusinessTools />);
    await flush();
    fireEvent.click(findButton(r.container, "Create your first invoice"));
    return r;
  }

  it("empty client/amount -> Create disabled + no createInvoice call", async () => {
    const { container } = await openInvoiceModal();
    const createBtn = findButton(container, "Create Invoice");
    expect(createBtn.disabled).toBe(true);
    fireEvent.click(createBtn);
    await flush();
    expect(createInvoiceMock).toHaveBeenCalledTimes(0);
  });

  it("invalid hex address -> 'Invalid Ethereum address' toast (no createInvoice)", async () => {
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    const clientInput = inputs[0] as HTMLInputElement;
    fireEvent.change(clientInput, { target: { value: "not-hex" } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(createInvoiceMock).toHaveBeenCalledTimes(0);
  });

  it("malformed email -> 'Client email looks invalid' toast (no createInvoice)", async () => {
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    const clientInput = inputs[0] as HTMLInputElement;
    fireEvent.change(clientInput, { target: { value: ALICE } });
    const emailInput = Array.from(inputs).find((i) => i.type === "email") as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "bad-email" } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Client email looks invalid");
    expect(createInvoiceMock).toHaveBeenCalledTimes(0);
  });

  it("empty email is OK -> createInvoice called with undefined email", async () => {
    createInvoiceMock.mockResolvedValue(undefined);
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: ALICE } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    const descInput = inputs[3] as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Web design" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    expect(createInvoiceMock).toHaveBeenCalledWith(
      ALICE,
      "100",
      "Web design",
      expect.any(Number),
      undefined,
    );
  });

  it("valid email -> createInvoice called WITH email string", async () => {
    createInvoiceMock.mockResolvedValue(undefined);
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: ALICE } });
    const emailInput = Array.from(inputs).find((i) => i.type === "email") as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "alice@example.com" } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    expect(createInvoiceMock).toHaveBeenCalledWith(
      ALICE,
      "100",
      "Invoice",
      expect.any(Number),
      "alice@example.com",
    );
  });

  it("default description 'Invoice' when desc field empty", async () => {
    createInvoiceMock.mockResolvedValue(undefined);
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: ALICE } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    expect(createInvoiceMock.mock.calls[0][2]).toBe("Invoice");
  });

  it("due-date computed as now + N * 86400 from select value (in seconds)", async () => {
    createInvoiceMock.mockResolvedValue(undefined);
    const { container } = await openInvoiceModal();
    const inputs = container.querySelectorAll("input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: ALICE } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    // First <select> in modal is "Due in (days)"
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "60" } });
    fireEvent.click(findButton(container, "Create Invoice"));
    await flush();
    const dueDate = createInvoiceMock.mock.calls[0][3] as number;
    const nowSec = Math.floor(Date.now() / 1000);
    const expected = nowSec + 60 * 86400;
    expect(Math.abs(dueDate - expected)).toBeLessThan(5);
  });
});

// ----- Payroll tab + modal ----- //

describe("BusinessTools — Payroll tab + modal (§15.x)", () => {
  async function openPayrollModal() {
    const r = render(<BusinessTools />);
    await flush();
    const payrollTab = Array.from(r.container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Payroll") as HTMLButtonElement;
    fireEvent.click(payrollTab);
    await flush();
    // The empty-state CTA inside the EmptyState renders "Run Payroll" as
    // does the header. Pick the visible one inside the empty state card.
    const ctas = Array.from(r.container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"));
    fireEvent.click(ctas[0] as HTMLButtonElement);
    await flush();
    return r;
  }

  it("renders 'Run encrypted payroll' empty state with CTA", async () => {
    const { container } = render(<BusinessTools />);
    await flush();
    const payrollTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Payroll") as HTMLButtonElement;
    fireEvent.click(payrollTab);
    expect(container.textContent).toContain("Run encrypted payroll");
    expect(container.textContent).toContain("Each amount is FHE-encrypted client-side");
  });

  it("payroll history (from useActivityFeed payroll filter) renders when activities present", async () => {
    useActivityFeedMock.mockReturnValue({
      activities: [
        {
          id: "act-1",
          activity_type: "payroll",
          user_from: ME,
          user_to: ALICE,
          note: "March payroll",
          created_at: new Date().toISOString(),
        },
      ],
      isLoading: false,
    });
    const { container } = render(<BusinessTools />);
    await flush();
    const payrollTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Payroll") as HTMLButtonElement;
    fireEvent.click(payrollTab);
    expect(container.textContent).toContain("Payroll History");
    expect(container.textContent).toContain("March payroll");
  });

  it("zero addresses -> Run Payroll disabled", async () => {
    const { container } = await openPayrollModal();
    const submit = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"))
      .pop() as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("count mismatch (3 addr vs 2 amounts) -> 'must match number of amounts' toast", async () => {
    const { container } = await openPayrollModal();
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], {
      target: { value: `${ALICE}, ${BOB}, ${CAROL}` },
    });
    fireEvent.change(textareas[1], { target: { value: "100, 200" } });
    // Use the modal submit button (last "Run Payroll" in the modal)
    const submit = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"))
      .pop() as HTMLButtonElement;
    fireEvent.click(submit);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Number of addresses must match number of amounts",
    );
    expect(runPayrollMock).toHaveBeenCalledTimes(0);
  });

  it("MAX_PAYROLL_SIZE > 30 -> 'Maximum 30 employees' toast", async () => {
    const { container } = await openPayrollModal();
    const addrs = Array.from({ length: 31 }, (_, i) =>
      `0x${"a".repeat(39)}${i.toString(16).padStart(1, "0")}`,
    );
    const amts = Array.from({ length: 31 }, () => "100");
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], { target: { value: addrs.join(", ") } });
    fireEvent.change(textareas[1], { target: { value: amts.join(", ") } });
    const submit = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"))
      .pop() as HTMLButtonElement;
    fireEvent.click(submit);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Maximum 30 employees per payroll batch",
    );
    expect(runPayrollMock).toHaveBeenCalledTimes(0);
  });

  it("invalid hex address names WHICH address is bad in toast", async () => {
    const { container } = await openPayrollModal();
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], {
      target: { value: `${ALICE}, not-hex, ${CAROL}` },
    });
    fireEvent.change(textareas[1], { target: { value: "100, 200, 300" } });
    const submit = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"))
      .pop() as HTMLButtonElement;
    fireEvent.click(submit);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid address: not-hex");
    expect(runPayrollMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: runPayroll called with parsed addresses + amounts", async () => {
    runPayrollMock.mockResolvedValue(undefined);
    const { container } = await openPayrollModal();
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], { target: { value: `${ALICE}, ${BOB}` } });
    fireEvent.change(textareas[1], { target: { value: "100, 200" } });
    const submit = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"))
      .pop() as HTMLButtonElement;
    fireEvent.click(submit);
    await flush();
    expect(runPayrollMock).toHaveBeenCalledWith([ALICE, BOB], ["100", "200"]);
  });

  it("live preview renders X employees + counts-match indicator", async () => {
    const { container } = await openPayrollModal();
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], { target: { value: `${ALICE}, ${BOB}` } });
    fireEvent.change(textareas[1], { target: { value: "100, 200" } });
    expect(container.textContent).toContain("Preview (2 employees)");
    expect(container.textContent).toContain("counts match");
  });

  it("live preview shows count mismatch when addr count != amount count", async () => {
    const { container } = await openPayrollModal();
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[0], { target: { value: `${ALICE}, ${BOB}` } });
    fireEvent.change(textareas[1], { target: { value: "100" } });
    expect(container.textContent).toContain("count mismatch");
  });
});

// ----- CSV upload (#256) ----- //

describe("BusinessTools — payroll CSV upload (#256) (§15.x)", () => {
  async function openPayrollWithCsv(csvText: string) {
    const r = render(<BusinessTools />);
    await flush();
    const payrollTab = Array.from(r.container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Payroll") as HTMLButtonElement;
    fireEvent.click(payrollTab);
    await flush();
    const ctas = Array.from(r.container.querySelectorAll("button"))
      .filter((b) => b.textContent?.includes("Run Payroll"));
    fireEvent.click(ctas[0] as HTMLButtonElement);
    await flush();
    const fileInput = r.container.querySelector('input[type="file"][accept*="csv"]') as HTMLInputElement;
    const file = new File([csvText], "payroll.csv", { type: "text/csv" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();
    // FileReader async, give it a moment
    await new Promise<void>((res) => setTimeout(res, 50));
    await flush();
    return r;
  }

  it("plain CSV with addr,amount rows -> textareas populated", async () => {
    const csv = `${ALICE},100\n${BOB},200`;
    const { container } = await openPayrollWithCsv(csv);
    const textareas = container.querySelectorAll("textarea");
    expect((textareas[0] as HTMLTextAreaElement).value).toContain(ALICE);
    expect((textareas[0] as HTMLTextAreaElement).value).toContain(BOB);
    expect((textareas[1] as HTMLTextAreaElement).value).toContain("100");
    expect((textareas[1] as HTMLTextAreaElement).value).toContain("200");
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("Loaded 2 rows"));
  });

  it("header row detected + skipped (first cell not 0x and not numeric)", async () => {
    const csv = `address,amount\n${ALICE},100\n${BOB},200`;
    const { container } = await openPayrollWithCsv(csv);
    const textareas = container.querySelectorAll("textarea");
    expect((textareas[0] as HTMLTextAreaElement).value).toContain(ALICE);
    expect((textareas[0] as HTMLTextAreaElement).value).not.toContain("address");
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("Loaded 2 rows"));
  });

  it("# comment lines stripped", async () => {
    const csv = `# This is a comment\n${ALICE},100\n# another comment\n${BOB},200`;
    const { container } = await openPayrollWithCsv(csv);
    const textareas = container.querySelectorAll("textarea");
    expect((textareas[0] as HTMLTextAreaElement).value).not.toContain("comment");
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("Loaded 2 rows"));
  });

  it("zero valid rows -> 'CSV had no valid rows' toast", async () => {
    const csv = `# only comments\n# no data`;
    await openPayrollWithCsv(csv);
    expect(toastErrorMock).toHaveBeenCalledWith("CSV had no valid rows");
  });
});

// ----- Escrow tab + filter ----- //

describe("BusinessTools — Escrow filter (§15.x)", () => {
  async function openEscrowTab() {
    const r = render(<BusinessTools />);
    await flush();
    const tab = Array.from(r.container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Escrow") as HTMLButtonElement;
    fireEvent.click(tab);
    await flush();
    return r;
  }

  it("escrow tab renders 'all/mine/arbitrating' filter tabs", async () => {
    const { container } = await openEscrowTab();
    expect(container.textContent).toContain("All");
    expect(container.textContent).toContain("Mine");
    expect(container.textContent).toContain("Arbitrating");
  });

  it("arbitratingCount badge shows when escrows name me as arbiter", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({ escrow_id: 1, arbiter_address: ME }),
      escrowRow({ escrow_id: 2, arbiter_address: ME }),
      escrowRow({ escrow_id: 3, arbiter_address: ALICE }),
    ]);
    const { container } = await openEscrowTab();
    // Badge count "2" inside the Arbitrating tab
    const arbiterTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes("Arbitrating")) as HTMLButtonElement;
    expect(arbiterTab.textContent).toContain("2");
  });

  it("'mine' filter shows escrows where I'm depositor OR beneficiary", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({ escrow_id: 1, depositor_address: ME, description: "MINE-DEP" }),
      escrowRow({ escrow_id: 2, beneficiary_address: ME, description: "MINE-BEN" }),
      escrowRow({ escrow_id: 3, depositor_address: ALICE, beneficiary_address: BOB, description: "NOT-MINE" }),
    ]);
    const { container } = await openEscrowTab();
    const mineTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Mine") as HTMLButtonElement;
    fireEvent.click(mineTab);
    await flush();
    expect(container.textContent).toContain("MINE-DEP");
    expect(container.textContent).toContain("MINE-BEN");
    expect(container.textContent).not.toContain("NOT-MINE");
  });

  it("'arbitrating' filter shows escrows where I'm the named arbiter", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 1,
        depositor_address: ALICE,
        beneficiary_address: BOB,
        arbiter_address: ME,
        description: "AS-ARBITER",
      }),
      escrowRow({
        escrow_id: 2,
        depositor_address: ALICE,
        beneficiary_address: BOB,
        description: "OTHER",
      }),
    ]);
    const { container } = await openEscrowTab();
    const arbiterTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes("Arbitrating")) as HTMLButtonElement;
    fireEvent.click(arbiterTab);
    await flush();
    expect(container.textContent).toContain("AS-ARBITER");
    expect(container.textContent).not.toContain("OTHER");
  });

  it("empty 'arbitrating' state -> 'No escrows to arbitrate' copy + onboarding hint", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({ depositor_address: ME }), // I'm depositor, not arbiter
    ]);
    const { container } = await openEscrowTab();
    const arbiterTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.includes("Arbitrating")) as HTMLButtonElement;
    fireEvent.click(arbiterTab);
    await flush();
    expect(container.textContent).toContain("No escrows to arbitrate");
    expect(container.textContent).toContain("when someone names you as their arbiter");
  });

  it("escrow card with arbiter=me shows 'You are arbiter' chip", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 1,
        depositor_address: ALICE,
        beneficiary_address: BOB,
        arbiter_address: ME,
      }),
    ]);
    const { container } = await openEscrowTab();
    expect(container.textContent).toContain("You are arbiter");
  });

  it("active escrow renders Release Funds + Dispute buttons", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({ depositor_address: ME, status: "active" }),
    ]);
    const { container } = await openEscrowTab();
    expect(container.textContent).toContain("Release Funds");
    expect(container.textContent).toContain("Dispute");
  });

  it("released escrow renders green Released checkmark (no actions)", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({ depositor_address: ME, status: "released" }),
    ]);
    const { container } = await openEscrowTab();
    expect(container.textContent).toContain("Released");
    expect(container.textContent).not.toContain("Release Funds");
  });
});

// ----- audit #216 formatDeadline ----- //

describe("BusinessTools — audit #216 formatDeadline (§15.x)", () => {
  it("includes 'UTC' suffix for cross-timezone clarity", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ due_date: new Date(Date.now() + 7 * 86400_000).toISOString() }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("UTC");
  });

  it("includes relative phrase (in N days / hours)", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ due_date: new Date(Date.now() + 5 * 86400_000).toISOString() }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toMatch(/in \d+ (day|days|hour|hours)/);
  });

  it("invalid date -> 'Invalid date' (no crash)", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([
      invoiceRow({ due_date: "not-a-date" }),
    ]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("Invalid date");
  });

  it("null due_date -> 'No deadline'", async () => {
    fetchVendorInvoicesMock.mockResolvedValue([invoiceRow({ due_date: null })]);
    const { container } = render(<BusinessTools />);
    await flush();
    expect(container.textContent).toContain("No deadline");
  });
});

// ----- Escrow role-routing (Release Funds) ----- //

describe("BusinessTools — handleReleaseFunds role routing (§15.x)", () => {
  async function openEscrowTab() {
    const r = render(<BusinessTools />);
    await flush();
    const tab = Array.from(r.container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Escrow") as HTMLButtonElement;
    fireEvent.click(tab);
    await flush();
    return r;
  }

  it("beneficiary clicks Release Funds -> markDelivered called (NOT approveRelease)", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 5,
        depositor_address: ALICE,
        beneficiary_address: ME,
        status: "active",
      }),
    ]);
    markDeliveredMock.mockResolvedValue(undefined);
    const { container } = await openEscrowTab();
    fireEvent.click(findButton(container, "Release Funds"));
    await flush();
    expect(markDeliveredMock).toHaveBeenCalledWith(5);
    expect(approveReleaseMock).toHaveBeenCalledTimes(0);
  });

  it("depositor clicks Release Funds -> approveRelease called (NOT markDelivered)", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 7,
        depositor_address: ME,
        beneficiary_address: ALICE,
        status: "active",
      }),
    ]);
    approveReleaseMock.mockResolvedValue(undefined);
    const { container } = await openEscrowTab();
    fireEvent.click(findButton(container, "Release Funds"));
    await flush();
    expect(approveReleaseMock).toHaveBeenCalledWith(7);
    expect(markDeliveredMock).toHaveBeenCalledTimes(0);
  });

  it("neither role (arbiter only) -> 'neither beneficiary nor depositor' toast", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 9,
        depositor_address: ALICE,
        beneficiary_address: BOB,
        arbiter_address: ME, // I'm arbiter, not depositor/beneficiary
        status: "active",
      }),
    ]);
    const { container } = await openEscrowTab();
    fireEvent.click(findButton(container, "Release Funds"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "You are neither beneficiary nor depositor of this escrow",
    );
    expect(markDeliveredMock).toHaveBeenCalledTimes(0);
    expect(approveReleaseMock).toHaveBeenCalledTimes(0);
  });

  it("Dispute click opens confirm dialog + Confirm fires disputeEscrow", async () => {
    fetchUserEscrowsMock.mockResolvedValue([
      escrowRow({
        escrow_id: 11,
        depositor_address: ME,
        beneficiary_address: ALICE,
        status: "active",
      }),
    ]);
    disputeEscrowMock.mockResolvedValue(undefined);
    const { container } = await openEscrowTab();
    fireEvent.click(findButton(container, "Dispute"));
    await flush();
    expect(container.textContent).toContain("Dispute Escrow?");
    expect(container.textContent).toContain("cannot be undone");
    fireEvent.click(findButton(container, "Confirm Dispute"));
    await flush();
    expect(disputeEscrowMock).toHaveBeenCalledWith(11);
  });
});

// ----- Escrow modal ----- //

describe("BusinessTools — Escrow modal validation (§15.x)", () => {
  async function openEscrowModal() {
    const r = render(<BusinessTools />);
    await flush();
    const tab = Array.from(r.container.querySelectorAll('[role="tab"]'))
      .find((t) => t.textContent?.trim() === "Escrow") as HTMLButtonElement;
    fireEvent.click(tab);
    await flush();
    fireEvent.click(findButton(r.container, "New Escrow"));
    await flush();
    return r;
  }

  it("milestone template dropdown lists all MILESTONE_TEMPLATES", async () => {
    const { container } = await openEscrowModal();
    expect(container.textContent).toContain("Single milestone");
    expect(container.textContent).toContain("50% upfront");
    expect(container.textContent).toContain("33 / 33 / 33");
  });

  it("picking a multi-milestone template prepends [Step] to description", async () => {
    const { container } = await openEscrowModal();
    const selects = container.querySelectorAll("select");
    const templateSelect = selects[0] as HTMLSelectElement;
    fireEvent.change(templateSelect, { target: { value: "50-50" } });
    const descInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.placeholder === "Project milestone") as HTMLInputElement;
    expect(descInput.value.startsWith("[Upfront]")).toBe(true);
  });

  it("empty beneficiary/amount -> Create disabled + no createEscrow call", async () => {
    const { container } = await openEscrowModal();
    const submit = findButton(container, "Create Escrow");
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await flush();
    expect(createEscrowMock).toHaveBeenCalledTimes(0);
  });

  it("invalid beneficiary hex -> 'Invalid beneficiary address' toast", async () => {
    const { container } = await openEscrowModal();
    const inputs = container.querySelectorAll("input");
    const benInput = Array.from(inputs).find((i) =>
      i.placeholder === "0x...",
    ) as HTMLInputElement;
    fireEvent.change(benInput, { target: { value: "not-hex" } });
    const amountInput = Array.from(inputs).find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    fireEvent.click(findButton(container, "Create Escrow"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid beneficiary address");
    expect(createEscrowMock).toHaveBeenCalledTimes(0);
  });

  it("invalid arbiter hex (non-empty) -> 'Invalid arbiter address' toast", async () => {
    const { container } = await openEscrowModal();
    const inputs = container.querySelectorAll("input");
    const allInputs = Array.from(inputs);
    const benInput = allInputs.find((i) => i.placeholder === "0x...") as HTMLInputElement;
    fireEvent.change(benInput, { target: { value: ALICE } });
    const amountInput = allInputs.find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "100" } });
    const arbiterInput = allInputs.find((i) =>
      i.placeholder?.includes("leave empty"),
    ) as HTMLInputElement;
    fireEvent.change(arbiterInput, { target: { value: "not-hex" } });
    fireEvent.click(findButton(container, "Create Escrow"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid arbiter address");
    expect(createEscrowMock).toHaveBeenCalledTimes(0);
  });

  it("empty arbiter is OK (optional field) -> createEscrow called with empty string", async () => {
    createEscrowMock.mockResolvedValue(undefined);
    const { container } = await openEscrowModal();
    const allInputs = Array.from(container.querySelectorAll("input"));
    const benInput = allInputs.find((i) => i.placeholder === "0x...") as HTMLInputElement;
    fireEvent.change(benInput, { target: { value: ALICE } });
    const amountInput = allInputs.find((i) => i.type === "number") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "500" } });
    const descInput = allInputs.find((i) => i.placeholder === "Project milestone") as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Build X" } });
    fireEvent.click(findButton(container, "Create Escrow"));
    await flush();
    expect(createEscrowMock).toHaveBeenCalled();
    const args = createEscrowMock.mock.calls[0];
    expect(args[0]).toBe(ALICE);
    expect(args[1]).toBe("500");
    expect(args[2]).toBe("Build X");
    expect(args[3]).toBe(""); // empty arbiter
    expect(typeof args[4]).toBe("number"); // deadline unix seconds
  });
});
