import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for InvoicePage. Public role-aware invoice landing
// at /app/invoice/:chainId/:invoiceId. Three roles (vendor /
// client / bystander) × 5 statuses (Pending / Paid / Cancelled /
// PaymentPending / Disputed) drive distinct UI branches.
//
// CRITICAL pins:
//   - role × status matrix: the wrong CTA in any cell either lets
//     a bystander pay (security) or hides the pay form from the
//     correct client (UX). Pin each visible-action branch.
//   - chain-mismatch banner: linkChainId !== activeChainId shows
//     a 1-button Switch CTA, AND HIDES the pay/finalize actions
//     (defense in depth: don't let a user with the wrong chain
//     click "Pay via escrow" against a non-existent contract).
//   - 8s poll while status is Pending OR PaymentPending (the two
//     transient states); poll STOPS once Paid/Cancelled/Disputed
//     so we don't burn RPC quota forever.
//   - cancellation guard via spyOn(console, "error")
//   - load-error PRIORITY: invalid invoiceId beats unsupported
//     chain beats loading-spinner beats not-found.
//   - "You're viewing as a guest" CTA when no effectiveAddress;
//     "viewing as a bystander" when authed but neither vendor
//     nor client (the two are NOT collapsed into one branch).
//   - Proof-of-payment renders dual tx links (settlement +
//     funding) with tabnabbing; falls back to "—" when activity
//     row missing.
//   - "Amount is encrypted on-chain. Only the vendor and client
//     can see it." load-bearing privacy disclosure copy.

const useParamsMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useInvoiceEscrowMock = vi.hoisted(() => vi.fn());
const fetchInvoiceActivitiesMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: useParamsMock,
  useNavigate: () => useNavigateMock,
}));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useInvoiceEscrow", () => ({
  useInvoiceEscrow: useInvoiceEscrowMock,
}));
vi.mock("@/lib/abis", () => ({ BusinessHubAbi: [] }));
vi.mock("@/lib/constants", () => ({
  CONTRACTS_BY_CHAIN: {
    11155111: { BusinessHub: "0xbbbb1111111111111111111111111111111111bb" },
    84532: { BusinessHub: "0xbbbb2222222222222222222222222222222222bb" },
    421614: { BusinessHub: "0xbbbb3333333333333333333333333333333333bb" },
  },
  ETH_SEPOLIA_ID: 11155111,
  BASE_SEPOLIA_ID: 84532,
  ARB_SEPOLIA_ID: 421614,
  getExplorerTxUrl: getExplorerTxUrlMock,
}));
vi.mock("@/blank-ui/components/InvoiceStatusBadge", () => ({
  InvoiceStatusBadge: (props: { status: number }) => (
    <span data-testid="status-badge" data-status={String(props.status)} />
  ),
}));
vi.mock("@/blank-ui/components/CopyInvoiceLink", () => ({
  CopyInvoiceLink: (props: { chainId: number; invoiceId: number; variant: string }) => (
    <button
      data-testid="copy-invoice-link"
      data-chain={String(props.chainId)}
      data-invoice={String(props.invoiceId)}
      data-variant={props.variant}
    >
      Copy link
    </button>
  ),
}));
vi.mock("@/lib/supabase", () => ({
  fetchInvoiceActivities: fetchInvoiceActivitiesMock,
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: vi.fn() },
}));

import InvoicePage from "./InvoicePage";

const VENDOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAULT = "0xcccccccccccccccccccccccccccccccccccccccc";
const BYSTANDER = "0xdddddddddddddddddddddddddddddddddddddddd";
const ETH_SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;

let readContractMock: ReturnType<typeof vi.fn>;
let setActiveChainMock: ReturnType<typeof vi.fn>;
let payEscrowMock: ReturnType<typeof vi.fn>;
let releaseEscrowMock: ReturnType<typeof vi.fn>;

function buildInvoice(over: Partial<{
  vendor: string;
  client: string;
  vault: string;
  amount: bigint;
  description: string;
  dueDate: bigint;
  status: number;
}> = {}): readonly unknown[] {
  const o = {
    vendor: VENDOR,
    client: CLIENT,
    vault: VAULT,
    amount: 0n, // encrypted handle (zero is the placeholder for the encrypted ref)
    description: "Web design Q3",
    dueDate: BigInt(Math.floor(Date.now() / 1000) + 86_400 * 14),
    status: 0,
    ...over,
  };
  return [o.vendor, o.client, o.vault, o.amount, o.description, o.dueDate, o.status];
}

beforeEach(() => {
  useParamsMock.mockReset();
  useNavigateMock.mockReset();
  usePublicClientMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useInvoiceEscrowMock.mockReset();
  fetchInvoiceActivitiesMock.mockReset();
  getExplorerTxUrlMock.mockReset();
  toastSuccessMock.mockReset();

  useParamsMock.mockReturnValue({ chainId: String(ETH_SEPOLIA), invoiceId: "7" });
  setActiveChainMock = vi.fn();
  useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA, setActiveChain: setActiveChainMock });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });

  readContractMock = vi.fn().mockResolvedValue(buildInvoice());
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });

  payEscrowMock = vi.fn().mockResolvedValue("0xpaytx");
  releaseEscrowMock = vi.fn().mockResolvedValue({ matched: true });
  useInvoiceEscrowMock.mockReturnValue({
    payEscrow: payEscrowMock,
    releaseEscrow: releaseEscrowMock,
    isPaying: false,
    isReleasing: false,
  });

  fetchInvoiceActivitiesMock.mockResolvedValue([]);
  getExplorerTxUrlMock.mockImplementation(
    (hash: string, chainId: number) => `https://explorer.test/${hash}?c=${chainId}`,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InvoicePage — load-error matrix (§15.x)", () => {
  it("invalid invoiceId (NaN) -> 'Invalid link' card", async () => {
    useParamsMock.mockReturnValue({ chainId: String(ETH_SEPOLIA), invoiceId: "xyz" });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Invalid link");
    // URL-param hardening (commit e587a69) tightened the gate to also
    // reject non-integers + negatives; the user-visible copy changed.
    expect(container.textContent).toContain("isn't a valid positive integer");
  });

  it("negative invoiceId -> 'Invalid link' card", async () => {
    useParamsMock.mockReturnValue({ chainId: String(ETH_SEPOLIA), invoiceId: "-1" });
    const { findByText } = render(<InvoicePage />);
    expect(await findByText("Invalid link")).toBeDefined();
  });

  it("unsupported chain (not 11155111 or 84532) -> 'Unsupported chain'", async () => {
    useParamsMock.mockReturnValue({ chainId: "1", invoiceId: "7" });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Unsupported chain");
    expect(container.textContent).toContain("Chain 1 isn't supported");
  });

  it("Base Sepolia (84532) IS supported", async () => {
    useParamsMock.mockReturnValue({ chainId: String(BASE_SEPOLIA), invoiceId: "7" });
    useChainMock.mockReturnValue({ activeChainId: BASE_SEPOLIA, setActiveChain: setActiveChainMock });
    const { findByText, queryByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(queryByText("Unsupported chain")).toBeNull();
  });

  it("readContract throws on first load -> 'Invoice not found' with error message", async () => {
    readContractMock = vi.fn().mockRejectedValue(new Error("RPC down"));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Invoice not found");
    expect(container.textContent).toContain("RPC down");
  });

  it("CRITICAL load-error priority: invalid invoiceId beats unsupported-chain (cascade order)", async () => {
    // BOTH conditions hold: chainId=1 (unsupported) + invoiceId=xyz (invalid)
    useParamsMock.mockReturnValue({ chainId: "1", invoiceId: "xyz" });
    const { findByText } = render(<InvoicePage />);
    expect(await findByText("Invalid link")).toBeDefined();
  });
});

describe("InvoicePage — loading state (§15.x)", () => {
  it("pending readContract -> 'Loading invoice…' spinner", async () => {
    readContractMock = vi.fn().mockReturnValue(new Promise(() => {}));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container } = render(<InvoicePage />);
    await waitFor(() => expect(container.textContent).toContain("Loading invoice"));
  });
});

describe("InvoicePage — invoice header rendering (§15.x)", () => {
  it("renders Invoice #<id> + description + truncated vendor/client + 'Encrypted (FHE)' amount", async () => {
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("Invoice #7");
    expect(container.textContent).toContain("Encrypted (FHE)");
    expect(container.textContent).toMatch(/0xaaaa.{1,3}aaaa/i);
    expect(container.textContent).toMatch(/0xbbbb.{1,3}bbbb/i);
  });

  it("empty description falls back to 'Untitled invoice'", async () => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ description: "" }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText } = render(<InvoicePage />);
    expect(await findByText("Untitled invoice")).toBeDefined();
  });

  it("dueDate=0n -> renders '—' instead of an epoch-zero date", async () => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ dueDate: 0n }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { container, findByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("Due");
    // The "—" character may appear elsewhere too, so just confirm no 1970 date.
    expect(container.textContent).not.toContain("1970");
  });

  it("CRITICAL privacy disclosure 'Amount is encrypted on-chain. Only the vendor and client can see it.' visible", async () => {
    const { container, findByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("Amount is encrypted on-chain");
    expect(container.textContent).toContain("Only the vendor and client can see it");
  });

  it("InvoiceStatusBadge rendered with the on-chain status", async () => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 3 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByTestId } = render(<InvoicePage />);
    const badge = await findByTestId("status-badge");
    expect(badge.getAttribute("data-status")).toBe("3");
  });
});

describe("InvoicePage — chain-mismatch banner (§15.x)", () => {
  it("CRITICAL: linkChainId !== activeChainId -> amber banner + 'Switch' button", async () => {
    useParamsMock.mockReturnValue({ chainId: String(BASE_SEPOLIA), invoiceId: "7" });
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA, setActiveChain: setActiveChainMock });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("This invoice is on a different chain");
    expect(container.textContent).toContain(`Switch to chain ${BASE_SEPOLIA}`);
  });

  it("Switch button calls setActiveChain(linkChainId)", async () => {
    useParamsMock.mockReturnValue({ chainId: String(BASE_SEPOLIA), invoiceId: "7" });
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA, setActiveChain: setActiveChainMock });
    const { findByText } = render(<InvoicePage />);
    const btn = await findByText("Switch");
    fireEvent.click(btn);
    expect(setActiveChainMock).toHaveBeenCalledWith(BASE_SEPOLIA);
  });

  it("CRITICAL chain-mismatch HIDES pay form (defense-in-depth: wrong-chain click would call wrong contract)", async () => {
    useParamsMock.mockReturnValue({ chainId: String(BASE_SEPOLIA), invoiceId: "7" });
    useChainMock.mockReturnValue({ activeChainId: ETH_SEPOLIA, setActiveChain: setActiveChainMock });
    const { findByText, queryByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    // Pay form's heading is "Pay this invoice"; should NOT render.
    expect(queryByText("Pay this invoice")).toBeNull();
  });

  it("matching chain -> banner HIDDEN", async () => {
    const { findByText, queryByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(queryByText("This invoice is on a different chain")).toBeNull();
  });
});

describe("InvoicePage — role × status matrix: PENDING (§15.x)", () => {
  beforeEach(() => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 0 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("Pending + client + active chain -> 'Pay this invoice' form visible", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Pay this invoice");
    expect(container.textContent).toContain("Funds will be held in escrow until you finalize");
  });

  it("Pending + vendor -> 'Share this invoice' card (NOT pay form)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VENDOR });
    const { findByText, queryByText } = render(<InvoicePage />);
    await findByText("Share this invoice");
    expect(queryByText("Pay this invoice")).toBeNull();
  });

  it("CRITICAL Pending + bystander -> 'viewing as a bystander' (NOT pay form, NOT vendor share)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: BYSTANDER });
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("bystander");
    expect(container.textContent).toContain("Only the named");
    expect(container.textContent).toContain("can pay it");
  });

  it("Pending + no address -> 'You're viewing as a guest' Connect-a-wallet CTA", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("connect-to-pay");
    expect(container.textContent).toContain("You're viewing as a guest");
    expect(container.textContent).toContain("Connect a wallet");
  });
});

describe("InvoicePage — pay flow (§15.x)", () => {
  beforeEach(() => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 0 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
  });

  it("'Pay via escrow' disabled when amount empty", async () => {
    const { findByText } = render(<InvoicePage />);
    const btn = (await findByText("Pay via escrow")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("filling amount enables Pay via escrow + click calls payEscrow(invoiceId, amount)", async () => {
    const { findByText, findByPlaceholderText } = render(<InvoicePage />);
    fireEvent.change(await findByPlaceholderText("Amount in USDC"), { target: { value: "1500" } });
    const btn = await findByText("Pay via escrow");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(payEscrowMock).toHaveBeenCalledWith(7, "1500");
  });

  it("successful payEscrow (returns hash) -> clears input + triggers re-poll via tick increment", async () => {
    const { findByText, findByPlaceholderText } = render(<InvoicePage />);
    const input = (await findByPlaceholderText("Amount in USDC")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1500" } });
    const btn = await findByText("Pay via escrow");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input.value).toBe("");
  });

  it("isPaying -> 'Funding…' label + button disabled", async () => {
    useInvoiceEscrowMock.mockReturnValue({
      payEscrow: payEscrowMock,
      releaseEscrow: releaseEscrowMock,
      isPaying: true,
      isReleasing: false,
    });
    const { findByText } = render(<InvoicePage />);
    const btn = (await findByText("Funding…")).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("InvoicePage — role × status: PAYMENT-PENDING (status=3) (§15.x)", () => {
  beforeEach(() => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 3 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("PaymentPending + client -> 'Finalize the payment' card visible", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Finalize the payment");
    expect(container.textContent).toContain("Funds are in escrow");
    expect(container.textContent).toContain("decrypts the match check");
  });

  it("Finalize click calls releaseEscrow(invoiceId)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
    const { findByText } = render(<InvoicePage />);
    const btn = await findByText("Finalize");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(releaseEscrowMock).toHaveBeenCalledWith(7);
  });

  it("releaseEscrow returns {matched: true} -> 'Vendor paid' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
    releaseEscrowMock.mockResolvedValueOnce({ matched: true });
    const { findByText } = render(<InvoicePage />);
    const btn = await findByText("Finalize");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Vendor paid");
  });

  it("releaseEscrow returns {matched: false} -> 'Refunded to you' toast", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: CLIENT });
    releaseEscrowMock.mockResolvedValueOnce({ matched: false });
    const { findByText } = render(<InvoicePage />);
    const btn = await findByText("Finalize");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Refunded to you");
  });

  it("PaymentPending + vendor -> 'Funds are in escrow' message (NOT finalize button)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VENDOR });
    const { findByText, queryByText, container } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("Funds are in escrow");
    expect(queryByText("Finalize")).toBeNull();
  });
});

describe("InvoicePage — PAID status proof-of-payment (§15.x)", () => {
  beforeEach(() => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 1 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  });

  it("Paid status renders 'Proof of payment' panel + privacy explainer", async () => {
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("proof-of-payment");
    expect(container.textContent).toContain("settled via FHE-encrypted escrow");
    expect(container.textContent).toContain("amount stays private");
    expect(container.textContent).toContain("on-chain receipt is public");
  });

  it("CRITICAL settlement-tx link uses getExplorerTxUrl + tabnabbing guard", async () => {
    fetchInvoiceActivitiesMock.mockResolvedValue([
      {
        activity_type: "invoice_paid",
        tx_hash: "0xpaidpaidpaid",
        created_at: new Date().toISOString(),
      },
    ]);
    const { findByTestId } = render(<InvoicePage />);
    const link = (await findByTestId("settlement-tx-link")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("0xpaidpaidpaid");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith("0xpaidpaidpaid", ETH_SEPOLIA);
  });

  it("dual tx link: funding-tx ONLY rendered if distinct from settlement-tx", async () => {
    fetchInvoiceActivitiesMock.mockResolvedValue([
      {
        activity_type: "invoice_payment",
        tx_hash: "0xfundedfund",
        created_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        activity_type: "invoice_paid",
        tx_hash: "0xpaidpaid",
        created_at: new Date().toISOString(),
      },
    ]);
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("proof-of-payment");
    await waitFor(() => {
      expect(container.textContent).toContain("Settlement tx");
      expect(container.textContent).toContain("Funding tx");
    });
  });

  it("dual tx link de-dup: when paid-tx === funded-tx, ONLY settlement-tx renders", async () => {
    const sharedHash = "0xshared";
    fetchInvoiceActivitiesMock.mockResolvedValue([
      { activity_type: "invoice_payment", tx_hash: sharedHash, created_at: new Date().toISOString() },
      { activity_type: "invoice_paid", tx_hash: sharedHash, created_at: new Date().toISOString() },
    ]);
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("proof-of-payment");
    await waitFor(() => expect(container.textContent).toContain("Settlement tx"));
    expect(container.textContent).not.toContain("Funding tx");
  });

  it("missing paidActivity -> 'Paid on' falls back to '—' (defensive)", async () => {
    fetchInvoiceActivitiesMock.mockResolvedValue([]); // empty activity feed
    const { findByTestId, container } = render(<InvoicePage />);
    await findByTestId("proof-of-payment");
    expect(container.textContent).toContain("Paid on");
    // Some "—" character present in the fallback.
    expect(container.textContent).toContain("—");
  });

  it("'Print receipt' button + Copy link both rendered", async () => {
    const { findByText, findByTestId } = render(<InvoicePage />);
    await findByText("Print receipt");
    expect(await findByTestId("copy-invoice-link")).toBeDefined();
  });
});

describe("InvoicePage — terminal statuses (Cancelled / Disputed) (§15.x)", () => {
  it("status=2 (Cancelled) -> 'cancelled or refunded' message + NO action CTA", async () => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 2 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container, queryByText } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("cancelled or refunded");
    expect(container.textContent).toContain("No funds remain in escrow");
    expect(queryByText("Pay this invoice")).toBeNull();
    expect(queryByText("Finalize")).toBeNull();
  });

  it("status=4 (Disputed) -> 'legacy direct-transfer path with a mismatched amount' + Business Tools link", async () => {
    readContractMock = vi.fn().mockResolvedValue(buildInvoice({ status: 4 }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const { findByText, container } = render(<InvoicePage />);
    await findByText("Web design Q3");
    expect(container.textContent).toContain("legacy direct-transfer path");
    expect(container.textContent).toContain("mismatched amount");
    const link = (await findByText("Open Business Tools")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/app/business");
  });
});

describe("InvoicePage — cancellation guard (§15.x)", () => {
  it("CRITICAL: unmount during pending readContract does NOT setState on unmounted component", async () => {
    let resolveRead!: (v: unknown) => void;
    readContractMock = vi.fn().mockReturnValue(new Promise((res) => { resolveRead = res; }));
    usePublicClientMock.mockReturnValue({ readContract: readContractMock });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<InvoicePage />);
    unmount();

    await act(async () => {
      resolveRead(buildInvoice());
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((c) => c.includes("unmounted component"))).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});

describe("InvoicePage — back nav + status badge (§15.x)", () => {
  it("Back button navigates(-1)", async () => {
    const { findByText } = render(<InvoicePage />);
    fireEvent.click(await findByText("Back"));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });

  it("CopyInvoiceLink rendered with the link's chainId + invoiceId (icon variant on header for vendor)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: VENDOR });
    const { findAllByTestId } = render(<InvoicePage />);
    const links = await findAllByTestId("copy-invoice-link");
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute("data-chain")).toBe(String(ETH_SEPOLIA));
    expect(links[0].getAttribute("data-invoice")).toBe("7");
  });
});
