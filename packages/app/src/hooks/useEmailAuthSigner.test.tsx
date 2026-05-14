import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// §15.x test for useEmailAuthSigner. The signing-passthrough hook called
// out in CLAUDE.md as the load-bearing surface that handles BOTH the EOA
// path and the passkey-AA path transparently for callers.
//
// CRITICAL pins:
//   - Two distinct signature shapes per path:
//       EOA: wagmi's signMessage returns a 65-byte (r, s, v) ECDSA sig
//         over the EIP-191 prefixed hash. Server verifies via ecrecover.
//       Passkey-AA: BlankAccount.isValidSignature decodes sig as
//         `abi.encode(uint256 r, uint256 s)` — 64 bytes, NO v byte — and
//         runs P256.verify(hash, r, s, ownerX, ownerY). We hash the
//         message ourselves (matching viem's hashMessage on the server),
//         prompt for the passphrase, sign via signHash, and abi-encode
//         (r, s) as a 64-byte blob.
//   - canSign 4-state matrix:
//       (no effectiveAddress) -> false (nothing to sign with)
//       (effectiveAddress + smartAccount.ready) -> true (passkey path)
//       (effectiveAddress + wagmiAccount.address) -> true (EOA path)
//       (effectiveAddress + neither) -> false (degenerate stale state)
//   - Passkey path requires passphrase: cancel (request returns null) ->
//     signEmailAuth returns null WITHOUT calling signHash. Without this
//     guard, an empty/null passphrase would crash the AES-GCM decrypt
//     inside signHash and surface as a confusing decode error.
//   - signedAt PASSES THROUGH the caller's value, not Date.now(). The
//     caller embeds signedAt into the message bytes via build helpers in
//     lib/email-client; the returned signedAt MUST match those bytes for
//     the server to verify. A regression that re-stamped signedAt here
//     would invalidate every signature.
//   - Smart-account discrimination uses BOTH conditions:
//     status === "ready" AND account !== null. Either alone is
//     insufficient (status could be "ready" with account null during
//     binding, etc).
//   - encodeAbiParameters output is the 64-byte (r, s) packed sig. Pin
//     the format: 0x + 128 hex chars (32 bytes r + 32 bytes s).

const useAccountMock = vi.hoisted(() => vi.fn());
const signMessageAsyncMock = vi.hoisted(() => vi.fn());
const useSignMessageMock = vi.hoisted(() => vi.fn());
const useSmartAccountMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const usePassphrasePromptMock = vi.hoisted(() => vi.fn());
const signHashMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({
  useAccount: useAccountMock,
  useSignMessage: useSignMessageMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("./useSmartAccount", () => ({ useSmartAccount: useSmartAccountMock }));
vi.mock("@/components/PassphrasePrompt", () => ({
  usePassphrasePrompt: usePassphrasePromptMock,
}));
vi.mock("@/lib/passkey", () => ({ signHash: signHashMock }));

import { useEmailAuthSigner } from "./useEmailAuthSigner";

const EOA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const AA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const CHAIN_ID = 11155111;

const passphraseRequestMock = vi.fn();

function setEffective(addr: string | null) {
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: addr });
}

function setSmartAccount(over: {
  status?: "idle" | "ready" | "loading" | "no-passkey";
  account?: { address: string } | null;
} = {}) {
  useSmartAccountMock.mockReturnValue({
    status: over.status ?? "idle",
    account: over.account ?? null,
  });
}

function setWagmiAccount(addr: string | null) {
  useAccountMock.mockReturnValue({ address: addr });
}

beforeEach(() => {
  useAccountMock.mockReset();
  signMessageAsyncMock.mockReset();
  useSignMessageMock.mockReset();
  useSmartAccountMock.mockReset();
  useChainMock.mockReset();
  useEffectiveAddressMock.mockReset();
  usePassphrasePromptMock.mockReset();
  signHashMock.mockReset();
  passphraseRequestMock.mockReset();

  useChainMock.mockReturnValue({ activeChainId: CHAIN_ID });
  useSignMessageMock.mockReturnValue({ signMessageAsync: signMessageAsyncMock });
  usePassphrasePromptMock.mockReturnValue({ request: passphraseRequestMock });
  setEffective(EOA);
  setWagmiAccount(EOA);
  setSmartAccount();
});

// ----- canSign 4-state matrix ----- //

describe("useEmailAuthSigner — canSign matrix (§15.x)", () => {
  it("no effectiveAddress -> canSign=false (nothing to sign with)", () => {
    setEffective(null);
    setWagmiAccount(null);
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(false);
  });

  it("effectiveAddress + smartAccount.ready -> canSign=true (passkey path)", () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(true);
  });

  it("effectiveAddress + wagmiAccount.address -> canSign=true (EOA path)", () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(true);
  });

  it("effectiveAddress + neither wagmi nor smart account -> canSign=false (degenerate)", () => {
    setEffective(EOA);
    setWagmiAccount(null);
    setSmartAccount();
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(false);
  });

  it("smartAccount.status='ready' BUT account=null -> NOT a smart account (defensive)", () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount({ status: "ready", account: null });
    const { result } = renderHook(() => useEmailAuthSigner());
    // Falls through to EOA-canSign, still true because wagmiAccount.address set
    expect(result.current.canSign).toBe(true);
    // But signEmailAuth should hit the EOA branch (not call signHash)
  });

  it("smartAccount.status='loading' + account set -> NOT yet a smart account", () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "loading", account: { address: AA } });
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(false);
  });
});

// ----- signEmailAuth: no address ----- //

describe("useEmailAuthSigner — signEmailAuth no-address guard (§15.x)", () => {
  it("no effectiveAddress -> returns null without prompting or signing", async () => {
    setEffective(null);
    setWagmiAccount(null);
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("any message", 1234),
    );
    expect(sig).toBeNull();
    expect(passphraseRequestMock).toHaveBeenCalledTimes(0);
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);
    expect(signHashMock).toHaveBeenCalledTimes(0);
  });
});

// ----- EOA path ----- //

describe("useEmailAuthSigner — EOA path (§15.x)", () => {
  it("happy path: signMessageAsync called with the message + returns 65-byte sig + signedAt passthrough", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    const fakeSig = ("0x" + "11".repeat(65)) as `0x${string}`;
    signMessageAsyncMock.mockResolvedValue(fakeSig);
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("hello world", 5_555),
    );
    expect(signMessageAsyncMock).toHaveBeenCalledWith({ message: "hello world" });
    expect(sig).toEqual({
      signature: fakeSig,
      signerAddress: EOA,
      signedAt: 5_555,
      signerChainId: CHAIN_ID,
    });
    expect(signHashMock).toHaveBeenCalledTimes(0);
    expect(passphraseRequestMock).toHaveBeenCalledTimes(0);
  });

  it("signedAt passes through verbatim (not re-stamped with Date.now)", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    signMessageAsyncMock.mockResolvedValue("0xabc");
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("msg", 1_700_000_000),
    );
    expect(sig?.signedAt).toBe(1_700_000_000);
  });

  it("signerChainId = useChain.activeChainId (NOT wagmiAccount.chainId)", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    signMessageAsyncMock.mockResolvedValue("0xabc");
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("msg", 99),
    );
    expect(sig?.signerChainId).toBe(84532);
  });

  it("EOA path: effectiveAddress set BUT wagmiAccount.address null -> returns null (no signMessage)", async () => {
    setEffective(EOA);
    setWagmiAccount(null);
    setSmartAccount();
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("msg", 1),
    );
    expect(sig).toBeNull();
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("signMessageAsync rejection propagates (caller handles)", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    signMessageAsyncMock.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useEmailAuthSigner());
    await expect(
      act(async () => result.current.signEmailAuth("msg", 1)),
    ).rejects.toThrow("user rejected");
  });
});

// ----- Passkey-AA path ----- //

describe("useEmailAuthSigner — passkey-AA path (§15.x)", () => {
  it("happy path: prompts for passphrase, hashes message, signHash, abi-encodes (r, s)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("secret-passphrase");
    // signHash returns r + s as 0x-hex bigints
    const r = ("0x" + "11".repeat(32)) as `0x${string}`;
    const s = ("0x" + "22".repeat(32)) as `0x${string}`;
    signHashMock.mockResolvedValue({ r, s });

    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("email-auth-message", 7_777),
    );

    // Prompt was shown with the expected title
    expect(passphraseRequestMock).toHaveBeenCalledTimes(1);
    const opts = passphraseRequestMock.mock.calls[0][0] as { title: string };
    expect(opts.title).toBe("Sign email request");

    // signHash called with (chainId, passphrase, eip191Hash)
    expect(signHashMock).toHaveBeenCalledTimes(1);
    const [chainArg, passArg, hashArg] = signHashMock.mock.calls[0];
    expect(chainArg).toBe(CHAIN_ID);
    expect(passArg).toBe("secret-passphrase");
    expect(hashArg).toMatch(/^0x[0-9a-f]{64}$/);

    // EOA signMessageAsync NOT called on this path
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);

    // Returned sig is 0x + 128 hex chars (64 bytes = abi.encode(uint256, uint256))
    expect(sig?.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(sig?.signerAddress).toBe(AA);
    expect(sig?.signerChainId).toBe(CHAIN_ID);
    expect(sig?.signedAt).toBe(7_777);
  });

  it("user cancels passphrase prompt -> returns null without calling signHash", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue(null); // user cancelled

    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () =>
      result.current.signEmailAuth("msg", 1),
    );

    expect(sig).toBeNull();
    expect(signHashMock).toHaveBeenCalledTimes(0);
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("eip191Hash is hashMessage(message) — same message -> same hash (deterministic)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    signHashMock.mockResolvedValue({
      r: "0x1",
      s: "0x2",
    });
    const { result } = renderHook(() => useEmailAuthSigner());
    await act(async () => result.current.signEmailAuth("same msg", 1));
    const hash1 = signHashMock.mock.calls[0][2];
    signHashMock.mockClear();
    await act(async () => result.current.signEmailAuth("same msg", 2));
    const hash2 = signHashMock.mock.calls[0][2];
    expect(hash1).toBe(hash2);
  });

  it("different messages -> different hashes (real EIP-191 hashing not a stub)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    signHashMock.mockResolvedValue({ r: "0x1", s: "0x2" });
    const { result } = renderHook(() => useEmailAuthSigner());
    await act(async () => result.current.signEmailAuth("message A", 1));
    const hashA = signHashMock.mock.calls[0][2];
    signHashMock.mockClear();
    await act(async () => result.current.signEmailAuth("message B", 1));
    const hashB = signHashMock.mock.calls[0][2];
    expect(hashA).not.toBe(hashB);
  });

  it("signHash rejection propagates (caller surfaces decrypt error)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("wrong-pass");
    signHashMock.mockRejectedValue(new Error("aes-gcm decrypt failed"));
    const { result } = renderHook(() => useEmailAuthSigner());
    await expect(
      act(async () => result.current.signEmailAuth("msg", 1)),
    ).rejects.toThrow("aes-gcm decrypt failed");
  });

  it("64-byte sig encodes r + s in big-endian uint256 layout (NOT 65-byte ECDSA)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    // r = 1, s = 2 — easy to spot in the encoded blob
    signHashMock.mockResolvedValue({
      r: "0x1",
      s: "0x2",
    });
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () => result.current.signEmailAuth("msg", 1));
    // Should be 0x + 64 hex chars for r + 64 hex chars for s = 128 hex chars
    expect(sig?.signature).toMatch(/^0x[0-9a-f]{128}$/);
    // Last hex char of r is "1", last of s is "2" — both at end of their 32-byte chunks
    const hexBody = sig!.signature.slice(2); // strip 0x
    const rHex = hexBody.slice(0, 64);
    const sHex = hexBody.slice(64, 128);
    expect(BigInt("0x" + rHex)).toBe(1n);
    expect(BigInt("0x" + sHex)).toBe(2n);
  });

  it("signedAt passes through verbatim on passkey path too", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    signHashMock.mockResolvedValue({ r: "0x1", s: "0x2" });
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () => result.current.signEmailAuth("msg", 1_700_000_000));
    expect(sig?.signedAt).toBe(1_700_000_000);
  });

  it("signerAddress on passkey path = effectiveAddress (the AA), NOT wagmi address", async () => {
    setEffective(AA);
    setWagmiAccount(EOA); // both connected — passkey should win because isSmartAccount=true
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    signHashMock.mockResolvedValue({ r: "0x1", s: "0x2" });
    const { result } = renderHook(() => useEmailAuthSigner());
    const sig = await act(async () => result.current.signEmailAuth("msg", 1));
    expect(sig?.signerAddress).toBe(AA);
    // Passkey path used — signMessageAsync NOT called even though wagmi is connected
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);
  });
});

// ----- Path-selection priority ----- //

describe("useEmailAuthSigner — path-selection priority (§15.x)", () => {
  it("passkey path WINS over EOA path when both are present (isSmartAccount=true short-circuits)", async () => {
    setEffective(AA);
    setWagmiAccount(EOA); // EOA also connected
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue("p");
    signHashMock.mockResolvedValue({ r: "0x1", s: "0x2" });
    const { result } = renderHook(() => useEmailAuthSigner());
    await act(async () => result.current.signEmailAuth("msg", 1));
    expect(signHashMock).toHaveBeenCalledTimes(1);
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(0);
  });

  it("EOA path runs when isSmartAccount=false even if smartAccount.account is non-null (status=loading)", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount({ status: "loading", account: { address: AA } });
    signMessageAsyncMock.mockResolvedValue("0xeoa-sig");
    const { result } = renderHook(() => useEmailAuthSigner());
    await act(async () => result.current.signEmailAuth("msg", 1));
    expect(signMessageAsyncMock).toHaveBeenCalledTimes(1);
    expect(signHashMock).toHaveBeenCalledTimes(0);
  });
});

// ----- canSign callability invariant ----- //

describe("useEmailAuthSigner — canSign callability invariant (§15.x)", () => {
  it("canSign=true on EOA path -> signEmailAuth produces a non-null result", async () => {
    setEffective(EOA);
    setWagmiAccount(EOA);
    setSmartAccount();
    signMessageAsyncMock.mockResolvedValue("0xabc");
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(true);
    const sig = await act(async () => result.current.signEmailAuth("msg", 1));
    expect(sig).not.toBeNull();
  });

  it("canSign=true on passkey path + cancel -> signEmailAuth returns null (callable but cancellable)", async () => {
    setEffective(AA);
    setWagmiAccount(null);
    setSmartAccount({ status: "ready", account: { address: AA } });
    passphraseRequestMock.mockResolvedValue(null);
    const { result } = renderHook(() => useEmailAuthSigner());
    expect(result.current.canSign).toBe(true);
    const sig = await act(async () => result.current.signEmailAuth("msg", 1));
    expect(sig).toBeNull();
  });
});
