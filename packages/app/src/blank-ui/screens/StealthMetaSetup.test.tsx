import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for StealthMetaSetup screen. Phase 9.6 ERC-6538 meta-
// address setup with a 4-state machine. CRITICAL pins:
//   - 4 states drive radically different UI: no-account / empty /
//     generated / published. A regression that breaks the state
//     formula (e.g. inverts !record.publishedAt) would leak the
//     "Publish to registry" CTA to already-published users or
//     vice versa.
//   - audit Top-28 #11: registry address read from useChain()
//     contracts.ERC6538Registry so a reload-free chain switch
//     reaches the right address.
//   - CRITICAL privacy trade-off warning on the publish CTA: the
//     publish UserOp permanently links mainAA -> metaAddress
//     on-chain via the ERC-6538 Registry. The warning has to be
//     visible BEFORE publish so the user can make an informed
//     decision (e.g. publish from a fresh burner AA instead).
//     Without this banner the screen would be quietly violating
//     the privacy contract.
//   - explorer link per chain: sepolia/base-sepolia mapping; null
//     for other chain ids hides the link (no broken explorer URL)
//   - plaintext-storage warning in published state (UX honesty
//     about Phase 9.6.1 deferred encryption-at-rest)
//   - reset gates on window.confirm + clearStealthKeys + setRecord(null)

const useNavigateMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePassphrasePromptMock = vi.hoisted(() => vi.fn());
const loadStealthKeysMock = vi.hoisted(() => vi.fn());
const saveStealthKeysAsyncMock = vi.hoisted(() => vi.fn());
const clearStealthKeysMock = vi.hoisted(() => vi.fn());
const unlockStealthKeysMock = vi.hoisted(() => vi.fn());
const hasStealthKeysStoredMock = vi.hoisted(() => vi.fn());
const metaAddressFromPrivKeysMock = vi.hoisted(() => vi.fn());
const parseMetaAddressMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useNavigate: () => useNavigateMock }));
vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useUnifiedWrite", () => ({
  useUnifiedWrite: useUnifiedWriteMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/components/PassphrasePrompt", () => ({
  usePassphrasePrompt: usePassphrasePromptMock,
}));
vi.mock("@/lib/abis", () => ({ ERC6538RegistryAbi: [] }));
vi.mock("@/lib/stealth", () => ({
  metaAddressFromPrivKeys: metaAddressFromPrivKeysMock,
  parseMetaAddress: parseMetaAddressMock,
}));
vi.mock("@/lib/stealth-keystore", () => ({
  loadStealthKeys: loadStealthKeysMock,
  saveStealthKeysAsync: saveStealthKeysAsyncMock,
  clearStealthKeys: clearStealthKeysMock,
  unlockStealthKeys: unlockStealthKeysMock,
  hasStealthKeysStored: hasStealthKeysStoredMock,
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: copyToClipboardMock }));
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: { value: string }) => (
    <svg data-testid="qr-code" data-qr-value={props.value} />
  ),
}));
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccessMock, error: toastErrorMock },
}));

import StealthMetaSetup from "./StealthMetaSetup";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REGISTRY = "0xerc6538registryerc6538registryerc6538re";
const META = "st:eth:0x" + "a".repeat(132);
const SPENDING_KEY = "0x" + "1".repeat(64);
const VIEWING_KEY = "0x" + "2".repeat(64);
const PUBLISH_TX = "0xpublishtxhash";

type StealthKeyRecord = {
  spendingPrivateKey: string;
  viewingPrivateKey: string;
  metaAddress: string;
  publishTxHash?: string;
  publishedAt?: number;
};

let unifiedWriteAndWaitMock: ReturnType<typeof vi.fn>;
let passphraseRequestMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useNavigateMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useChainMock.mockReset();
  usePassphrasePromptMock.mockReset();
  loadStealthKeysMock.mockReset();
  saveStealthKeysAsyncMock.mockReset();
  clearStealthKeysMock.mockReset();
  unlockStealthKeysMock.mockReset();
  hasStealthKeysStoredMock.mockReset();
  metaAddressFromPrivKeysMock.mockReset();
  parseMetaAddressMock.mockReset();
  copyToClipboardMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { ERC6538Registry: REGISTRY },
  });

  unifiedWriteAndWaitMock = vi.fn().mockResolvedValue({ hash: PUBLISH_TX });
  useUnifiedWriteMock.mockReturnValue({ unifiedWriteAndWait: unifiedWriteAndWaitMock });

  passphraseRequestMock = vi.fn().mockResolvedValue("hunter2");
  usePassphrasePromptMock.mockReturnValue({ request: passphraseRequestMock });

  loadStealthKeysMock.mockReturnValue(null);
  hasStealthKeysStoredMock.mockReturnValue(false);
  saveStealthKeysAsyncMock.mockResolvedValue(true);
  unlockStealthKeysMock.mockResolvedValue(null);
  metaAddressFromPrivKeysMock.mockReturnValue({ metaAddress: META });
  parseMetaAddressMock.mockReturnValue({
    spendingPubKey: "0x" + "33".repeat(33),
    viewingPubKey: "0x" + "44".repeat(33),
  });
  copyToClipboardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StealthMetaSetup — page chrome (§15.x)", () => {
  it("renders 'Stealth Meta-Address' heading + the privacy framing copy", () => {
    const { container } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Stealth Meta-Address");
    expect(container.textContent).toContain("Publish a permanent meta-address");
    expect(container.textContent).toContain("Senders derive a fresh");
    expect(container.textContent).toContain("link those payments to your main wallet");
  });

  it("back button navigates(-1)", () => {
    const { getByLabelText } = render(<StealthMetaSetup />);
    fireEvent.click(getByLabelText("Go back"));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });
});

describe("StealthMetaSetup — state machine (§15.x)", () => {
  it("no-account state (!effectiveAddress): 'Connect a wallet' message", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    const { container } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Connect a wallet to set up your stealth meta-address");
  });

  it("empty state (no record + no stored keys): 'Generate keys' CTA visible", () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(false);
    const { container } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Generate your stealth keys");
    expect(container.textContent).toContain("spending key");
    expect(container.textContent).toContain("viewing key");
  });

  it("locked state (stored keys exist but no in-memory record): 'Unlock' CTA shown", async () => {
    loadStealthKeysMock.mockReturnValue(null);
    hasStealthKeysStoredMock.mockReturnValue(true);
    const { container, findByText } = render(<StealthMetaSetup />);
    await findByText("Stealth keys are locked");
    expect(container.textContent).toContain("Stealth keys are locked");
    expect(container.textContent).toContain("Encrypted keys for this account are stored on this device");
  });

  it("generated state (record exists, no publishedAt): 'Not published' pill + 'Publish meta-address' CTA", () => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
    const { container, getByText } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Not published");
    expect(getByText("Publish meta-address")).toBeDefined();
    expect(container.textContent).toContain("Your meta-address");
  });

  it("published state (record + publishedAt set): 'Published' pill + 'Open Stealth Inbox' CTA + 'Publish meta-address' HIDDEN", () => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
      publishTxHash: PUBLISH_TX,
      publishedAt: 1700000000,
    } as StealthKeyRecord);
    const { container, queryByText } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Published");
    expect(container.textContent).toContain("live on the ERC-6538 Registry");
    expect(container.textContent).toContain("Open Stealth Inbox");
    expect(queryByText("Publish meta-address")).toBeNull();
  });
});

describe("StealthMetaSetup — generate flow (§15.x)", () => {
  it("clicking 'Generate keys' prompts passphrase + saves new record + success toast", async () => {
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Generate keys"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(passphraseRequestMock).toHaveBeenCalled();
    expect(metaAddressFromPrivKeysMock).toHaveBeenCalled();
    expect(saveStealthKeysAsyncMock).toHaveBeenCalled();
    const [savedAddr, savedRecord, savedPass] = saveStealthKeysAsyncMock.mock.calls[0];
    expect(savedAddr).toBe(ME);
    expect(savedRecord.metaAddress).toBe(META);
    expect(savedPass).toBe("hunter2");
    expect(toastSuccessMock).toHaveBeenCalled();
    expect((toastSuccessMock.mock.calls[0][0] as string)).toContain("Stealth keys generated");
  });

  it("user cancels passphrase prompt (returns null) -> no save + no state change", async () => {
    passphraseRequestMock.mockResolvedValueOnce(null);
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Generate keys"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveStealthKeysAsyncMock).not.toHaveBeenCalled();
    expect(metaAddressFromPrivKeysMock).not.toHaveBeenCalled();
  });

  it("saveStealthKeysAsync returns false -> error toast (NOT silent), no state change", async () => {
    saveStealthKeysAsyncMock.mockResolvedValueOnce(false);
    const { getByText, container } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Generate keys"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("Couldn't save stealth keys");
    // Still in empty state, generate CTA still visible.
    expect(container.textContent).toContain("Generate keys");
  });
});

describe("StealthMetaSetup — publish flow + CRITICAL privacy trade-off (§15.x)", () => {
  beforeEach(() => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
  });

  it("CRITICAL privacy trade-off warning is visible BEFORE publish (linkage disclosure)", () => {
    const { container } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("This publish links your meta-address to your main wallet on-chain");
    expect(container.textContent).toContain("Anyone querying the ERC-6538 Registry");
    expect(container.textContent).toContain("tie every stealth payment back to it");
    expect(container.textContent).toContain("consider publishing from a fresh burner AA");
  });

  it("publish click calls unifiedWriteAndWait with registry address + registerKeys + SCHEME_ID=1 + bytes", async () => {
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Publish meta-address"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unifiedWriteAndWaitMock).toHaveBeenCalled();
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(REGISTRY);
    expect(call.functionName).toBe("registerKeys");
    expect(call.args[0]).toBe(1n); // SCHEME_ID
    expect(call.args[1]).toMatch(/^0x[0-9a-f]+$/i); // bytes from metaAddressToRegistryBytes
  });

  it("publish success: saves publishedAt + publishTxHash + 'Published' toast", async () => {
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Publish meta-address"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveStealthKeysAsyncMock).toHaveBeenCalled();
    const [, savedRecord] = saveStealthKeysAsyncMock.mock.calls[0];
    expect(savedRecord.publishTxHash).toBe(PUBLISH_TX);
    expect(typeof savedRecord.publishedAt).toBe("number");
    expect(toastSuccessMock).toHaveBeenCalled();
    expect((toastSuccessMock.mock.calls[0][0] as string)).toContain("Meta-address published");
  });

  it("publish failure: inline error message + 'Publish failed' toast", async () => {
    unifiedWriteAndWaitMock.mockRejectedValueOnce(new Error("paymaster rejected"));
    const { getByText, container } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Publish meta-address"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("paymaster rejected");
    expect(toastErrorMock).toHaveBeenCalled();
    expect((toastErrorMock.mock.calls[0][0] as string)).toContain("Publish failed");
  });

  it("publish button disabled + shows 'Publishing…' while busy", async () => {
    let resolvePublish!: (v: { hash: string }) => void;
    unifiedWriteAndWaitMock.mockReturnValue(
      new Promise<{ hash: string }>((res) => { resolvePublish = res; }),
    );
    const { getByText, container } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Publish meta-address"));
    await waitFor(() => expect(container.textContent).toContain("Publishing"));
    const btn = getByText("Publishing…") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => {
      resolvePublish({ hash: PUBLISH_TX });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

describe("StealthMetaSetup — published state actions (§15.x)", () => {
  beforeEach(() => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
      publishTxHash: PUBLISH_TX,
      publishedAt: 1700000000,
    } as StealthKeyRecord);
  });

  it("'Open Stealth Inbox' button navigates to /app/stealth/inbox", () => {
    const { getByText } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Open Stealth Inbox"));
    expect(useNavigateMock).toHaveBeenCalledWith("/app/stealth/inbox");
  });

  it("Sepolia (11155111) explorer link: sepolia.etherscan.io/tx/<hash>", () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ERC6538Registry: REGISTRY },
    });
    const { getByText, container } = render(<StealthMetaSetup />);
    const link = getByText("View tx").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`https://sepolia.etherscan.io/tx/${PUBLISH_TX}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(container.innerHTML).toBeDefined();
  });

  it("Base Sepolia (84532) explorer link: sepolia-explorer.base.org/tx/<hash>", () => {
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      contracts: { ERC6538Registry: REGISTRY },
    });
    const { getByText } = render(<StealthMetaSetup />);
    const link = getByText("View tx").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`https://sepolia-explorer.base.org/tx/${PUBLISH_TX}`);
  });

  it("Arbitrum Sepolia (421614) explorer link: sepolia.arbiscan.io/tx/<hash>", () => {
    useChainMock.mockReturnValue({
      activeChainId: 421614,
      contracts: { ERC6538Registry: REGISTRY },
    });
    const { getByText } = render(<StealthMetaSetup />);
    const link = getByText("View tx").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`https://sepolia.arbiscan.io/tx/${PUBLISH_TX}`);
  });

  it("CRITICAL unknown chain: explorer link HIDDEN (no broken URL)", () => {
    useChainMock.mockReturnValue({
      activeChainId: 99999,
      contracts: { ERC6538Registry: REGISTRY },
    });
    const { queryByText } = render(<StealthMetaSetup />);
    expect(queryByText("View tx")).toBeNull();
  });
});

describe("StealthMetaSetup — backup keys warning + show/hide (§15.x)", () => {
  beforeEach(() => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
  });

  it("CRITICAL plaintext-storage warning is visible (UX honesty about Phase 9.6.1 deferred encryption-at-rest)", () => {
    const { container } = render(<StealthMetaSetup />);
    expect(container.textContent).toContain("Keys are stored as plaintext in this browser");
    expect(container.textContent).toContain("Anyone with access to this browser can sweep");
    expect(container.textContent).toContain("Encrypted-at-rest storage is on the roadmap");
  });

  it("'Show backup keys' click reveals BOTH spending + viewing private keys", () => {
    const { getByText, container } = render(<StealthMetaSetup />);
    expect(container.textContent).not.toContain(SPENDING_KEY);
    fireEvent.click(getByText("Show backup keys"));
    expect(container.textContent).toContain(SPENDING_KEY);
    expect(container.textContent).toContain(VIEWING_KEY);
  });

  it("backup keys panel distinguishes 'spending key (sweep authority)' from 'viewing key (safe to share with auditors)'", () => {
    const { getByText, container } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Show backup keys"));
    expect(container.textContent).toContain("Spending key (sweep authority)");
    expect(container.textContent).toContain("Viewing key");
    expect(container.textContent).toContain("safe to share with auditors");
  });

  it("toggle: clicking again hides the keys (button reads 'Hide private keys')", () => {
    const { getByText, container } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Show backup keys"));
    expect(container.textContent).toContain(SPENDING_KEY);
    fireEvent.click(getByText("Hide private keys"));
    expect(container.textContent).not.toContain(SPENDING_KEY);
  });
});

describe("StealthMetaSetup — reset flow (§15.x)", () => {
  beforeEach(() => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
  });

  it("reset gates on window.confirm + 'permanent inaccessibility' warning copy", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Reset stealth keys"));
    expect(confirmSpy).toHaveBeenCalled();
    const msg = confirmSpy.mock.calls[0][0] as string;
    expect(msg).toContain("permanently inaccessible UNLESS you've backed up");
  });

  it("confirm=false -> clearStealthKeys NOT called", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Reset stealth keys"));
    expect(clearStealthKeysMock).not.toHaveBeenCalled();
  });

  it("confirm=true -> clearStealthKeys(address) + success toast + state regresses to empty", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByText, container } = render(<StealthMetaSetup />);
    fireEvent.click(getByText("Reset stealth keys"));
    expect(clearStealthKeysMock).toHaveBeenCalledWith(ME);
    expect(toastSuccessMock).toHaveBeenCalledWith("Stealth keys cleared");
    // Re-renders to the empty state.
    expect(container.textContent).toContain("Generate your stealth keys");
  });
});

describe("StealthMetaSetup — copy + share (§15.x)", () => {
  beforeEach(() => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
  });

  it("Copy button writes the meta-address via copyToClipboard + 'Copied' toast", async () => {
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Copy"));
      await Promise.resolve();
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith(META);
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied");
  });

  it("copied state reverts after 1500ms (NOTE: 1.5s here, vs 2s elsewhere)", async () => {
    vi.useFakeTimers();
    const { getByText, container } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Copy"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Copied");
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(container.textContent).not.toContain("Copied");
  });

  it("share with navigator.share: calls share + does NOT fall back to copy", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Share"));
      await Promise.resolve();
    });
    expect(shareMock).toHaveBeenCalled();
    const arg = shareMock.mock.calls[0][0];
    expect(arg.title).toBe("My stealth meta-address");
    expect(arg.text).toContain(META);
    expect(copyToClipboardMock).not.toHaveBeenCalled();
  });

  it("share fallback when no navigator.share: calls copyToClipboard(META)", async () => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Share"));
      await Promise.resolve();
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith(META);
  });

  it("share cancellation (navigator.share rejects): NO fallback (user-cancel is not an error)", async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error("cancelled"));
    Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
    const { getByText } = render(<StealthMetaSetup />);
    await act(async () => {
      fireEvent.click(getByText("Share"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("StealthMetaSetup — QR code (§15.x)", () => {
  it("QR encodes the meta-address (not the public address)", () => {
    loadStealthKeysMock.mockReturnValue({
      spendingPrivateKey: SPENDING_KEY,
      viewingPrivateKey: VIEWING_KEY,
      metaAddress: META,
    } as StealthKeyRecord);
    const { getByTestId } = render(<StealthMetaSetup />);
    const qr = getByTestId("qr-code");
    expect(qr.getAttribute("data-qr-value")).toBe(META);
  });

  it("QR NOT rendered in empty state", () => {
    loadStealthKeysMock.mockReturnValue(null);
    const { queryByTestId } = render(<StealthMetaSetup />);
    expect(queryByTestId("qr-code")).toBeNull();
  });
});
