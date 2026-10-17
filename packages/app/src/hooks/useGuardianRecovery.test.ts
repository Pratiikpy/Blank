import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { encodeAbiParameters, keccak256 } from "viem";

// GuardianModule security-v1: requestRecovery(account, X, Y) commits
// keccak256(abi.encode(X, Y)) of the recovering user's new passkey, and
// finalizeRecoveryAndRotate(account, X, Y) must present the same key.
// finalizeRecovery(address) is retired and must never be called.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const unifiedWriteAndWaitMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ usePublicClient: usePublicClientMock }));
vi.mock("./useEffectiveAddress", () => ({ useEffectiveAddress: useEffectiveAddressMock }));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: () => ({ unifiedWriteAndWait: unifiedWriteAndWaitMock }) }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import {
  useGuardianRecovery,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyHashOf,
} from "./useGuardianRecovery";

const GM = "0x9999999999999999999999999999999999999999";
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const ME = "0x2222222222222222222222222222222222222222" as const;
const KEY = { x: 0xabcn, y: 0xdefn };

describe("recovery key helpers", () => {
  it("hash matches the contract's keccak256(abi.encode(x, y))", () => {
    expect(recoveryKeyHashOf(KEY)).toBe(
      keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [KEY.x, KEY.y])),
    );
  });

  it("format / parse round-trip, with or without the prefix", () => {
    const s = formatRecoveryKey(KEY);
    expect(s).toMatch(/^blank-recovery-key:0x[0-9a-f]{64}:0x[0-9a-f]{64}$/);
    expect(parseRecoveryKey(s)).toEqual(KEY);
    expect(parseRecoveryKey(`  ${s.replace("blank-recovery-key:", "")}  `)).toEqual(KEY);
  });

  it("rejects malformed or zero keys", () => {
    expect(parseRecoveryKey("0x12")).toBeNull();
    expect(parseRecoveryKey("blank-recovery-key:0x0:0x0")).toBeNull();
    expect(parseRecoveryKey("blank-recovery-key:0xzz:0x1")).toBeNull();
  });
});

describe("useGuardianRecovery writes", () => {
  const readContract = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
    useChainMock.mockReturnValue({ activeChainId: 84532, contracts: { GuardianModule: GM } });
    usePublicClientMock.mockReturnValue({ readContract });
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "guardiansOf": return [ME];
        case "thresholdOf": return 2;
        case "recoveryState": return [ACCOUNT, 100, 1, false, false];
        case "effectiveRecoveryWindow": return 86_400;
        case "recoveryKeyHash": return recoveryKeyHashOf(KEY);
        case "vetoQuorum": return 2n;
        case "hasApproved": return true;
        case "hasVetoed": return false;
        default: throw new Error(`unexpected ${functionName}`);
      }
    });
    unifiedWriteAndWaitMock.mockResolvedValue({ hash: "0xtx" });
  });

  it("refresh reads the committed key hash, veto quorum, window and my vote", async () => {
    const { result } = renderHook(() => useGuardianRecovery());
    await waitFor(() => expect(result.current.committedKeyHash).toBe(recoveryKeyHashOf(KEY)));
    expect(result.current.vetoQuorum).toBe(2);
    expect(result.current.windowSec).toBe(86_400);
    expect(result.current.myApproval).toEqual({ approved: true, vetoed: false });
  });

  it("requestRecovery(account, key) sends (account, X, Y)", async () => {
    const { result } = renderHook(() => useGuardianRecovery());
    await act(async () => { await result.current.requestRecovery(ACCOUNT, KEY); });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.address).toBe(GM);
    expect(call.functionName).toBe("requestRecovery");
    expect(call.args).toEqual([ACCOUNT, KEY.x, KEY.y]);
  });

  it("finalizeRecovery calls finalizeRecoveryAndRotate(account, X, Y), never the retired finalizeRecovery", async () => {
    const { result } = renderHook(() => useGuardianRecovery());
    await act(async () => { await result.current.finalizeRecovery(ACCOUNT, KEY); });
    const call = unifiedWriteAndWaitMock.mock.calls[0][0];
    expect(call.functionName).toBe("finalizeRecoveryAndRotate");
    expect(call.args).toEqual([ACCOUNT, KEY.x, KEY.y]);
    // the ABI no longer exposes the retired entry point at all
    expect((call.abi as Array<{ name?: string }>).some((e) => e.name === "finalizeRecovery")).toBe(false);
  });

  it("not deployed on this chain -> no write", async () => {
    useChainMock.mockReturnValue({ activeChainId: 84532, contracts: { GuardianModule: "0x0000000000000000000000000000000000000000" } });
    const { result } = renderHook(() => useGuardianRecovery());
    expect(result.current.deploy.status).toBe("not-deployed");
    await act(async () => { await result.current.requestRecovery(ACCOUNT, KEY); });
    expect(unifiedWriteAndWaitMock).not.toHaveBeenCalled();
  });
});
