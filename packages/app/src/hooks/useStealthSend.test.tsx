import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useStealthSend. Phase 9.3 ERC-5564 stealth-send sender
// flow. Exports two functions: useStealthMetaAddressLookup (reads ERC-6538
// Registry) and useStealthSend (batched transfer + announce UserOp).
//
// CRITICAL pins:
//   - registry blob decoding: 66-byte raw output from
//     stealthMetaAddressOf MUST be exactly 134 chars (0x + 132 hex).
//     Defensive length check rejects malformed blobs because the
//     canonical contract enforces no length, so a malformed registration
//     IS possible. Returns null on bad input rather than crashing the
//     caller.
//   - prefix-byte validation: spending and viewing pubkeys must start
//     with 0x02 or 0x03 (compressed secp256k1 form). Anything else is
//     not a valid pubkey and decode returns null. Without this guard a
//     mangled registration could feed garbage into generateStealthAddress
//     and produce undefined behavior.
//   - atomic batch: ERC-20 transfer + Announcer.announce go in ONE
//     unifiedWriteBatch UserOp. If either fails, both revert. Without
//     atomicity, a transfer-then-failed-announce strands funds at a
//     stealth address the recipient never learns about (audit invariant).
//   - empty-bytes ("0x") sentinel for unregistered recipients -> null.
//     Length-0 blob ALSO -> null. The registry returns these for any
//     address that never called registerKeys.
//   - audit Top-28 #11: registry + announcer addresses read from
//     useChain().contracts (NOT a hard-coded constant) so a chain switch
//     picks up the right address without reload. ERC-6538/ERC-5564 are
//     canonical singletons today but reading from contracts is
//     belt-and-suspenders against any per-chain override.
//   - audit Top-28 #7 (Wave 2 A25 critical): post-confirm bookkeeping
//     fanout — wait for receipt to capture block_number, insertActivity
//     with user_to=address(0) (encrypted-recipient marker),
//     broadcastAction TWICE (balance_changed + activity_added),
//     invalidateBalanceQueries. Without these the sender's balance stays
//     stale 5-10s after the tx and the activity feed never reflects the
//     stealth-send. Wrapped in try/catch so post-confirm failure does NOT
//     mask a successful on-chain tx — the send already happened, we just
//     log and return success.
//   - amount must be > 0n: zero/negative throws "Stealth send amount
//     must be positive" up front; parseUnits has already rounded to 0n
//     if the user typed an amount below the smallest unit, so this is
//     the second layer of defense.
//   - wallet-not-connected and announcer-zero-address throw distinct
//     errors so the UI knows which gate the user tripped.

const useReadContractMock = vi.hoisted(() => vi.fn());
const usePublicClientMock = vi.hoisted(() => vi.fn());
const useUnifiedWriteMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const generateStealthAddressMock = vi.hoisted(() => vi.fn());
const encodeAnnouncementMetadataMock = vi.hoisted(() => vi.fn());
const formatMetaAddressMock = vi.hoisted(() => vi.fn());
const insertActivityMock = vi.hoisted(() => vi.fn());
const broadcastActionMock = vi.hoisted(() => vi.fn());
const invalidateBalanceQueriesMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useReadContract: useReadContractMock,
  usePublicClient: usePublicClientMock,
}));
vi.mock("@/lib/abis", () => ({
  ERC5564AnnouncerAbi: [],
  ERC6538RegistryAbi: [],
}));
vi.mock("@/lib/stealth", () => ({
  generateStealthAddress: generateStealthAddressMock,
  encodeAnnouncementMetadata: encodeAnnouncementMetadataMock,
  formatMetaAddress: formatMetaAddressMock,
}));
vi.mock("./useUnifiedWrite", () => ({ useUnifiedWrite: useUnifiedWriteMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/lib/supabase", () => ({ insertActivity: insertActivityMock }));
vi.mock("@/lib/cross-tab", () => ({ broadcastAction: broadcastActionMock }));
vi.mock("@/lib/query-invalidation", () => ({
  invalidateBalanceQueries: invalidateBalanceQueriesMock,
}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), debug: vi.fn() } }));

import { useStealthSend, useStealthMetaAddressLookup } from "./useStealthSend";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const REGISTRY = "0x2222222222222222222222222222222222222222" as const;
const ANNOUNCER = "0x3333333333333333333333333333333333333333" as const;
const STEALTH_ADDR = "0x4444444444444444444444444444444444444444" as const;
const EPHEMERAL_PUBKEY = ("0x02" + "ab".repeat(32)) as `0x${string}`;
const VIEW_TAG = 0xab;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const META_ADDR = "st:eth:0x0211223344556677889900aabbccddeeff00112233445566778899aabbccddeeff0322334455667788990011aabbccddeeff00112233445566778899aabbccddeeff" as const;

// Spending pubkey (33 bytes): 0x02 prefix + 32 bytes
const SPENDING_HEX = "02" + "11".repeat(32);
// Viewing pubkey (33 bytes): 0x03 prefix + 32 bytes
const VIEWING_HEX = "03" + "22".repeat(32);
const VALID_REGISTRY_BLOB = ("0x" + SPENDING_HEX + VIEWING_HEX) as `0x${string}`;

const unifiedWriteBatchMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

beforeEach(() => {
  useReadContractMock.mockReset();
  usePublicClientMock.mockReset();
  useUnifiedWriteMock.mockReset();
  useChainMock.mockReset();
  generateStealthAddressMock.mockReset();
  encodeAnnouncementMetadataMock.mockReset();
  formatMetaAddressMock.mockReset();
  insertActivityMock.mockReset();
  broadcastActionMock.mockReset();
  invalidateBalanceQueriesMock.mockReset();
  unifiedWriteBatchMock.mockReset();
  waitForTransactionReceiptMock.mockReset();

  useChainMock.mockReturnValue({
    activeChainId: 11155111,
    contracts: { ERC6538Registry: REGISTRY, ERC5564Announcer: ANNOUNCER },
  });
  useReadContractMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetched: false,
  });
  usePublicClientMock.mockReturnValue({
    waitForTransactionReceipt: waitForTransactionReceiptMock,
  });
  useUnifiedWriteMock.mockReturnValue({
    unifiedWriteBatch: unifiedWriteBatchMock,
    senderAddress: ME,
  });
  generateStealthAddressMock.mockReturnValue({
    stealthAddress: STEALTH_ADDR,
    ephemeralPublicKey: EPHEMERAL_PUBKEY,
    viewTag: VIEW_TAG,
  });
  encodeAnnouncementMetadataMock.mockReturnValue("0xmetadata");
  formatMetaAddressMock.mockReturnValue(META_ADDR);
  insertActivityMock.mockResolvedValue(undefined);
  unifiedWriteBatchMock.mockResolvedValue("0xtxhash" as `0x${string}`);
  waitForTransactionReceiptMock.mockResolvedValue({ blockNumber: 12345n });
});

// ───────────────────────────────────────────────────────────
//  useStealthMetaAddressLookup (registry blob decoding)
// ───────────────────────────────────────────────────────────

describe("useStealthMetaAddressLookup — registry read (§15.x)", () => {
  it("no recipient -> enabled=false, no read, metaAddress=null", () => {
    const { result } = renderHook(() => useStealthMetaAddressLookup(null));
    // useReadContract is always called but query.enabled gates the actual fetch
    const call = useReadContractMock.mock.calls[0][0];
    expect(call.query.enabled).toBe(false);
    expect(result.current.metaAddress).toBeNull();
  });

  it("recipient + registry both set -> enabled=true, args=[recipient, schemeId=1]", () => {
    renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    const call = useReadContractMock.mock.calls[0][0];
    expect(call.query.enabled).toBe(true);
    expect(call.args).toEqual([RECIPIENT, 1n]);
    expect(call.address).toBe(REGISTRY);
    expect(call.functionName).toBe("stealthMetaAddressOf");
  });

  it("registry === zero-addr -> enabled=false (chain has no deployment)", () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ERC6538Registry: ZERO_ADDR, ERC5564Announcer: ANNOUNCER },
    });
    renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    const call = useReadContractMock.mock.calls[0][0];
    expect(call.query.enabled).toBe(false);
  });

  it("empty bytes (0x) -> metaAddress=null (unregistered recipient)", () => {
    useReadContractMock.mockReturnValue({
      data: "0x",
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
  });

  it("undefined data -> metaAddress=null", () => {
    useReadContractMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("wrong length blob -> metaAddress=null (defensive length check)", () => {
    // 64 hex chars + 0x = 66 chars, expected 134
    useReadContractMock.mockReturnValue({
      data: "0x" + "1".repeat(64),
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
  });

  it("invalid spending pubkey prefix (not 0x02/0x03) -> null", () => {
    const badSpending = "ff" + "11".repeat(32);
    useReadContractMock.mockReturnValue({
      data: "0x" + badSpending + VIEWING_HEX,
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
  });

  it("invalid viewing pubkey prefix -> null", () => {
    const badViewing = "ff" + "22".repeat(32);
    useReadContractMock.mockReturnValue({
      data: "0x" + SPENDING_HEX + badViewing,
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
  });

  it("valid blob with both 0x02 prefixes -> calls formatMetaAddress with extracted pubkeys", () => {
    const sp = "02" + "11".repeat(32);
    const vp = "02" + "22".repeat(32);
    useReadContractMock.mockReturnValue({
      data: "0x" + sp + vp,
      isLoading: false,
      isFetched: true,
    });
    renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(formatMetaAddressMock).toHaveBeenCalledWith({
      spendingPubKey: "0x" + sp,
      viewingPubKey: "0x" + vp,
    });
  });

  it("valid blob -> metaAddress is the formatted string", () => {
    useReadContractMock.mockReturnValue({
      data: VALID_REGISTRY_BLOB,
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBe(META_ADDR);
  });

  it("formatMetaAddress throws -> caught + returns null (defensive)", () => {
    formatMetaAddressMock.mockImplementation(() => {
      throw new Error("bad pubkey");
    });
    useReadContractMock.mockReturnValue({
      data: VALID_REGISTRY_BLOB,
      isLoading: false,
      isFetched: true,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.metaAddress).toBeNull();
  });

  it("returns registryAddress from useChain (audit #11)", () => {
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.registryAddress).toBe(REGISTRY);
  });

  it("isLoading + isFetched passed through from useReadContract", () => {
    useReadContractMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isFetched).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  useStealthSend — guard rails
// ───────────────────────────────────────────────────────────

describe("useStealthSend — guard rails (§15.x)", () => {
  it("no senderAddress -> throws 'Wallet not connected'", async () => {
    useUnifiedWriteMock.mockReturnValue({
      unifiedWriteBatch: unifiedWriteBatchMock,
      senderAddress: null,
    });
    const { result } = renderHook(() => useStealthSend());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendStealthPayment({
          token: TOKEN,
          amount: 100n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("Wallet not connected");
    expect(unifiedWriteBatchMock).toHaveBeenCalledTimes(0);
  });

  it("announcer === zero-addr -> throws 'ERC-5564 Announcer not configured for this chain'", async () => {
    useChainMock.mockReturnValue({
      activeChainId: 11155111,
      contracts: { ERC6538Registry: REGISTRY, ERC5564Announcer: ZERO_ADDR },
    });
    const { result } = renderHook(() => useStealthSend());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendStealthPayment({
          token: TOKEN,
          amount: 100n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toContain("Announcer not configured");
    expect(unifiedWriteBatchMock).toHaveBeenCalledTimes(0);
  });

  it("amount === 0n -> throws 'Stealth send amount must be positive'", async () => {
    const { result } = renderHook(() => useStealthSend());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendStealthPayment({
          token: TOKEN,
          amount: 0n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("Stealth send amount must be positive");
    expect(unifiedWriteBatchMock).toHaveBeenCalledTimes(0);
  });

  it("amount < 0n (defensive) -> throws 'must be positive'", async () => {
    const { result } = renderHook(() => useStealthSend());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendStealthPayment({
          token: TOKEN,
          amount: -1n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("Stealth send amount must be positive");
  });
});

// ───────────────────────────────────────────────────────────
//  useStealthSend — happy path + atomicity
// ───────────────────────────────────────────────────────────

describe("useStealthSend — atomic batch (§15.x)", () => {
  it("generates a fresh stealth address from the meta-address", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(generateStealthAddressMock).toHaveBeenCalledTimes(1);
    expect(generateStealthAddressMock).toHaveBeenCalledWith({
      metaAddress: META_ADDR,
    });
  });

  it("encodes metadata with viewTag + token + amount", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(encodeAnnouncementMetadataMock).toHaveBeenCalledWith({
      viewTag: VIEW_TAG,
      token: TOKEN,
      amount: 100n,
    });
  });

  it("submits exactly ONE batched UserOp containing transfer + announce", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(unifiedWriteBatchMock).toHaveBeenCalledTimes(1);
    const calls = unifiedWriteBatchMock.mock.calls[0][0] as Array<{
      address: string;
      functionName: string;
      args: unknown[];
    }>;
    expect(calls).toHaveLength(2);
    // First call: transfer
    expect(calls[0].address).toBe(TOKEN);
    expect(calls[0].functionName).toBe("transfer");
    expect(calls[0].args).toEqual([STEALTH_ADDR, 100n]);
    // Second call: announce
    expect(calls[1].address).toBe(ANNOUNCER);
    expect(calls[1].functionName).toBe("announce");
    expect(calls[1].args).toEqual([1n, STEALTH_ADDR, EPHEMERAL_PUBKEY, "0xmetadata"]);
  });

  it("returns { txHash, stealthAddress, ephemeralPublicKey, viewTag }", async () => {
    unifiedWriteBatchMock.mockResolvedValue("0xresult" as `0x${string}`);
    const { result } = renderHook(() => useStealthSend());
    let r: Awaited<ReturnType<typeof result.current.sendStealthPayment>>;
    await act(async () => {
      r = await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(r!.txHash).toBe("0xresult");
    expect(r!.stealthAddress).toBe(STEALTH_ADDR);
    expect(r!.ephemeralPublicKey).toBe(EPHEMERAL_PUBKEY);
    expect(r!.viewTag).toBe(VIEW_TAG);
  });

  it("passes title + subtitle to unifiedWriteBatch for UI progress", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    const opts = unifiedWriteBatchMock.mock.calls[0][1];
    expect(opts.title).toBe("Sending stealth payment");
    expect(opts.subtitle).toContain("Transferring");
    expect(opts.subtitle).toContain("announcement");
  });

  it("unifiedWriteBatch rejection propagates (no post-confirm bookkeeping fires)", async () => {
    unifiedWriteBatchMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useStealthSend());
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.sendStealthPayment({
          token: TOKEN,
          amount: 100n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect((thrown as Error).message).toBe("user rejected");
    expect(insertActivityMock).toHaveBeenCalledTimes(0);
    expect(broadcastActionMock).toHaveBeenCalledTimes(0);
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  useStealthSend — post-confirm bookkeeping (audit #7)
// ───────────────────────────────────────────────────────────

describe("useStealthSend — audit Top-28 #7 post-confirm bookkeeping (§15.x)", () => {
  it("waits for receipt + captures blockNumber for activity row", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({ blockNumber: 9876n });
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(waitForTransactionReceiptMock).toHaveBeenCalledWith({
      hash: "0xtxhash",
      confirmations: 1,
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.block_number).toBe(9876);
  });

  it("activity row has user_to=address(0) (encrypted-recipient marker)", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.user_to).toBe("0x0000000000000000000000000000000000000000");
  });

  it("activity row has user_from=lowercased senderAddress + tx_hash + token + chain", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    const row = insertActivityMock.mock.calls[0][0];
    expect(row.user_from).toBe(ME.toLowerCase());
    expect(row.tx_hash).toBe("0xtxhash");
    expect(row.token_address).toBe(TOKEN);
    expect(row.chain_id).toBe(11155111);
    expect(row.activity_type).toBe("stealth_sent");
    expect(row.contract_address).toBe(STEALTH_ADDR);
  });

  it("broadcastAction fires TWICE: balance_changed + activity_added", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(broadcastActionMock).toHaveBeenCalledWith("balance_changed");
    expect(broadcastActionMock).toHaveBeenCalledWith("activity_added");
  });

  it("invalidateBalanceQueries fires on success", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(invalidateBalanceQueriesMock).toHaveBeenCalledTimes(1);
  });

  it("receipt poll failure -> activity row still written with blockNumber=0 (defensive)", async () => {
    waitForTransactionReceiptMock.mockRejectedValue(new Error("rpc timeout"));
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(insertActivityMock).toHaveBeenCalledTimes(1);
    expect(insertActivityMock.mock.calls[0][0].block_number).toBe(0);
  });

  it("no publicClient -> activity row still written with blockNumber=0", async () => {
    usePublicClientMock.mockReturnValue(null);
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(insertActivityMock.mock.calls[0][0].block_number).toBe(0);
    expect(waitForTransactionReceiptMock).toHaveBeenCalledTimes(0);
  });

  it("insertActivity rejection -> tx still returns success (audit invariant: bookkeeping must NOT mask successful tx)", async () => {
    insertActivityMock.mockRejectedValue(new Error("supabase down"));
    const { result } = renderHook(() => useStealthSend());
    let r: Awaited<ReturnType<typeof result.current.sendStealthPayment>> | null = null;
    let thrown: unknown = null;
    await act(async () => {
      try {
        r = await result.current.sendStealthPayment({
          token: TOKEN,
          amount: 100n,
          metaAddress: META_ADDR,
        });
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBeNull();
    expect(r!.txHash).toBe("0xtxhash");
  });

  it("receipt blockNumber=undefined -> blockNumber=0 fallback (not NaN)", async () => {
    waitForTransactionReceiptMock.mockResolvedValue({ blockNumber: undefined });
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    expect(insertActivityMock.mock.calls[0][0].block_number).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────
//  Audit #11: chain switch picks up new addresses
// ───────────────────────────────────────────────────────────

describe("useStealthSend — audit #11 chain-aware contracts (§15.x)", () => {
  it("announcer read from useChain().contracts (NOT a hardcoded constant)", async () => {
    const altAnnouncer = "0x9999999999999999999999999999999999999999" as `0x${string}`;
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      contracts: { ERC6538Registry: REGISTRY, ERC5564Announcer: altAnnouncer },
    });
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    const calls = unifiedWriteBatchMock.mock.calls[0][0];
    expect(calls[1].address).toBe(altAnnouncer);
    // chain_id in activity row also updated
    expect(insertActivityMock.mock.calls[0][0].chain_id).toBe(84532);
  });

  it("registry read from useChain().contracts (lookup hook)", () => {
    const altRegistry = "0x8888888888888888888888888888888888888888" as `0x${string}`;
    useChainMock.mockReturnValue({
      activeChainId: 84532,
      contracts: { ERC6538Registry: altRegistry, ERC5564Announcer: ANNOUNCER },
    });
    const { result } = renderHook(() => useStealthMetaAddressLookup(RECIPIENT));
    const call = useReadContractMock.mock.calls[0][0];
    expect(call.address).toBe(altRegistry);
    expect(result.current.registryAddress).toBe(altRegistry);
  });
});

// ───────────────────────────────────────────────────────────
//  Determinism: stealth address fresh per send
// ───────────────────────────────────────────────────────────

describe("useStealthSend — fresh ephemeral key per call (§15.x)", () => {
  it("generateStealthAddress called once per sendStealthPayment", async () => {
    const { result } = renderHook(() => useStealthSend());
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    await act(async () => {
      await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 50n,
        metaAddress: META_ADDR,
      });
    });
    expect(generateStealthAddressMock).toHaveBeenCalledTimes(2);
  });

  it("each call produces a fresh tx via unifiedWriteBatch (no caching)", async () => {
    unifiedWriteBatchMock
      .mockResolvedValueOnce("0xtx1" as `0x${string}`)
      .mockResolvedValueOnce("0xtx2" as `0x${string}`);
    const { result } = renderHook(() => useStealthSend());
    let r1!: Awaited<ReturnType<typeof result.current.sendStealthPayment>>;
    let r2!: Awaited<ReturnType<typeof result.current.sendStealthPayment>>;
    await act(async () => {
      r1 = await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 100n,
        metaAddress: META_ADDR,
      });
    });
    await act(async () => {
      r2 = await result.current.sendStealthPayment({
        token: TOKEN,
        amount: 50n,
        metaAddress: META_ADDR,
      });
    });
    expect(r1.txHash).toBe("0xtx1");
    expect(r2.txHash).toBe("0xtx2");
    expect(unifiedWriteBatchMock).toHaveBeenCalledTimes(2);
  });
});
