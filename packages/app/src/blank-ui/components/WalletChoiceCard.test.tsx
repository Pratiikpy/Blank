import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// §15.x test for WalletChoiceCard. Pins the 3-option layout
// (passkey / connectors / browse) AND the audit-relevant
// `wagmi.reset()` BEFORE handler invocation that prevents the
// orphan-passkey race when the user pivots from a stalled MetaMask
// connect to passkey creation. Without that reset, BlankApp's
// `isConnected || hasPasskeyAccount` gate orphans whichever wallet
// finished second.

const useConnectMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useConnect: useConnectMock,
}));

import { WalletChoiceCard } from "./WalletChoiceCard";

const STUB_CONNECTORS = [
  { uid: "metamask", name: "MetaMask" },
  { uid: "walletconnect", name: "WalletConnect" },
];

const resetMock = vi.fn();
const connectMock = vi.fn();

beforeEach(() => {
  useConnectMock.mockReset();
  resetMock.mockReset();
  connectMock.mockReset();
  useConnectMock.mockReturnValue({
    connectors: STUB_CONNECTORS,
    connect: connectMock,
    reset: resetMock,
    isPending: false,
    error: null,
  });
});

describe("WalletChoiceCard — 3-option layout (§15.x)", () => {
  it("renders the passkey CTA, the existing-wallet card, and the browse link by default", () => {
    const { container, getByTestId } = render(
      <WalletChoiceCard onSelectPasskey={vi.fn()} onSelectBrowse={vi.fn()} />,
    );
    expect(getByTestId("onboarding-passkey-cta")).toBeDefined();
    expect(getByTestId("wallet-choice-existing")).toBeDefined();
    expect(getByTestId("wallet-choice-browse")).toBeDefined();
    expect(container.textContent).toContain("Create a passkey wallet");
    expect(container.textContent).toContain("Connect existing wallet");
  });

  it("hides the browse link when hideBrowse=true (PayPage variant)", () => {
    const { queryByTestId } = render(
      <WalletChoiceCard onSelectPasskey={vi.fn()} hideBrowse />,
    );
    expect(queryByTestId("wallet-choice-browse")).toBeNull();
  });

  it("renders one button per wagmi connector", () => {
    const { getByText } = render(
      <WalletChoiceCard onSelectPasskey={vi.fn()} onSelectBrowse={vi.fn()} />,
    );
    expect(getByText(/Connect MetaMask/)).toBeDefined();
    expect(getByText(/Connect WalletConnect/)).toBeDefined();
  });

  it("shows fallback copy when zero connectors are detected", () => {
    useConnectMock.mockReturnValue({
      connectors: [],
      connect: connectMock,
      reset: resetMock,
      isPending: false,
      error: null,
    });
    const { container } = render(
      <WalletChoiceCard onSelectPasskey={vi.fn()} onSelectBrowse={vi.fn()} />,
    );
    expect(container.textContent).toContain("No wallets detected");
  });
});

describe("WalletChoiceCard — handler ordering (audit-relevant) (§15.x)", () => {
  it("CRITICAL: passkey click calls reset() BEFORE onSelectPasskey (orphan-passkey race fix)", () => {
    const order: string[] = [];
    resetMock.mockImplementation(() => order.push("reset"));
    const onSelectPasskey = vi.fn(() => order.push("onSelectPasskey"));

    const { getByTestId } = render(
      <WalletChoiceCard onSelectPasskey={onSelectPasskey} />,
    );
    fireEvent.click(getByTestId("onboarding-passkey-cta"));

    expect(order).toEqual(["reset", "onSelectPasskey"]);
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(onSelectPasskey).toHaveBeenCalledTimes(1);
  });

  it("browse click ALSO calls reset() before onSelectBrowse", () => {
    const order: string[] = [];
    resetMock.mockImplementation(() => order.push("reset"));
    const onSelectBrowse = vi.fn(() => order.push("onSelectBrowse"));

    const { getByTestId } = render(
      <WalletChoiceCard onSelectPasskey={vi.fn()} onSelectBrowse={onSelectBrowse} />,
    );
    fireEvent.click(getByTestId("wallet-choice-browse"));

    expect(order).toEqual(["reset", "onSelectBrowse"]);
  });

  it("browse without onSelectBrowse prop still resets wagmi (no-op handler)", () => {
    const { getByTestId } = render(<WalletChoiceCard onSelectPasskey={vi.fn()} />);
    expect(() => fireEvent.click(getByTestId("wallet-choice-browse"))).not.toThrow();
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it("clicking a connector calls connect({ connector }) (NOT reset, NOT onSelectPasskey)", () => {
    const onSelectPasskey = vi.fn();
    const { getByText } = render(
      <WalletChoiceCard onSelectPasskey={onSelectPasskey} />,
    );
    fireEvent.click(getByText(/Connect MetaMask/));

    expect(connectMock).toHaveBeenCalledWith({ connector: STUB_CONNECTORS[0] });
    expect(resetMock).not.toHaveBeenCalled();
    expect(onSelectPasskey).not.toHaveBeenCalled();
  });
});

describe("WalletChoiceCard — isPending state (§15.x)", () => {
  beforeEach(() => {
    useConnectMock.mockReturnValue({
      connectors: STUB_CONNECTORS,
      connect: connectMock,
      reset: resetMock,
      isPending: true,
      error: null,
    });
  });

  it("disables the passkey CTA while a wagmi connector handshake is mid-flight", () => {
    const { getByTestId } = render(<WalletChoiceCard onSelectPasskey={vi.fn()} />);
    const cta = getByTestId("onboarding-passkey-cta") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it("disables every connector button while pending + sets aria-busy=true", () => {
    const { getByText } = render(<WalletChoiceCard onSelectPasskey={vi.fn()} />);
    const mm = getByText(/Connect MetaMask/).closest("button") as HTMLButtonElement;
    expect(mm.disabled).toBe(true);
    expect(mm.getAttribute("aria-busy")).toBe("true");
  });

  it("connector aria-label includes the ', connecting' suffix while pending", () => {
    const { getByLabelText } = render(<WalletChoiceCard onSelectPasskey={vi.fn()} />);
    expect(getByLabelText("Connect MetaMask, connecting")).toBeDefined();
  });
});

describe("WalletChoiceCard — connect error surface (§15.x)", () => {
  it("shows connectError.message in rose copy when wagmi reports a failure", () => {
    useConnectMock.mockReturnValue({
      connectors: STUB_CONNECTORS,
      connect: connectMock,
      reset: resetMock,
      isPending: false,
      error: new Error("user rejected the request"),
    });
    const { container } = render(<WalletChoiceCard onSelectPasskey={vi.fn()} />);
    expect(container.textContent).toContain("user rejected the request");
  });
});
