import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for Privacy screen. Pins:
//   - 3-state permit status (active / expired / not-created)
//   - timeRemaining/formatDate display helpers
//   - share-form validation + revoke flow
//   - CRITICAL "tracked locally on this device only" disclosure
//     for the Local Access Log (CoFHE SDK doesn't support on-chain
//     permit sharing yet, so the honest framing must stay visible)

const usePrivacyMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/usePrivacy", () => ({
  usePrivacy: usePrivacyMock,
}));

vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: vi.fn() },
}));

import Privacy from "./Privacy";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const createPermitMock = vi.fn();
const reconnectWalletMock = vi.fn();
const sharePermitMock = vi.fn();
const revokePermitMock = vi.fn();

const FUTURE_HOURS_2 = Date.now() + 2 * 3600_000;
const FUTURE_HOURS_30M = Date.now() + 30 * 60_000;
const PAST = Date.now() - 1000;

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

type SharedPermit = {
  address: string;
  accessLevel: "full" | "balance-proof";
  expiresAt: number;
  createdAt: number;
};

type PrivacyState = {
  hasPermit: boolean;
  permitExpiresAt: number | null;
  isExpiringSoon: boolean;
  isExpired: boolean;
  isCreating: boolean;
  sharedPermits: SharedPermit[];
  createPermit: typeof createPermitMock;
  reconnectWallet: typeof reconnectWalletMock;
  sharePermit: typeof sharePermitMock;
  revokePermit: typeof revokePermitMock;
};

function setPrivacy(overrides: Partial<PrivacyState> = {}) {
  usePrivacyMock.mockReturnValue({ ...basePrivacy(), ...overrides });
}

function basePrivacy(): PrivacyState {
  return {
    hasPermit: false,
    permitExpiresAt: null,
    isExpiringSoon: false,
    isExpired: false,
    isCreating: false,
    sharedPermits: [],
    createPermit: createPermitMock,
    reconnectWallet: reconnectWalletMock,
    sharePermit: sharePermitMock,
    revokePermit: revokePermitMock,
  };
}

beforeEach(() => {
  usePrivacyMock.mockReset();
  toastErrorMock.mockReset();
  createPermitMock.mockReset();
  reconnectWalletMock.mockReset();
  sharePermitMock.mockReset();
  revokePermitMock.mockReset();
  sharePermitMock.mockResolvedValue(undefined);
  setPrivacy();
});

describe("Privacy — page chrome (§15.x)", () => {
  it("renders 'Privacy Settings' heading + subtitle", () => {
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Privacy Settings");
    expect(container.textContent).toContain("Manage your FHE permits");
  });

  it("renders the 'How FHE Permits Work' 4-step explainer", () => {
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("How FHE Permits Work");
    expect(container.textContent).toContain("Your wallet signs a message to derive a sealing key");
    expect(container.textContent).toContain("Permits expire after 7 days for security");
  });
});

describe("Privacy — permit status card (§15.x)", () => {
  it("not-created state: status 'Not Created' + 'No active permit' subtitle + Create button visible", () => {
    setPrivacy({ hasPermit: false, isExpired: false });
    const { container, getByLabelText } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Not Created");
    expect(container.textContent).toContain("No active permit");
    expect(getByLabelText("Create or renew FHE permit")).toBeDefined();
  });

  it("active state: status 'Active' + 'your data is accessible' subtitle + Create button HIDDEN", () => {
    setPrivacy({ hasPermit: true, isExpired: false, permitExpiresAt: FUTURE_HOURS_2 });
    const { container, queryByLabelText } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("Your data is accessible");
    expect(queryByLabelText("Create or renew FHE permit")).toBeNull();
  });

  it("expired state: status 'Expired' + Create button RE-APPEARS", () => {
    setPrivacy({ hasPermit: true, isExpired: true, permitExpiresAt: PAST });
    const { container, getByLabelText } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Expired");
    expect(getByLabelText("Create or renew FHE permit")).toBeDefined();
  });

  it("expiring-soon warning banner shows when isExpiringSoon=true + not yet expired", () => {
    setPrivacy({
      hasPermit: true,
      isExpired: false,
      isExpiringSoon: true,
      permitExpiresAt: FUTURE_HOURS_30M,
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Your permit expires in less than 1 hour");
  });

  it("expiring-soon banner HIDDEN when already expired (no longer 'soon')", () => {
    setPrivacy({
      hasPermit: true,
      isExpired: true,
      isExpiringSoon: false,
      permitExpiresAt: PAST,
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).not.toContain("expires in less than 1 hour");
  });

  it("Create button shows 'Creating...' label + disabled while isCreating", () => {
    setPrivacy({ hasPermit: false, isExpired: false, isCreating: true });
    const { getByLabelText } = withRouter(<Privacy />);
    const btn = getByLabelText("Create or renew FHE permit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Creating");
  });

  it("clicking Create button invokes createPermit", () => {
    setPrivacy({ hasPermit: false, isExpired: false });
    const { getByLabelText } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Create or renew FHE permit"));
    expect(createPermitMock).toHaveBeenCalled();
  });

  it("reconnect-wallet button is ALWAYS visible + invokes reconnectWallet", () => {
    setPrivacy({ hasPermit: true, isExpired: false, permitExpiresAt: FUTURE_HOURS_2 });
    const { getByLabelText } = withRouter(<Privacy />);
    const btn = getByLabelText("Reconnect wallet to renew permit");
    fireEvent.click(btn);
    expect(reconnectWalletMock).toHaveBeenCalled();
  });
});

describe("Privacy — Local Access Log (§15.x)", () => {
  it("CRITICAL: explicit 'tracked locally on this device only' disclosure visible", () => {
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("tracked locally on this device only");
    expect(container.textContent).toContain("not yet available");
  });

  it("uses 'Local Access Log' framing (not 'Shared Permits' or 'Permit Sharing')", () => {
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Local Access Log");
  });

  it("empty state shows 'No access log entries' when sharedPermits is empty", () => {
    setPrivacy({ sharedPermits: [] });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("No access log entries");
  });

  it("renders a row per sharedPermit with truncated address + access level + time remaining", () => {
    setPrivacy({
      sharedPermits: [
        { address: ALICE, accessLevel: "balance-proof", expiresAt: FUTURE_HOURS_2 + 86_400_000, createdAt: Date.now() },
      ],
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Balance proof");
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
  });

  it("renders 'Full access' label when accessLevel === 'full'", () => {
    setPrivacy({
      sharedPermits: [
        { address: ALICE, accessLevel: "full", expiresAt: FUTURE_HOURS_2 + 86_400_000, createdAt: Date.now() },
      ],
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Full access");
  });

  it("revoke button (Trash icon) calls revokePermit(address)", () => {
    setPrivacy({
      sharedPermits: [
        { address: ALICE, accessLevel: "full", expiresAt: FUTURE_HOURS_2 + 86_400_000, createdAt: Date.now() },
      ],
    });
    const { getByLabelText } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText(`Revoke access for ${ALICE}`));
    expect(revokePermitMock).toHaveBeenCalledWith(ALICE);
  });
});

describe("Privacy — Share form (§15.x)", () => {
  it("share form is hidden by default", () => {
    const { container } = withRouter(<Privacy />);
    expect(container.querySelector("input[placeholder='0x... address to share with']")).toBeNull();
  });

  it("clicking 'Share' button toggles the form open", () => {
    const { getByLabelText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    expect(container.querySelector("input[placeholder='0x... address to share with']")).not.toBeNull();
  });

  it("empty address validation → 'Enter a wallet address' toast", async () => {
    const { getByLabelText, getByText } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    await act(async () => {
      fireEvent.click(getByText("Log Access"));
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Enter a wallet address");
    expect(sharePermitMock).not.toHaveBeenCalled();
  });

  it("invalid hex address → 'Invalid Ethereum address' toast", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    const addr = container.querySelector("input[placeholder='0x... address to share with']") as HTMLInputElement;
    fireEvent.change(addr, { target: { value: "garbage" } });
    await act(async () => {
      fireEvent.click(getByText("Log Access"));
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
  });

  it("valid address → sharePermit(address, level, hours) with defaults (balance-proof + 168h)", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    const addr = container.querySelector("input[placeholder='0x... address to share with']") as HTMLInputElement;
    fireEvent.change(addr, { target: { value: ALICE } });

    await act(async () => {
      fireEvent.click(getByText("Log Access"));
      await Promise.resolve();
    });

    expect(sharePermitMock).toHaveBeenCalledWith(ALICE, "balance-proof", 168);
  });

  it("access-level dropdown switches between 'balance-proof' and 'full'", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    const addr = container.querySelector("input[placeholder='0x... address to share with']") as HTMLInputElement;
    fireEvent.change(addr, { target: { value: ALICE } });
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "full" } });

    await act(async () => {
      fireEvent.click(getByText("Log Access"));
      await Promise.resolve();
    });
    expect(sharePermitMock).toHaveBeenCalledWith(ALICE, "full", 168);
  });

  it("expiry dropdown switches between 24/168/720 hours", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    const addr = container.querySelector("input[placeholder='0x... address to share with']") as HTMLInputElement;
    fireEvent.change(addr, { target: { value: ALICE } });
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[1], { target: { value: "720" } });

    await act(async () => {
      fireEvent.click(getByText("Log Access"));
      await Promise.resolve();
    });
    expect(sharePermitMock).toHaveBeenCalledWith(ALICE, "balance-proof", 720);
  });

  it("Cancel button closes the share form without submitting", () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    fireEvent.click(getByText("Cancel"));
    expect(container.querySelector("input[placeholder='0x... address to share with']")).toBeNull();
    expect(sharePermitMock).not.toHaveBeenCalled();
  });

  it("trims whitespace from address before validation/submit", async () => {
    const { getByLabelText, getByText, container } = withRouter(<Privacy />);
    fireEvent.click(getByLabelText("Share access"));
    const addr = container.querySelector("input[placeholder='0x... address to share with']") as HTMLInputElement;
    fireEvent.change(addr, { target: { value: `  ${ALICE}  ` } });

    await act(async () => {
      fireEvent.click(getByText("Log Access"));
      await Promise.resolve();
    });
    expect(sharePermitMock).toHaveBeenCalledWith(ALICE, "balance-proof", 168);
  });
});

describe("Privacy — time-remaining helper (§15.x)", () => {
  it("displays 'Xh remaining' for sub-day intervals", () => {
    setPrivacy({
      hasPermit: true,
      isExpired: false,
      permitExpiresAt: Date.now() + 5 * 3600_000, // 5h
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toMatch(/5h remaining|4h remaining/);
  });

  it("displays 'Xd Yh remaining' for multi-day intervals", () => {
    setPrivacy({
      hasPermit: true,
      isExpired: false,
      permitExpiresAt: Date.now() + 2 * 86_400_000 + 3 * 3600_000, // 2d 3h
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toMatch(/2d \d+h remaining/);
  });

  it("displays 'Expired' when permit timestamp is in the past", () => {
    setPrivacy({
      hasPermit: true,
      isExpired: true,
      permitExpiresAt: PAST,
    });
    const { container } = withRouter(<Privacy />);
    expect(container.textContent).toContain("Expired");
  });
});
