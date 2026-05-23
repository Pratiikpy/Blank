import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// Wave 5 Block 10 smoke test for BalanceProof screen.
//
// Pins:
//   - "Not deployed" banner shows when contracts.ProofOfBalance is 0x0,
//     not a broken form (which would silently submit to address(0)).
//   - Form renders when contract is deployed; create button is disabled
//     until both balance + threshold are filled. A regression that
//     forgets to gate would let a user submit an empty proof.
//   - createProof receives the numeric values from the form, not the
//     raw string values.

const useProofOfBalanceMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useProofOfBalance", () => ({
  useProofOfBalance: useProofOfBalanceMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));

import BalanceProof from "./BalanceProof";

const DEPLOYED = "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856";
const ZERO = "0x0000000000000000000000000000000000000000";

beforeEach(() => {
  useProofOfBalanceMock.mockReset();
  useChainMock.mockReset();
});

describe("BalanceProof screen", () => {
  it("renders 'Not deployed' banner when ProofOfBalance is address(0)", () => {
    useChainMock.mockReturnValue({
      contracts: { ProofOfBalance: ZERO },
    });
    useProofOfBalanceMock.mockReturnValue({
      step: "idle",
      error: null,
      createProof: vi.fn(),
      revealProof: vi.fn(),
      fetchProof: vi.fn(),
      reset: vi.fn(),
    });

    const { queryByTestId, container } = render(<BalanceProof />);
    expect(queryByTestId("balance-proof-screen")).toBeNull();
    expect(container.textContent).toContain("Not deployed");
  });

  it("renders the form when contract is deployed", () => {
    useChainMock.mockReturnValue({
      contracts: { ProofOfBalance: DEPLOYED },
    });
    useProofOfBalanceMock.mockReturnValue({
      step: "idle",
      error: null,
      createProof: vi.fn(),
      revealProof: vi.fn(),
      fetchProof: vi.fn(),
      reset: vi.fn(),
    });

    const { getByTestId } = render(<BalanceProof />);
    expect(getByTestId("balance-proof-screen")).toBeDefined();
    expect(getByTestId("balance-input")).toBeDefined();
    expect(getByTestId("threshold-input")).toBeDefined();
    expect(getByTestId("create-proof-button")).toBeDefined();
  });

  it("disables create button until both inputs are filled", () => {
    useChainMock.mockReturnValue({
      contracts: { ProofOfBalance: DEPLOYED },
    });
    useProofOfBalanceMock.mockReturnValue({
      step: "idle",
      error: null,
      createProof: vi.fn(),
      revealProof: vi.fn(),
      fetchProof: vi.fn(),
      reset: vi.fn(),
    });

    const { getByTestId } = render(<BalanceProof />);
    const button = getByTestId("create-proof-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    act(() => {
      fireEvent.change(getByTestId("balance-input"), { target: { value: "5000" } });
    });
    expect(button.disabled).toBe(true);

    act(() => {
      fireEvent.change(getByTestId("threshold-input"), { target: { value: "1000" } });
    });
    expect(button.disabled).toBe(false);
  });

  it("calls createProof with parsed numeric values", () => {
    const createProof = vi.fn().mockResolvedValue(BigInt(42));
    useChainMock.mockReturnValue({
      contracts: { ProofOfBalance: DEPLOYED },
    });
    useProofOfBalanceMock.mockReturnValue({
      step: "idle",
      error: null,
      createProof,
      revealProof: vi.fn(),
      fetchProof: vi.fn(),
      reset: vi.fn(),
    });

    const { getByTestId } = render(<BalanceProof />);
    act(() => {
      fireEvent.change(getByTestId("balance-input"), { target: { value: "5000" } });
      fireEvent.change(getByTestId("threshold-input"), { target: { value: "1000" } });
    });
    act(() => {
      fireEvent.click(getByTestId("create-proof-button"));
    });
    expect(createProof).toHaveBeenCalledWith(5000, 1000);
  });
});
