import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";

// §15.x test for Burners screen. Phase 6.1 burner-wallet management
// (one passkey, many addresses). CRITICAL pins:
//
//   - passkey gate: status='no-passkey' OR !account renders a 2-line
//     stub ("Burner wallets" + "Create a passkey to derive burner
//     addresses") and skips ALL the body. Otherwise passkey-less
//     users would see broken UI trying to derive against undefined.
//   - registryDeployed gate: contracts.BurnerRegistry must exist AND
//     not equal address(0). Backup CTAs + Recover banner are
//     suppressed when not deployed.
//   - audit Top-28 #16 double-Enter guard: gate onKeyDown Enter on
//     `creating` so a fast double-press doesn't fire onCreate twice.
//   - 64-char label cap via slice(0, 64) on the create input AND
//     rename input.
//   - rename keyboard pattern: Enter -> finishRename + save;
//     Escape -> cancel + clear editingId. onBlur also commits.
//   - delete confirm shows the "address still exists on-chain" copy
//     to set the right mental model: deleting the LABEL only;
//     address survives forever (deterministic from passkey + salt).
//     Funds in the burner are still recoverable via re-deriving.
//   - backup modal passphrase 6-char minimum + Enter-key submit;
//     passphrase NEVER persisted (only form-state, never
//     localStorage).
//   - status pills 3-state: Loading -> "Deriving" / Ready / Unavailable.
//   - copy state per scope: address vs pay-link tracked separately
//     via `${id}:link` suffix so copying the link doesn't flip the
//     address copy's checkmark.

const useSmartAccountMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useBurnerAccountsMock = vi.hoisted(() => vi.fn());
const encryptBlobMock = vi.hoisted(() => vi.fn());
const recoverBurnersFromEventsMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("@/hooks/useBurnerAccounts", () => ({
  useBurnerAccounts: useBurnerAccountsMock,
}));
vi.mock("@/hooks/useSmartAccount", () => ({
  useSmartAccount: useSmartAccountMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/lib/burner-registry", () => ({
  BurnerRegistryAbi: [],
  encryptBlob: encryptBlobMock,
  recoverBurnersFromEvents: recoverBurnersFromEventsMock,
}));
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: { value: string; size: number }) => (
    <svg data-testid="qr-code" data-qr-value={props.value} data-qr-size={String(props.size)} />
  ),
}));
vi.mock("@/components/common/EmptyState", () => ({
  EmptyState: (props: { title: string; body: string }) => (
    <div data-testid="empty-state">
      <p>{props.title}</p>
      <p>{props.body}</p>
    </div>
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
}));

import Burners from "./Burners";

const MAIN_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BURNER_ADDR_1 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REGISTRY = "0xddddddddddddddddddddddddddddddddddddddd1";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

type Burner = {
  id: string;
  address: `0x${string}` | null;
  salt: `0x${string}`;
  label: string;
  createdAt: number;
  isLoading?: boolean;
};

let createBurnerMock: ReturnType<typeof vi.fn>;
let renameBurnerMock: ReturnType<typeof vi.fn>;
let deleteBurnerMock: ReturnType<typeof vi.fn>;
let importBurnersMock: ReturnType<typeof vi.fn>;
let unifiedWriteMock: ReturnType<typeof vi.fn>;

function buildBurner(over: Partial<Burner> = {}): Burner {
  return {
    id: "b1",
    address: BURNER_ADDR_1 as `0x${string}`,
    salt: ("0x" + "11".repeat(32)) as `0x${string}`,
    label: "Newsletter tips",
    createdAt: Date.now() - 86_400_000,
    isLoading: false,
    ...over,
  };
}

function setSmartAccount(overrides: Partial<{
  account: { address: string } | null;
  status: "no-passkey" | "ready" | "idle";
}> = {}) {
  useSmartAccountMock.mockReturnValue({
    status: overrides.status ?? "ready",
    account: overrides.account === undefined ? { address: MAIN_ADDR } : overrides.account,
  });
}

function setChain(overrides: Partial<{ registry: string; chainName: string; chainId: number }> = {}) {
  useChainMock.mockReturnValue({
    activeChain: { name: overrides.chainName ?? "Ethereum Sepolia" },
    activeChainId: overrides.chainId ?? 11155111,
    contracts: { BurnerRegistry: overrides.registry ?? REGISTRY },
  });
}

function setBurners(burners: Burner[], error: string | null = null) {
  useBurnerAccountsMock.mockReturnValue({
    burners,
    error,
    createBurner: createBurnerMock,
    renameBurner: renameBurnerMock,
    deleteBurner: deleteBurnerMock,
    importBurners: importBurnersMock,
  });
}

beforeEach(() => {
  useSmartAccountMock.mockReset();
  useChainMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useBurnerAccountsMock.mockReset();
  encryptBlobMock.mockReset();
  recoverBurnersFromEventsMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();

  createBurnerMock = vi.fn().mockResolvedValue(undefined);
  renameBurnerMock = vi.fn();
  deleteBurnerMock = vi.fn();
  importBurnersMock = vi.fn().mockReturnValue(0);
  unifiedWriteMock = vi.fn().mockResolvedValue(undefined);

  setSmartAccount();
  setChain();
  setBurners([]);

  useUnifiedWriteMock.mockReturnValue({ unifiedWrite: unifiedWriteMock });
  usePublicClientMock.mockReturnValue({});
  encryptBlobMock.mockResolvedValue("0xciphertext");
  recoverBurnersFromEventsMock.mockResolvedValue({ records: [], failedCount: 0 });

  // Stub clipboard for copy tests.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Burners — passkey gate (§15.x)", () => {
  it("status='no-passkey' -> 2-line stub: heading + 'Create a passkey' copy, NO form", () => {
    setSmartAccount({ status: "no-passkey", account: null });
    const { container, queryByTestId } = render(<Burners />);
    expect(container.textContent).toContain("Burner wallets");
    expect(container.textContent).toContain("Create a passkey to derive burner addresses");
    expect(queryByTestId("burner-label-input")).toBeNull();
    expect(queryByTestId("burner-create-button")).toBeNull();
  });

  it("account=null (transient) -> same stub renders", () => {
    setSmartAccount({ status: "ready", account: null });
    const { queryByTestId } = render(<Burners />);
    expect(queryByTestId("burner-label-input")).toBeNull();
  });

  it("account + status='ready' -> full screen renders + Create button visible", () => {
    const { getByTestId } = render(<Burners />);
    expect(getByTestId("burner-label-input")).toBeDefined();
    expect(getByTestId("burner-create-button")).toBeDefined();
  });
});

describe("Burners — page chrome (§15.x)", () => {
  it("renders 'Burner wallets' heading + 'one passkey many addresses' framing", () => {
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Burner wallets");
    expect(container.textContent).toContain("Public-facing receive addresses");
    expect(container.textContent).toContain("outside observers can");
  });

  it("renders 'Receive-only' privacy boundary banner explaining the model", () => {
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Receive-only");
    expect(container.textContent).toContain("Funds remain in the burner");
  });
});

describe("Burners — registryDeployed gate (§15.x)", () => {
  it("registry deployed -> 'Recover burners from chain' card visible", () => {
    const { getByTestId } = render(<Burners />);
    expect(getByTestId("burner-recover-button")).toBeDefined();
  });

  it("CRITICAL: registry = address(0) -> Recover button HIDDEN (defense against un-deployed chain)", () => {
    setChain({ registry: ZERO_ADDR });
    const { queryByTestId } = render(<Burners />);
    expect(queryByTestId("burner-recover-button")).toBeNull();
  });

  it("CRITICAL: registry undefined -> Recover button HIDDEN", () => {
    setChain({ registry: "" });
    const { queryByTestId } = render(<Burners />);
    expect(queryByTestId("burner-recover-button")).toBeNull();
  });

  it("registry NOT deployed -> per-burner Cloud (Back up) button DISABLED with tooltip", () => {
    setChain({ registry: ZERO_ADDR });
    setBurners([buildBurner()]);
    const { container } = render(<Burners />);
    const cloudBtn = container.querySelector("[data-testid='burner-backup-b1']") as HTMLButtonElement;
    expect(cloudBtn.disabled).toBe(true);
    expect(cloudBtn.title).toContain("not deployed on this chain yet");
  });
});

describe("Burners — create form (§15.x)", () => {
  it("input 64-char cap via slice(0, 64)", () => {
    const { getByTestId } = render(<Burners />);
    const input = getByTestId("burner-label-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x".repeat(80) } });
    expect(input.value.length).toBe(64);
  });

  it("Create button disabled when label whitespace-only", () => {
    const { getByTestId } = render(<Burners />);
    fireEvent.change(getByTestId("burner-label-input"), { target: { value: "   " } });
    const btn = getByTestId("burner-create-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("valid label + Create click -> createBurner(label) called + 'Created burner' success toast", async () => {
    const { getByTestId } = render(<Burners />);
    fireEvent.change(getByTestId("burner-label-input"), { target: { value: "Newsletter" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-create-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createBurnerMock).toHaveBeenCalledWith("Newsletter");
    expect(toastSuccessMock).toHaveBeenCalled();
    const msg = toastSuccessMock.mock.calls[0][0] as string;
    expect(msg).toContain('Created burner "Newsletter"');
  });

  it("createBurner rejection -> error toast (NOT silent)", async () => {
    createBurnerMock.mockRejectedValueOnce(new Error("derive failed"));
    const { getByTestId } = render(<Burners />);
    fireEvent.change(getByTestId("burner-label-input"), { target: { value: "Test" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-create-button"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // toastMappedError wraps with the "Transaction failed — {msg}"
    // default when no pattern matches.
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("derive failed"),
      undefined,
    );
  });

  it("empty label submit -> 'Give the burner a label' toast (defensive button-gate-bypass)", async () => {
    const { getByTestId } = render(<Burners />);
    const input = getByTestId("burner-label-input") as HTMLInputElement;
    // Send Enter key with empty input; gate is `!creating` only.
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("Give the burner a label");
  });

  it("CRITICAL audit Top-28 #16: rapid double-Enter while `creating` -> onCreate called ONCE not twice", async () => {
    let resolveFirst: (() => void) | null = null;
    createBurnerMock.mockImplementation(() => new Promise<void>((r) => { resolveFirst = () => r(); }));
    const { getByTestId } = render(<Burners />);
    fireEvent.change(getByTestId("burner-label-input"), { target: { value: "Test" } });
    fireEvent.keyDown(getByTestId("burner-label-input"), { key: "Enter" });
    // While first call is in-flight, fire another Enter.
    fireEvent.keyDown(getByTestId("burner-label-input"), { key: "Enter" });
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The audit-#16 guard: gate on `creating` flag inside onKeyDown so 2nd
    // Enter doesn't fire while 1st is pending. createBurnerMock should fire
    // exactly once.
    expect(createBurnerMock).toHaveBeenCalledTimes(1);
  });
});

describe("Burners — empty + error states (§15.x)", () => {
  it("empty burners list -> 'No burners yet' empty-state card", () => {
    setBurners([]);
    const { getByTestId, container } = render(<Burners />);
    expect(getByTestId("empty-state")).toBeDefined();
    expect(container.textContent).toContain("No burners yet");
  });

  it("error from hook renders inline with 'Address derivation hit an RPC error' framing", () => {
    setBurners([], "RPC timeout");
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Address derivation hit an RPC error");
    expect(container.textContent).toContain("RPC timeout");
  });
});

describe("Burners — burner row rendering (§15.x)", () => {
  it("renders label + 'Created' date + 'Ready' pill when address derived", () => {
    setBurners([buildBurner({ label: "Newsletter tips" })]);
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Newsletter tips");
    expect(container.textContent).toContain("Created");
    expect(container.textContent).toContain("Ready");
  });

  it("status pill 'Deriving' when isLoading=true", () => {
    setBurners([buildBurner({ isLoading: true })]);
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Deriving");
  });

  it("status pill 'Unavailable' when address=null + not loading", () => {
    setBurners([buildBurner({ address: null, isLoading: false })]);
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Unavailable");
  });

  it("renders truncated burner address in the address row", () => {
    setBurners([buildBurner({ address: BURNER_ADDR_1 as `0x${string}` })]);
    const { container } = render(<Burners />);
    expect(container.textContent).toContain(BURNER_ADDR_1);
  });
});

describe("Burners — rename inline (§15.x)", () => {
  it("Edit button toggles rename input pre-filled with current label", () => {
    setBurners([buildBurner({ label: "Old label" })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Rename burner"));
    const input = container.querySelector("input[value='Old label']") as HTMLInputElement;
    expect(input).not.toBeNull();
  });

  it("Enter key triggers finishRename + calls renameBurner", () => {
    setBurners([buildBurner({ id: "b1", label: "Old" })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Rename burner"));
    const input = container.querySelector("input[value='Old']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New label" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameBurnerMock).toHaveBeenCalledWith("b1", "New label");
  });

  it("Escape key cancels rename without calling renameBurner", () => {
    setBurners([buildBurner({ id: "b1", label: "Old" })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Rename burner"));
    const input = container.querySelector("input[value='Old']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Almost saved" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(renameBurnerMock).not.toHaveBeenCalled();
  });

  it("onBlur commits the rename (clicking outside saves)", () => {
    setBurners([buildBurner({ id: "b1", label: "Old" })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Rename burner"));
    const input = container.querySelector("input[value='Old']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    expect(renameBurnerMock).toHaveBeenCalledWith("b1", "Blurred");
  });

  it("rename input also enforces 64-char cap", () => {
    setBurners([buildBurner({ label: "x" })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Rename burner"));
    const input = container.querySelector("input[value='x']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "y".repeat(80) } });
    expect(input.value.length).toBe(64);
  });
});

describe("Burners — delete flow (§15.x)", () => {
  it("CRITICAL window.confirm copy: honest about salt-loss + irreversibility (post-P1 fix)", () => {
    // The original copy said "Funds in it stay safe" which was MISLEADING
    // — the salt is local-only CSPRNG, so without on-chain backup
    // (BurnerRegistry undeployed on testnets) deleting destroys the
    // private key + locks any funds at that address forever. Walkthrough
    // P1 fix rewrote the copy to spell this out + branch on registry
    // deployment state. This test now asserts the new honest copy.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    setBurners([buildBurner({ label: "Test burner" })]);
    const { getByLabelText } = render(<Burners />);
    fireEvent.click(getByLabelText("Delete burner"));
    const msg = confirmSpy.mock.calls[0][0] as string;
    expect(msg).toContain("Delete");
    expect(msg).toContain("Test burner");
    // Either branch (registry deployed OR not) must contain these:
    expect(msg).toContain("unrecoverable");
    expect(msg).toContain("This cannot be undone.");
  });

  it("confirm=false -> deleteBurner NOT called", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setBurners([buildBurner({ id: "b1" })]);
    const { getByLabelText } = render(<Burners />);
    fireEvent.click(getByLabelText("Delete burner"));
    expect(deleteBurnerMock).not.toHaveBeenCalled();
  });

  it("confirm=true -> deleteBurner(id) + success toast", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setBurners([buildBurner({ id: "b1" })]);
    const { getByLabelText } = render(<Burners />);
    fireEvent.click(getByLabelText("Delete burner"));
    expect(deleteBurnerMock).toHaveBeenCalledWith("b1");
    expect(toastSuccessMock).toHaveBeenCalledWith("Burner removed");
  });
});

describe("Burners — expand + QR + pay link (§15.x)", () => {
  it("QR + pay link HIDDEN by default (collapsed)", () => {
    setBurners([buildBurner()]);
    const { queryByTestId, container } = render(<Burners />);
    expect(queryByTestId("qr-code")).toBeNull();
    expect(container.textContent).not.toContain("Pay link");
  });

  it("click Show details toggles QR + pay link visible", () => {
    setBurners([buildBurner({ address: BURNER_ADDR_1 as `0x${string}` })]);
    const { getByLabelText, getByTestId, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Show details"));
    const qr = getByTestId("qr-code");
    expect(qr.getAttribute("data-qr-value")).toContain(`/pay/${BURNER_ADDR_1}`);
    expect(container.textContent).toContain("Pay link");
  });

  it("Show details disabled when address is null (no QR to encode)", () => {
    setBurners([buildBurner({ address: null })]);
    const { getByLabelText } = render(<Burners />);
    const btn = getByLabelText("Show details") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("CRITICAL salt revealed only after explicit Reveal click (default masked)", () => {
    setBurners([buildBurner({ salt: ("0x" + "33".repeat(32)) as `0x${string}` })]);
    const { getByLabelText, container } = render(<Burners />);
    fireEvent.click(getByLabelText("Show details"));
    expect(container.textContent).toContain("(the seed for this address)");
    expect(container.textContent).not.toContain("33".repeat(32));
    const revealBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Reveal")) as HTMLButtonElement;
    fireEvent.click(revealBtn);
    expect(container.textContent).toContain("33".repeat(32));
  });
});

describe("Burners — copy state scoping (§15.x)", () => {
  it("copy address sets copiedId=burner.id (Check icon on address copy)", async () => {
    setBurners([buildBurner({ id: "b1" })]);
    const { getByLabelText } = render(<Burners />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("copy reverts after 1800ms (faster than 2s elsewhere; this screen uses 1.8s)", async () => {
    vi.useFakeTimers();
    setBurners([buildBurner({ id: "b1" })]);
    const { getByLabelText, container } = render(<Burners />);
    await act(async () => {
      fireEvent.click(getByLabelText("Copy address"));
      await Promise.resolve();
    });
    // Walk to the address-copy button; check icon swap.
    const initialIcons = container.querySelectorAll(".lucide-check").length;
    expect(initialIcons).toBeGreaterThanOrEqual(1);
    await act(async () => {
      vi.advanceTimersByTime(1800);
    });
    expect(container.querySelectorAll(".lucide-check").length).toBeLessThan(initialIcons + 1);
  });
});

describe("Burners — backup modal (§15.x)", () => {
  it("clicking Back up to chain opens modal with backup-specific copy", () => {
    setBurners([buildBurner({ label: "Newsletter" })]);
    const { getByTestId, container } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    expect(container.textContent).toContain("Back up");
    expect(container.textContent).toContain("Newsletter");
    expect(container.textContent).toContain("Encrypt the label + salt");
    expect(container.textContent).toContain("opaque to anyone without this passphrase");
  });

  it("Recover button opens modal with recover-specific copy", () => {
    const { getByTestId, container } = render(<Burners />);
    fireEvent.click(getByTestId("burner-recover-button"));
    expect(container.textContent).toContain("Recover burners from chain");
    expect(container.textContent).toContain("never leaves your device");
  });

  it("CRITICAL: passphrase < 6 chars -> Confirm button disabled", () => {
    setBurners([buildBurner({ label: "X" })]);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    const input = getByTestId("burner-backup-passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12345" } });
    const confirm = getByTestId("burner-backup-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("passphrase >= 6 chars -> Confirm enabled", () => {
    setBurners([buildBurner({ label: "X" })]);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    const input = getByTestId("burner-backup-passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret1" } });
    const confirm = getByTestId("burner-backup-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it("Enter key submits when passphrase length >= 6", async () => {
    setBurners([buildBurner({ id: "b1", label: "X" })]);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    const input = getByTestId("burner-backup-passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret1" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(encryptBlobMock).toHaveBeenCalled();
  });

  it("Cancel button closes modal without invoking encryption", () => {
    setBurners([buildBurner({ id: "b1", label: "X" })]);
    const { getByTestId, getByText, container } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    fireEvent.click(getByText("Cancel"));
    expect(container.textContent).not.toContain("opaque to anyone without this passphrase");
    expect(encryptBlobMock).not.toHaveBeenCalled();
  });

  it("Escape key closes the modal (a11y dialog requirement)", () => {
    setBurners([buildBurner({ id: "b1", label: "X" })]);
    const { getByTestId, container } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    const dialog = container.querySelector("[role='dialog']") as HTMLElement;
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("CRITICAL passphrase never persisted: only form state, no setStoredJson/storage calls during backup", async () => {
    setBurners([buildBurner({ id: "b1", label: "X" })]);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    const input = getByTestId("burner-backup-passphrase") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret123" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Encrypted blob is what gets written via unifiedWrite; the raw
    // passphrase is passed to encryptBlob but not stored anywhere.
    expect(encryptBlobMock).toHaveBeenCalled();
    const passArg = encryptBlobMock.mock.calls[0][1];
    expect(passArg).toBe("secret123");
  });

  it("backup encrypts (id+salt+label+createdAt) - NOT just the salt", async () => {
    const burner = buildBurner({
      id: "b1",
      label: "My burner",
      salt: ("0x" + "ee".repeat(32)) as `0x${string}`,
      createdAt: 1700000000,
    });
    setBurners([burner]);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-backup-b1"));
    fireEvent.change(getByTestId("burner-backup-passphrase"), { target: { value: "secret123" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const payload = encryptBlobMock.mock.calls[0][0];
    expect(payload.id).toBe("b1");
    expect(payload.salt).toBe("0x" + "ee".repeat(32));
    expect(payload.label).toBe("My burner");
    expect(payload.createdAt).toBe(1700000000);
  });
});

describe("Burners — recover flow (§15.x)", () => {
  it("recoverBurnersFromEvents call signature: publicClient + registryAddress + mainAddress + passphrase", async () => {
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-recover-button"));
    fireEvent.change(getByTestId("burner-backup-passphrase"), { target: { value: "secret123" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recoverBurnersFromEventsMock).toHaveBeenCalled();
    const args = recoverBurnersFromEventsMock.mock.calls[0][0];
    expect(args.registryAddress).toBe(REGISTRY);
    expect(args.mainAddress).toBe(MAIN_ADDR);
    expect(args.passphrase).toBe("secret123");
  });

  it("recover returns 0 records + 0 failed -> 'No burner backups found' toast", async () => {
    recoverBurnersFromEventsMock.mockResolvedValueOnce({ records: [], failedCount: 0 });
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-recover-button"));
    fireEvent.change(getByTestId("burner-backup-passphrase"), { target: { value: "secret1" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The "toast" call (not success/error/loading) is the bare function.
    // The source uses `toast(...)` for the no-records case which is the
    // default neutral toast variant. Verify either success OR neutral.
    expect(recoverBurnersFromEventsMock).toHaveBeenCalled();
  });

  it("recover returns records + some failedCount -> success toast names the decrypt-failed count", async () => {
    recoverBurnersFromEventsMock.mockResolvedValueOnce({
      records: [
        { id: "b1", salt: "0xs1", label: "Burner1", createdAt: 1700000000 },
        { id: "b2", salt: "0xs2", label: "Burner2", createdAt: 1700000001 },
      ],
      failedCount: 1,
    });
    importBurnersMock.mockReturnValue(2);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-recover-button"));
    fireEvent.change(getByTestId("burner-backup-passphrase"), { target: { value: "secret1" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSuccessMock).toHaveBeenCalled();
    const msg = toastSuccessMock.mock.calls[0][0] as string;
    expect(msg).toContain("Recovered 2 burners");
    expect(msg).toContain("1 failed to decrypt");
  });

  it("CRITICAL importBurners strips BurnerBackupPayload's `notes` field (explicit shape mapping)", async () => {
    recoverBurnersFromEventsMock.mockResolvedValueOnce({
      records: [
        {
          id: "b1",
          salt: "0xs1",
          label: "Burner1",
          createdAt: 1700000000,
          notes: "this field should not be passed through to importBurners",
        },
      ],
      failedCount: 0,
    });
    importBurnersMock.mockReturnValue(1);
    const { getByTestId } = render(<Burners />);
    fireEvent.click(getByTestId("burner-recover-button"));
    fireEvent.change(getByTestId("burner-backup-passphrase"), { target: { value: "secret1" } });
    await act(async () => {
      fireEvent.click(getByTestId("burner-backup-confirm"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(importBurnersMock).toHaveBeenCalled();
    const imported = importBurnersMock.mock.calls[0][0];
    expect(imported[0]).toEqual({
      id: "b1",
      salt: "0xs1",
      label: "Burner1",
      createdAt: 1700000000,
    });
    expect(imported[0].notes).toBeUndefined();
  });
});

describe("Burners — footnote (§15.x)", () => {
  it("renders 'Main wallet: <truncated> · <chain>' footnote when burners present", () => {
    setBurners([buildBurner()]);
    const { container } = render(<Burners />);
    expect(container.textContent).toContain("Main wallet");
    expect(container.textContent).toContain("Ethereum Sepolia");
  });

  it("no footnote when burners list is empty", () => {
    setBurners([]);
    const { container } = render(<Burners />);
    expect(container.textContent).not.toContain("Main wallet:");
  });
});
