import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ProofOfBalance is retired on-chain (createProof / revealProof revert).
// Pins:
//   - No create form or reveal button: they could only revert.
//   - The screen links to /app/proofs?kind=balance, the live balance proof.
//   - Old records stay readable, labelled as self-reported.

const useProofOfBalanceMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useProofOfBalance", () => ({ useProofOfBalance: useProofOfBalanceMock }));

import BalanceProof from "./BalanceProof";

const PROVER = "0xff0Fa776116a17b6fbD62E48CA14F48b31E31856";

function renderScreen() {
  return render(
    <MemoryRouter>
      <BalanceProof />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useProofOfBalanceMock.mockReset();
});

describe("BalanceProof screen (retired contract)", () => {
  it("has no create or reveal controls and links to the live balance proof", () => {
    useProofOfBalanceMock.mockReturnValue({ deployed: true, fetchProof: vi.fn() });
    const { queryByTestId, getByTestId } = renderScreen();
    expect(queryByTestId("create-proof-button")).toBeNull();
    expect(queryByTestId("reveal-proof-button")).toBeNull();
    expect(queryByTestId("balance-input")).toBeNull();
    expect(getByTestId("go-to-proofs").getAttribute("href")).toBe("/app/proofs?kind=balance");
  });

  it("hides the legacy lookup when the contract is not on this chain", () => {
    useProofOfBalanceMock.mockReturnValue({ deployed: false, fetchProof: vi.fn() });
    const { queryByTestId, getByTestId } = renderScreen();
    expect(getByTestId("go-to-proofs")).toBeDefined();
    expect(queryByTestId("lookup-input")).toBeNull();
  });

  it("looks up an old proof and labels it self-reported", async () => {
    const fetchProof = vi.fn().mockResolvedValue({
      id: 3n,
      prover: PROVER,
      thresholdMicroUSD: 1_000_000_000n,
      createdAt: 1_700_000_000n,
      revealed: true,
      revealedValue: true,
    });
    useProofOfBalanceMock.mockReturnValue({ deployed: true, fetchProof });
    const { getByTestId, findByTestId } = renderScreen();
    act(() => {
      fireEvent.change(getByTestId("lookup-input"), { target: { value: "3" } });
    });
    act(() => {
      fireEvent.click(getByTestId("lookup-button"));
    });
    const result = await findByTestId("lookup-result");
    expect(fetchProof).toHaveBeenCalledWith(3n);
    expect(result.textContent).toContain("self-reported");
    expect(result.textContent).toContain("1,000");
  });

  it("shows a miss for an unknown or non-numeric id without calling the chain", async () => {
    const fetchProof = vi.fn().mockResolvedValue(null);
    useProofOfBalanceMock.mockReturnValue({ deployed: true, fetchProof });
    const { getByTestId, findByTestId } = renderScreen();
    act(() => {
      fireEvent.change(getByTestId("lookup-input"), { target: { value: "abc" } });
    });
    act(() => {
      fireEvent.click(getByTestId("lookup-button"));
    });
    await findByTestId("lookup-miss");
    expect(fetchProof).not.toHaveBeenCalled();

    act(() => {
      fireEvent.change(getByTestId("lookup-input"), { target: { value: "99" } });
    });
    act(() => {
      fireEvent.click(getByTestId("lookup-button"));
    });
    await waitFor(() => expect(fetchProof).toHaveBeenCalledWith(99n));
    expect(getByTestId("lookup-miss")).toBeDefined();
  });
});
