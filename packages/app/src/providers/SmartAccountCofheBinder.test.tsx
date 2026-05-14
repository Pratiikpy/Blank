import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// §15.x test for SmartAccountCofheBinder. The R5-D wire-up
// provider: mounts once under CofheProvider + PassphrasePrompt
// Provider, and when a passkey-backed smart account is ready
// AND deployed, constructs a CofheSmartAccountClient (passphrase-
// prompting signer routed through @cofhe/sdk/adapters/smart
// WalletViemAdapter) and binds the SDK to it. When the account
// is gone / undeployed / status not ready, the binding clears so
// useCofheConnection falls back to the EOA path.
//
// CRITICAL pins:
//   - Side-effect component returns null (renders nothing); test
//     pins via container.firstChild === null so a regression that
//     adds visible markup doesn't silently break layouts that
//     position siblings.
//   - 4-guard chain returning null client (each is independently
//     load-bearing): status !== "ready" / account === null /
//     publicClient === null / !account.isDeployed. The undeployed
//     check matters because ERC-1271 verification requires the
//     account to be deployed on-chain before the SDK can verify
//     our signatures via ACL.checkPermitValidity; undeployed
//     accounts stay null here + the first UserOp (shield/send/etc)
//     deploys the account, then the next mount cycle picks up
//     isDeployed=true and activates the binding.
//   - useCofheSmartWalletBinding ALWAYS called with (client,
//     activeChainId) including null client — passing null clears
//     the binding so useCofheConnection reclaims the EOA path on
//     the next tick. A regression that early-returned BEFORE
//     calling useCofheSmartWalletBinding would leak a stale binding
//     from before the user disconnected the smart account.
//   - Chain fallback: prefer wagmiChain (typed chain object so
//     viem's typed clients line up), fall back to canonical chain
//     for activeChainId; activeChainId === baseSepolia.id (84532)
//     -> baseSepolia, anything else -> sepolia. The fallback
//     covers passkey-only mode where no EOA is connected and
//     wagmi.useAccount returns no chain.
//   - §3.21 structured-logger: log.debug('smartAccountCofheBinder
//     .stateCheck', { status, hasAccount, isDeployed, hasPublicClient,
//     activeChainId }) fires on every render so production telemetry
//     (Sentry sink wired per §3.22) can see state-machine
//     transitions. log.debug is filtered to dev in console-sink via
//     lib/log.ts production filter so this doesn't spam end-user
//     consoles.
//   - useMemo dependencies pinned: [status, account?.address,
//     account?.isDeployed, activeChainId, publicClient, wagmiChain]
//     — NOT including the account object itself (only address +
//     isDeployed) because useSmartAccount may return a new object
//     reference each render even when address/isDeployed haven't
//     changed; without this scoping the client would rebuild every
//     render and re-trigger the SDK binding handshake. request
//     Passphrase is intentionally NOT a dep — it's stable across
//     renders (useCallback inside PassphrasePromptProvider with
//     empty deps) per the eslint-disable comment.

const useSmartAccountMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useAccountMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const usePassphrasePromptMock = vi.hoisted(() => vi.fn());
const useCofheSmartWalletBindingMock = vi.hoisted(() => vi.fn());
const buildBlankSmartAccountClientMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  usePublicClient: usePublicClientMock,
  useAccount: useAccountMock,
}));
vi.mock("wagmi/chains", () => ({
  sepolia: { id: 11155111, name: "Sepolia" },
  baseSepolia: { id: 84532, name: "Base Sepolia" },
}));
vi.mock("@/hooks/useSmartAccount", () => ({
  useSmartAccount: useSmartAccountMock,
}));
vi.mock("@/components/PassphrasePrompt", () => ({
  usePassphrasePrompt: usePassphrasePromptMock,
}));
vi.mock("./ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/cofhe-shim", () => ({
  useCofheSmartWalletBinding: useCofheSmartWalletBindingMock,
}));
vi.mock("@/lib/smart-account-cofhe-bridge", () => ({
  buildBlankSmartAccountClient: buildBlankSmartAccountClientMock,
}));
vi.mock("@/lib/log", () => ({
  log: {
    debug: logDebugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SmartAccountCofheBinder } from "./SmartAccountCofheBinder";

const SA_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const EOA_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

const fakeClient = { __fake: "client" };
const fakePublicClient = { chain: { id: 11155111 } };
const requestPassphraseMock = vi.fn();

beforeEach(() => {
  useSmartAccountMock.mockReset();
  useChainMock.mockReset();
  useAccountMock.mockReset();
  usePublicClientMock.mockReset();
  usePassphrasePromptMock.mockReset();
  useCofheSmartWalletBindingMock.mockReset();
  buildBlankSmartAccountClientMock.mockReset();
  logDebugMock.mockReset();

  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  useAccountMock.mockReturnValue({
    chain: { id: 11155111, name: "Sepolia (wagmi)" },
    address: EOA_ADDR,
  });
  usePublicClientMock.mockReturnValue(fakePublicClient);
  usePassphrasePromptMock.mockReturnValue({ request: requestPassphraseMock });
  buildBlankSmartAccountClientMock.mockReturnValue(fakeClient);
});

// ───────────────────────────────────────────────────────────
//  Renders nothing (side-effect-only component)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — render (§15.x)", () => {
  it("renders nothing (returns null)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "no-passkey",
      account: null,
    });
    const { container } = render(<SmartAccountCofheBinder />);
    expect(container.firstChild).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  4-guard chain (each returns null client)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — guard chain returns null client (§15.x)", () => {
  it("status !== 'ready' -> null client + buildBlankSmartAccountClient NOT called", () => {
    useSmartAccountMock.mockReturnValue({
      status: "no-passkey",
      account: null,
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(0);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(null, 11155111);
  });

  it("status='ready' but account null -> null client", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: null,
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(0);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(null, 11155111);
  });

  it("status='ready', account set, but publicClient null -> null client", () => {
    usePublicClientMock.mockReturnValue(null);
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(0);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(null, 11155111);
  });

  it("status='ready', account set, publicClient set, but !isDeployed -> null client", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: false },
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(0);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(null, 11155111);
  });
});

// ───────────────────────────────────────────────────────────
//  Happy path (all 4 guards satisfied)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — happy path build (§15.x)", () => {
  it("all guards pass -> buildBlankSmartAccountClient called with (account, chainId, publicClient, chain, requestPassphrase)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
    const args = buildBlankSmartAccountClientMock.mock.calls[0][0];
    expect(args.account).toEqual({ address: SA_ADDR, isDeployed: true });
    expect(args.chainId).toBe(11155111);
    expect(args.publicClient).toBe(fakePublicClient);
    expect(args.chain).toEqual({ id: 11155111, name: "Sepolia (wagmi)" }); // wagmiChain
    expect(args.requestPassphrase).toBe(requestPassphraseMock);
  });

  it("happy path -> useCofheSmartWalletBinding called with (client, activeChainId)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(
      fakeClient,
      11155111,
    );
  });
});

// ───────────────────────────────────────────────────────────
//  Chain fallback (wagmiChain ?? sepolia | baseSepolia)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — chain fallback (§15.x)", () => {
  it("wagmiChain present -> uses it (typed chain object)", () => {
    const wagmiChain = { id: 11155111, name: "WAGMI_SEPOLIA" };
    useAccountMock.mockReturnValue({ chain: wagmiChain, address: EOA_ADDR });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock.mock.calls[0][0].chain).toBe(
      wagmiChain,
    );
  });

  it("wagmiChain undefined + activeChainId=11155111 -> falls back to sepolia canonical", () => {
    useAccountMock.mockReturnValue({ chain: undefined, address: undefined });
    useChainMock.mockReturnValue({ activeChainId: 11155111 });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    const chain = buildBlankSmartAccountClientMock.mock.calls[0][0].chain;
    expect(chain).toEqual({ id: 11155111, name: "Sepolia" });
  });

  it("wagmiChain undefined + activeChainId=84532 -> falls back to baseSepolia canonical", () => {
    useAccountMock.mockReturnValue({ chain: undefined, address: undefined });
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    const chain = buildBlankSmartAccountClientMock.mock.calls[0][0].chain;
    expect(chain).toEqual({ id: 84532, name: "Base Sepolia" });
  });

  it("wagmiChain undefined + activeChainId=unknown -> falls back to sepolia (default)", () => {
    useAccountMock.mockReturnValue({ chain: undefined, address: undefined });
    useChainMock.mockReturnValue({ activeChainId: 99999 });
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    const chain = buildBlankSmartAccountClientMock.mock.calls[0][0].chain;
    // Anything other than 84532 falls back to sepolia
    expect(chain).toEqual({ id: 11155111, name: "Sepolia" });
  });
});

// ───────────────────────────────────────────────────────────
//  Binding always called (even with null client)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — useCofheSmartWalletBinding always called (§15.x)", () => {
  it("null client path -> binding called with (null, activeChainId) so EOA can reclaim", () => {
    useSmartAccountMock.mockReturnValue({
      status: "no-passkey",
      account: null,
    });
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    render(<SmartAccountCofheBinder />);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(null, 84532);
  });

  it("happy client path -> binding called with (client, activeChainId)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    render(<SmartAccountCofheBinder />);
    expect(useCofheSmartWalletBindingMock).toHaveBeenCalledWith(
      fakeClient,
      84532,
    );
  });
});

// ───────────────────────────────────────────────────────────
//  §3.21 structured-logger
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — §3.21 state-check log (§15.x)", () => {
  it("log.debug fires with stateCheck payload", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    expect(logDebugMock).toHaveBeenCalledWith(
      "smartAccountCofheBinder.stateCheck",
      expect.objectContaining({
        status: "ready",
        hasAccount: true,
        isDeployed: true,
        hasPublicClient: true,
        activeChainId: 11155111,
      }),
    );
  });

  it("log payload reflects no-passkey state correctly", () => {
    useSmartAccountMock.mockReturnValue({
      status: "no-passkey",
      account: null,
    });
    render(<SmartAccountCofheBinder />);
    const payload = logDebugMock.mock.calls.find(
      (c) => c[0] === "smartAccountCofheBinder.stateCheck",
    )?.[1];
    expect(payload).toMatchObject({
      status: "no-passkey",
      hasAccount: false,
      hasPublicClient: true,
    });
  });

  it("log payload hasPublicClient=false when publicClient null", () => {
    usePublicClientMock.mockReturnValue(null);
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    render(<SmartAccountCofheBinder />);
    const payload = logDebugMock.mock.calls.find(
      (c) => c[0] === "smartAccountCofheBinder.stateCheck",
    )?.[1];
    expect(payload).toMatchObject({
      hasPublicClient: false,
    });
  });

  it("log payload isDeployed=false when account undeployed", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: false },
    });
    render(<SmartAccountCofheBinder />);
    const payload = logDebugMock.mock.calls.find(
      (c) => c[0] === "smartAccountCofheBinder.stateCheck",
    )?.[1];
    expect(payload).toMatchObject({
      hasAccount: true,
      isDeployed: false,
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Rebuild on dep change (memo correctness)
// ───────────────────────────────────────────────────────────

describe("SmartAccountCofheBinder — useMemo rebuild deps (§15.x)", () => {
  it("re-render with SAME deps -> buildBlankSmartAccountClient NOT re-called", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    const { rerender } = render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
    rerender(<SmartAccountCofheBinder />);
    // Same deps -> memo cached, no rebuild
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
  });

  it("activeChainId change -> rebuild (binding re-fires with new chain)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    useChainMock.mockReturnValue({ activeChainId: 11155111 });
    const { rerender } = render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    rerender(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(2);
    expect(buildBlankSmartAccountClientMock.mock.calls[1][0].chainId).toBe(
      84532,
    );
  });

  it("isDeployed flip false -> true -> rebuild (first UserOp activates binding)", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: false },
    });
    const { rerender } = render(<SmartAccountCofheBinder />);
    // undeployed -> null client, no build
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(0);
    expect(useCofheSmartWalletBindingMock).toHaveBeenLastCalledWith(null, 11155111);
    // First UserOp deploys; next mount cycle picks up isDeployed=true
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    rerender(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
    expect(useCofheSmartWalletBindingMock).toHaveBeenLastCalledWith(
      fakeClient,
      11155111,
    );
  });

  it("account.address change (smart-wallet swap) -> rebuild", () => {
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: SA_ADDR, isDeployed: true },
    });
    const { rerender } = render(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(1);
    const NEW_SA = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;
    useSmartAccountMock.mockReturnValue({
      status: "ready",
      account: { address: NEW_SA, isDeployed: true },
    });
    rerender(<SmartAccountCofheBinder />);
    expect(buildBlankSmartAccountClientMock).toHaveBeenCalledTimes(2);
    expect(buildBlankSmartAccountClientMock.mock.calls[1][0].account.address).toBe(
      NEW_SA,
    );
  });
});
