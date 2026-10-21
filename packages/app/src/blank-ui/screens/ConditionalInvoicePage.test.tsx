import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// Conditional invoice public page, funding-gate states. A new escrow starts
// PendingFunding (status 4) and only becomes Active once the payer's one-time
// funding check is published; a short payer ends Void (status 5).
//
// CRITICAL pins:
//   - Pending: no Approve / Release controls, an explanation, a Finish
//     funding action for any connected viewer, Cancel for the payer only.
//   - Whoever opens a pending escrow settles it automatically, once per visit.
//   - Void: says nothing was locked and offers no share link.
//   - Active escrows behave exactly as before.

const useParamsMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEncryptedEscrowMock = vi.hoisted(() => vi.fn());
const readConditionalInvoiceMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useParams: useParamsMock, useNavigate: useNavigateMock }));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useEncryptedEscrow", () => ({
  useEncryptedEscrow: useEncryptedEscrowMock,
  readConditionalInvoice: readConditionalInvoiceMock,
  ESCROW_STATUS: { Active: 0, Disputed: 1, Released: 2, Refunded: 3, PendingFunding: 4, Void: 5 },
}));
vi.mock("@/lib/abis", () => ({ EncryptedEscrowAbi: [] }));
vi.mock("react-hot-toast", () => ({ default: { error: toastErrorMock, success: vi.fn() } }));

import ConditionalInvoicePage from "./ConditionalInvoicePage";

const ARB = 421614;
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = "0x0000000000000000000000000000000000000000";

const STATUS = { Active: 0, Released: 2, PendingFunding: 4, Void: 5 };

let escrowStatus: number;
let finishFundingMock: ReturnType<typeof vi.fn>;
let cancelPendingMock: ReturnType<typeof vi.fn>;
let approveInvoiceMock: ReturnType<typeof vi.fn>;
let triggerReleaseMock: ReturnType<typeof vi.fn>;
let readContractMock: ReturnType<typeof vi.fn>;

function setViewer(address: string | undefined) {
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: address });
}

beforeEach(() => {
  useParamsMock.mockReset();
  useNavigateMock.mockReset();
  usePublicClientMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useEncryptedEscrowMock.mockReset();
  readConditionalInvoiceMock.mockReset();
  toastErrorMock.mockReset();

  escrowStatus = STATUS.PendingFunding;
  finishFundingMock = vi.fn().mockResolvedValue("funded");
  cancelPendingMock = vi.fn().mockResolvedValue(true);
  approveInvoiceMock = vi.fn().mockResolvedValue(true);
  triggerReleaseMock = vi.fn().mockResolvedValue(true);

  useParamsMock.mockReturnValue({ chainId: String(ARB), escrowId: "5" });
  useNavigateMock.mockReturnValue(vi.fn());
  setViewer(PAYER);
  useChainMock.mockReturnValue({ activeChainId: ARB, setActiveChain: vi.fn() });
  useEncryptedEscrowMock.mockImplementation(() => ({
    approveInvoice: approveInvoiceMock,
    triggerRelease: triggerReleaseMock,
    finishFunding: finishFundingMock,
    cancelPendingEscrow: cancelPendingMock,
    state: { isProcessing: false, error: null, step: "idle" },
  }));
  readContractMock = vi.fn().mockImplementation(async () => [
    PAYER, RECIPIENT, ZERO, "0xvault", 1_900_000_000n, false, false, escrowStatus, "Website redesign", 1n,
  ]);
  usePublicClientMock.mockReturnValue({ readContract: readContractMock });
  readConditionalInvoiceMock.mockResolvedValue({
    buyer: PAYER,
    autoReleaseDeadline: 1_900_000_000n,
    isApproved: false,
    deadlinePassed: false,
    set: true,
    resolver: "0xc68C56a8Ad23E515eD56F2B98FC93341D98cE78b",
    legacy: false,
  });
});

describe("ConditionalInvoicePage: PendingFunding", () => {
  it("shows a 'Funding' badge and the explanation, with no approve or release controls", async () => {
    const { findByTestId, container, queryByText } = render(<ConditionalInvoicePage />);
    await findByTestId("conditional-invoice-pending");
    expect(container.textContent).toContain("Funding");
    expect(container.textContent).toContain("Funding is being confirmed");
    expect(queryByText("Approve release")).toBeNull();
    expect(queryByText("Release funds to recipient")).toBeNull();
  });

  it("a connected viewer settles it automatically, once", async () => {
    const { findByTestId, rerender } = render(<ConditionalInvoicePage />);
    await findByTestId("conditional-invoice-pending");
    await waitFor(() => expect(finishFundingMock).toHaveBeenCalledTimes(1));
    expect(finishFundingMock).toHaveBeenCalledWith(5);
    rerender(<ConditionalInvoicePage />);
    expect(finishFundingMock).toHaveBeenCalledTimes(1);
  });

  it("no wallet: no automatic attempt and no Finish button", async () => {
    setViewer(undefined);
    const { findByTestId, queryByText } = render(<ConditionalInvoicePage />);
    await findByTestId("conditional-invoice-pending");
    expect(finishFundingMock).not.toHaveBeenCalled();
    expect(queryByText("Finish funding")).toBeNull();
  });

  it("'Finish funding' retries after the automatic attempt did not complete", async () => {
    finishFundingMock.mockResolvedValue(null);
    const { findByText } = render(<ConditionalInvoicePage />);
    const btn = await findByText("Finish funding");
    await waitFor(() => expect(finishFundingMock).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(btn); });
    expect(finishFundingMock).toHaveBeenCalledTimes(2);
  });

  it("a verdict re-reads the escrow", async () => {
    const { findByTestId } = render(<ConditionalInvoicePage />);
    await findByTestId("conditional-invoice-pending");
    await waitFor(() => expect(finishFundingMock).toHaveBeenCalled());
    // One read to load the page, a second one once the funding verdict came back.
    await waitFor(() => expect(readContractMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("only the payer can cancel a pending invoice", async () => {
    const { findByText, unmount } = render(<ConditionalInvoicePage />);
    const cancel = await findByText("Cancel this invoice");
    await act(async () => { fireEvent.click(cancel); });
    expect(cancelPendingMock).toHaveBeenCalledWith(5);
    unmount();

    setViewer(RECIPIENT);
    const second = render(<ConditionalInvoicePage />);
    await second.findByTestId("conditional-invoice-pending");
    expect(second.queryByText("Cancel this invoice")).toBeNull();
  });

  it("on another chain the viewer is asked to switch instead of sending a tx", async () => {
    useChainMock.mockReturnValue({ activeChainId: 11155111, setActiveChain: vi.fn() });
    const { findByText, queryByText } = render(<ConditionalInvoicePage />);
    await findByText("Switch to Arbitrum Sepolia");
    expect(queryByText("Finish funding")).toBeNull();
    expect(finishFundingMock).not.toHaveBeenCalled();
  });
});

describe("ConditionalInvoicePage: Void", () => {
  beforeEach(() => {
    escrowStatus = STATUS.Void;
  });

  it("says it was never funded and nothing was locked", async () => {
    const { findByTestId, container } = render(<ConditionalInvoicePage />);
    const box = await findByTestId("conditional-invoice-unfunded");
    expect(box.textContent).toContain("never funded");
    expect(box.textContent).toContain("nothing was locked");
    expect(container.textContent).toContain("Not funded");
  });

  it("offers no actions and no share link", async () => {
    const { findByTestId, queryByText } = render(<ConditionalInvoicePage />);
    await findByTestId("conditional-invoice-unfunded");
    expect(queryByText("Copy share link")).toBeNull();
    expect(queryByText("Approve release")).toBeNull();
    expect(queryByText("Finish funding")).toBeNull();
    expect(finishFundingMock).not.toHaveBeenCalled();
  });
});

describe("ConditionalInvoicePage: Active is unchanged", () => {
  beforeEach(() => {
    escrowStatus = STATUS.Active;
  });

  it("the payer can approve; no funding UI; no automatic funding attempt", async () => {
    const { findByText, queryByTestId } = render(<ConditionalInvoicePage />);
    const approve = await findByText("Approve release");
    await act(async () => { fireEvent.click(approve); });
    expect(approveInvoiceMock).toHaveBeenCalledWith(5, expect.objectContaining({ legacy: false }));
    expect(queryByTestId("conditional-invoice-pending")).toBeNull();
    expect(queryByTestId("conditional-invoice-unfunded")).toBeNull();
    expect(finishFundingMock).not.toHaveBeenCalled();
  });

  it("a stranger sees the waiting note and the share link", async () => {
    setViewer(STRANGER);
    const { findByText } = render(<ConditionalInvoicePage />);
    await findByText(/Waiting for the payer to approve/);
    await findByText("Copy share link");
  });
});
