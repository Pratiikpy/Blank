import { describe, it, expect, vi } from "vitest";
import {
  encodeP256AsErc1271Signature,
  checkSmartWalletAdapterAvailable,
  blankSmartWalletViemAdapter,
  type CofheSmartAccountClient,
} from "./smart-account-cofhe-bridge";
import type { Address, Chain, Hex, PublicClient } from "viem";

// §15.x lib test for the smart-account ↔ cofhe bridge pure helpers.
// encodeP256AsErc1271Signature is the byte-exact format the
// BlankAccount.isValidSignature contract decodes from on-chain;
// drift means every ERC-1271 + UserOp signature gets rejected
// post-decode with a generic "invalid signature" revert.

describe("encodeP256AsErc1271Signature", () => {
  it("returns a 64-byte blob (abi.encode(uint256, uint256) shape)", () => {
    const r = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
    const s = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
    const sig = encodeP256AsErc1271Signature(r, s);
    // 64 bytes = 128 hex chars + "0x" prefix
    expect(sig.length).toBe(2 + 128);
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("left-pads short r and s values to 32 bytes each", () => {
    // P-256 sigs are always 32 bytes per component, but defensive
    // padding handles upstream code that strips leading zeros.
    const sig = encodeP256AsErc1271Signature("0x1" as Hex, "0x2" as Hex);
    // r at offset 2..66 must be 31 zeros + "1"; s at 66..130 must be 31 zeros + "2".
    expect(sig.slice(2, 2 + 64)).toBe("1".padStart(64, "0"));
    expect(sig.slice(2 + 64, 2 + 128)).toBe("2".padStart(64, "0"));
  });

  it("preserves full 32-byte r and s without truncation", () => {
    const r = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;
    const s = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex;
    const sig = encodeP256AsErc1271Signature(r, s);
    expect(sig.slice(2, 2 + 64).toLowerCase()).toBe(r.slice(2).toLowerCase());
    expect(sig.slice(2 + 64, 2 + 128).toLowerCase()).toBe(s.slice(2).toLowerCase());
  });

  it("accepts r and s without 0x prefix", () => {
    const sig = encodeP256AsErc1271Signature("11" as Hex, "22" as Hex);
    expect(sig.slice(2, 2 + 64)).toBe("11".padStart(64, "0"));
    expect(sig.slice(2 + 64, 2 + 128)).toBe("22".padStart(64, "0"));
  });

  it("differs when r OR s changes (signature genuinely binds inputs)", () => {
    const a = encodeP256AsErc1271Signature("0x01" as Hex, "0x02" as Hex);
    const b = encodeP256AsErc1271Signature("0x01" as Hex, "0x03" as Hex);
    const c = encodeP256AsErc1271Signature("0x02" as Hex, "0x02" as Hex);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("checkSmartWalletAdapterAvailable", () => {
  it("returns true (module loaded, adapter callable)", () => {
    // The R5-D readiness check; if false, the cofhe-shim ↔
    // smart-account bridge is broken and we should refuse to
    // route a smart-account write through cofhe.
    expect(checkSmartWalletAdapterAvailable()).toBe(true);
  });
});

// §15.x extension: blankSmartWalletViemAdapter — the viem-shape
// wrapper that cofhe-sdk consumes via smartWalletViemAdapter. The
// adapter routes RPC reads through the given publicClient (no new
// transport) and routes every SIGNING call to the smart-account
// client (passkey-backed). A regression here means cofhe-sdk would
// either: (a) sign via the EOA (mismatching the ACL-bound smart
// account identity, leading to permit-rejection on every encrypted
// read), or (b) try to make raw RPC calls that bypass our wrapper.

function makeMockPublicClient(chainId = 11155111): PublicClient {
  return {
    chain: { id: chainId, name: "mock", network: "mock" } as unknown as Chain,
    request: vi.fn(async (..._args) => "0x"),
  } as unknown as PublicClient;
}

function makeMockSmartAccountClient(overrides: Partial<CofheSmartAccountClient> = {}): CofheSmartAccountClient {
  return {
    account: { address: "0xabc0000000000000000000000000000000000abc" as Address },
    sendTransaction: vi.fn(async () => "0xtxhash" as Hex),
    signTypedData: vi.fn(async () => "0xsig" as Hex),
    ...overrides,
  };
}

describe("blankSmartWalletViemAdapter", () => {
  it("returns the SAME publicClient reference (no new transport, just proxy through)", () => {
    const publicClient = makeMockPublicClient();
    const smart = makeMockSmartAccountClient();
    const out = blankSmartWalletViemAdapter(publicClient, smart);
    expect(out.publicClient).toBe(publicClient);
  });

  it("returned walletClient.sendTransaction routes to smartAccountClient.sendTransaction", async () => {
    const publicClient = makeMockPublicClient();
    const smart = makeMockSmartAccountClient();
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart);
    const tx = {
      to: "0xdef0000000000000000000000000000000000def" as Address,
      value: 100n,
      data: "0xabcd" as Hex,
    };
    const result = await (walletClient as unknown as {
      sendTransaction: (t: typeof tx) => Promise<Hex>;
    }).sendTransaction(tx);
    expect(smart.sendTransaction).toHaveBeenCalledWith(tx);
    expect(result).toBe("0xtxhash");
  });

  it("signTypedData 1-arg form preserves domain + types + message + explicit primaryType", async () => {
    const publicClient = makeMockPublicClient();
    const smart = makeMockSmartAccountClient();
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart);
    const arg = {
      domain: { name: "Test", chainId: 1 },
      types: { Permit: [{ name: "owner", type: "address" }] },
      primaryType: "Permit",
      message: { owner: "0xowner" },
    };
    await (walletClient as unknown as {
      signTypedData: (a: typeof arg) => Promise<Hex>;
    }).signTypedData(arg);
    expect(smart.signTypedData).toHaveBeenCalledWith({
      domain: arg.domain,
      types: arg.types,
      primaryType: "Permit",
      message: arg.message,
    });
  });

  it("signTypedData 1-arg form derives primaryType when not explicit (skips EIP712Domain)", async () => {
    const publicClient = makeMockPublicClient();
    const smart = makeMockSmartAccountClient();
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart);
    const arg = {
      domain: { name: "Test" },
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "subject", type: "string" }],
      },
      message: { subject: "hello" },
    };
    await (walletClient as unknown as {
      signTypedData: (a: typeof arg) => Promise<Hex>;
    }).signTypedData(arg);
    const call = (smart.signTypedData as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      primaryType: string;
    };
    // EIP712Domain is filtered out; Mail is the only remaining key.
    expect(call.primaryType).toBe("Mail");
  });

  it("signTypedData 3-arg legacy form forwards (domain, types, message) to smart-account client", async () => {
    const publicClient = makeMockPublicClient();
    const smart = makeMockSmartAccountClient();
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart);
    const domain = { name: "Test", chainId: 1 };
    const types = { Permit: [{ name: "owner", type: "address" }] };
    const message = { owner: "0xowner" };
    await (walletClient as unknown as {
      signTypedData: (
        d: typeof domain,
        t: typeof types,
        m: typeof message,
      ) => Promise<Hex>;
    }).signTypedData(domain, types, message);
    expect(smart.signTypedData).toHaveBeenCalledWith({
      domain,
      types,
      primaryType: "Permit",
      message,
    });
  });

  it("signMessage routes to smartAccountClient.signMessage when present", async () => {
    const publicClient = makeMockPublicClient();
    const signMessageMock = vi.fn(async () => "0xsigmsg" as Hex);
    const smart = makeMockSmartAccountClient({ signMessage: signMessageMock });
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart);
    const result = await (walletClient as unknown as {
      signMessage: (a: { message: string }) => Promise<Hex>;
    }).signMessage({ message: "hello" });
    expect(signMessageMock).toHaveBeenCalledWith({ message: "hello" });
    expect(result).toBe("0xsigmsg");
  });

  it("uses opts.chain when provided (overrides publicClient.chain)", () => {
    const publicClient = makeMockPublicClient(11155111);
    const smart = makeMockSmartAccountClient();
    const explicitChain = { id: 84532, name: "base-sepolia", network: "base-sepolia" } as unknown as Chain;
    const { walletClient } = blankSmartWalletViemAdapter(publicClient, smart, {
      chain: explicitChain,
    });
    // walletClient exposes chain via its internal viem state — `walletClient.chain`
    // is the truthy source of the override.
    expect((walletClient as unknown as { chain: { id: number } }).chain.id).toBe(84532);
  });
});
