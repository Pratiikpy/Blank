import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// The taker must see what was actually escrowed before paying fiat. The
// attest widget stays hidden until the escrow is decrypted, non-zero and
// confirmed. Stale disputes get the timeout exit.

const useParamsMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useP2POfframpMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: useParamsMock,
  Link: (p: { to: string; children: React.ReactNode }) => <a href={p.to}>{p.children}</a>,
}));
vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: () => ({ activeChainId: 11155111 }) }));
vi.mock("@/hooks/useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("@/hooks/useP2POfframp", () => ({ useP2POfframp: useP2POfframpMock }));
vi.mock("@/lib/abis", () => ({ P2POfframpAbi: [] }));
vi.mock("@/blank-ui/components/offramp/ReclaimWidget", () => ({
  ReclaimWidget: (p: { fillId: bigint; providerId: number }) => (
    <div data-testid="reclaim-widget-sentinel">widget fill {p.fillId.toString()} rail {p.providerId}</div>
  ),
}));
vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import OfframpFillFlow from "./OfframpFillFlow";

const OFFRAMP = "0x5981C437032Da38844AE9a3aa382F993b1B8444a";
const TAKER = "0x00000000000000000000000000000000000000bb";
const MAKER = "0x00000000000000000000000000000000000000aa";

let decryptEscrowedAmountMock: ReturnType<typeof vi.fn>;
let resolveStaleDisputeMock: ReturnType<typeof vi.fn>;
let confirmPendingFillMock: ReturnType<typeof vi.fn>;
let expireFillMock: ReturnType<typeof vi.fn>;

function chain(fillState: number, disputedAt = 0, lockedAt = 1000) {
  usePublicClientMock.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getFill": return [3n, TAKER, 25_000_000n, lockedAt, 0, "0x" + "00".repeat(32), fillState];
        case "getOffer": return [MAKER, "0xvault", 25_000_000n, 1_000_000n, 4, "0x" + "ab".repeat(32), 0, 2];
        case "CHALLENGE_WINDOW_SECONDS": return 300;
        case "fillDisputedAt": return disputedAt;
        case "DISPUTE_TIMEOUT_SECONDS": return 7 * 24 * 3600;
        default: return 0;
      }
    }),
  });
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ fillId: "7" });
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: TAKER });
  decryptEscrowedAmountMock = vi.fn();
  resolveStaleDisputeMock = vi.fn().mockResolvedValue({ txHash: "0x1" });
  confirmPendingFillMock = vi.fn().mockResolvedValue("locked");
  expireFillMock = vi.fn().mockResolvedValue({ txHash: "0x2" });
  useP2POfframpMock.mockReturnValue({
    deploy: { status: "live", address: OFFRAMP, reason: null },
    state: { isProcessing: false },
    decryptEscrowedAmount: decryptEscrowedAmountMock,
    resolveStaleDispute: resolveStaleDisputeMock,
    submitProof: vi.fn(),
    releaseFill: vi.fn(),
    disputeFill: vi.fn(),
    expireFill: expireFillMock,
    confirmPendingFill: confirmPendingFillMock,
    fheReady: true,
  });
});

describe("OfframpFillFlow — escrow check before paying fiat", () => {
  it("attest widget is hidden until the escrow is decrypted and confirmed", async () => {
    chain(0);
    decryptEscrowedAmountMock.mockResolvedValue(25_000_000n);
    const { findByTestId, queryByTestId, getByTestId } = render(<OfframpFillFlow />);
    const btn = await findByTestId("offramp-escrow-decrypt");
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(getByTestId("offramp-escrow-amount").textContent).toContain("25 USDC"));
    expect(decryptEscrowedAmountMock).toHaveBeenCalledWith(7n);
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
    fireEvent.click(getByTestId("offramp-escrow-confirm"));
    expect(getByTestId("reclaim-widget-sentinel").textContent).toContain("fill 7 rail 4");
  });

  it("escrow decrypts to 0 -> 'do not send fiat' warning and no attest widget", async () => {
    chain(0);
    decryptEscrowedAmountMock.mockResolvedValue(0n);
    const { findByTestId, queryByTestId } = render(<OfframpFillFlow />);
    const btn = await findByTestId("offramp-escrow-decrypt");
    await act(async () => { fireEvent.click(btn); });
    await findByTestId("offramp-escrow-empty");
    expect(queryByTestId("offramp-escrow-confirm")).toBeNull();
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
  });

  it("decrypt error is shown and the widget stays hidden", async () => {
    chain(0);
    decryptEscrowedAmountMock.mockRejectedValue(new Error("Could not decrypt the escrowed amount."));
    const { findByTestId, findByText, queryByTestId } = render(<OfframpFillFlow />);
    const btn = await findByTestId("offramp-escrow-decrypt");
    await act(async () => { fireEvent.click(btn); });
    await findByText(/Could not decrypt/);
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
  });
});

describe("OfframpFillFlow — stale dispute", () => {
  it("arbiter window passed -> anyone can release to the taker", async () => {
    chain(3, Math.floor(Date.now() / 1000) - 8 * 24 * 3600);
    const { findByTestId } = render(<OfframpFillFlow />);
    const btn = await findByTestId("offramp-fill-resolve-stale");
    await act(async () => { fireEvent.click(btn); });
    expect(resolveStaleDisputeMock).toHaveBeenCalledWith(7n);
  });

  it("arbiter window open -> no release button, countdown copy", async () => {
    chain(3, Math.floor(Date.now() / 1000) - 3600);
    const { findByText, queryByTestId } = render(<OfframpFillFlow />);
    await findByText(/anyone can release the escrow to the taker/);
    expect(queryByTestId("offramp-fill-resolve-stale")).toBeNull();
  });

  it("legacy dispute (no timestamp) -> arbiter only", async () => {
    chain(3, 0);
    const { findByText, queryByTestId } = render(<OfframpFillFlow />);
    await findByText(/only the arbiter can resolve it/);
    expect(queryByTestId("offramp-fill-resolve-stale")).toBeNull();
  });
});

describe("OfframpFillFlow — funding gate states", () => {
  it("Pending: fiat leg stays closed, the escrow check finishes on its own once the FHE session is up", async () => {
    chain(6);
    const { findByTestId, queryByTestId, getByTestId } = render(<OfframpFillFlow />);
    await findByTestId("offramp-fill-pending");
    expect(getByTestId("offramp-fill-state").textContent).toContain("Do not send fiat yet");
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
    expect(queryByTestId("offramp-escrow-decrypt")).toBeNull();
    await waitFor(() => expect(confirmPendingFillMock).toHaveBeenCalledWith(7n));
    expect(confirmPendingFillMock).toHaveBeenCalledTimes(1);
  });

  it("Pending: waits for the FHE session instead of failing, and the button says so", async () => {
    chain(6);
    useP2POfframpMock.mockReturnValue({ ...useP2POfframpMock(), fheReady: false });
    const { findByTestId } = render(<OfframpFillFlow />);
    const btn = (await findByTestId("offramp-fill-finish")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Connecting");
    expect(confirmPendingFillMock).not.toHaveBeenCalled();
  });

  it("Pending: a failed check shows the real reason and the Finish button retries", async () => {
    chain(6);
    confirmPendingFillMock.mockRejectedValueOnce(new Error("The funding check is not ready yet. Try again in a minute."));
    const { findByTestId } = render(<OfframpFillFlow />);
    const err = await findByTestId("offramp-fill-finish-error");
    expect(err.textContent).toContain("not ready yet");
    await act(async () => { fireEvent.click(await findByTestId("offramp-fill-finish")); });
    await waitFor(() => expect(confirmPendingFillMock).toHaveBeenCalledTimes(2));
  });

  it("Pending: the maker can reclaim an unconfirmed escrow after the proof window", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: MAKER });
    chain(6, 0, Math.floor(Date.now() / 1000) - 25 * 3600);
    const { findByTestId } = render(<OfframpFillFlow />);
    const btn = (await findByTestId("offramp-fill-expire-pending")) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    expect(expireFillMock).toHaveBeenCalledWith(7n);
  });

  it("Pending: the reclaim button is locked until the proof window passes", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: MAKER });
    chain(6, 0, Math.floor(Date.now() / 1000) - 3600);
    const { findByTestId } = render(<OfframpFillFlow />);
    const btn = (await findByTestId("offramp-fill-expire-pending")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Voided: says nothing is due and offers no payment step", async () => {
    chain(7);
    const { findByTestId, queryByTestId, getByTestId } = render(<OfframpFillFlow />);
    await findByTestId("offramp-fill-voided");
    expect(getByTestId("offramp-fill-state").textContent).toContain("balance was too low");
    expect(queryByTestId("reclaim-widget-sentinel")).toBeNull();
    expect(queryByTestId("offramp-fill-pending")).toBeNull();
    expect(confirmPendingFillMock).not.toHaveBeenCalled();
  });

  it("Locked (confirmed or pre-gate) still shows the escrow check and never auto-runs the gate", async () => {
    chain(0);
    const { findByTestId } = render(<OfframpFillFlow />);
    await findByTestId("offramp-escrow-decrypt");
    expect(confirmPendingFillMock).not.toHaveBeenCalled();
  });
});
