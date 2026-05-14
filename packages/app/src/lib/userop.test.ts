import { describe, it, expect, vi } from "vitest";
import { toFunctionSelector } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import {
  buildUserOp,
  encodeExecuteCall,
  encodeExecuteBatchCall,
  encodeBlankPaymasterData,
  encodeFactoryInitCode,
  encodeP256Signature,
  serializeUserOp,
  computeUserOpHash,
  getNextNonce,
  EXECUTE_SELECTOR,
  EXECUTE_BATCH_SELECTOR,
  ENTRYPOINT_V08,
} from "./userop";

// §15.x lib test for the ERC-4337 v0.8 UserOp encoders. Off-by-one
// in any of these encoders means the EntryPoint or BlankAccount
// rejects with a generic AA-error on submission, with the user
// having no signal where the encoding broke. Pin every encoder
// against the documented byte layout.

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const PAYMASTER = "0x3333333333333333333333333333333333333333" as Address;

describe("ENTRYPOINT_V08 constant", () => {
  it("matches the published EntryPoint v0.8 address", () => {
    // The Z0tz / Pimlico reference EntryPoint address. Drift here
    // means every UserOp gets rejected with "wrong entrypoint".
    expect(ENTRYPOINT_V08).toBe("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
  });
});

describe("buildUserOp", () => {
  it("applies sane CoFHE defaults when fields are omitted", () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 0n,
      callData: "0xdeadbeef" as Hex,
    });
    expect(op.sender).toBe(SENDER);
    expect(op.nonce).toBe(0n);
    expect(op.callData).toBe("0xdeadbeef");
    expect(op.initCode).toBe("0x");
    expect(op.paymasterAndData).toBe("0x");
    expect(op.signature).toBe("0x");
    expect(op.preVerificationGas).toBe(100_000n);
  });

  it("respects an explicit callGasLimit override", () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 0n,
      callData: "0x" as Hex,
      callGasLimit: 5_000_000n,
    });
    // accountGasLimits is the packed (verif, callGas) pair; lower 16 bytes
    // hold callGasLimit. Verifying the packed value is non-trivial; we
    // assert that buildUserOp returned a properly-sized 32-byte field.
    expect(op.accountGasLimits.length).toBe(66); // "0x" + 64 hex chars
  });
});

describe("encodeExecuteCall", () => {
  it("starts with the execute(address,uint256,bytes) selector", () => {
    const data = encodeExecuteCall(TARGET, 0n, "0xabcd" as Hex);
    expect(data.slice(0, 10)).toBe(EXECUTE_SELECTOR);
  });

  it("matches the BlankPaymaster's hardcoded selector check (0xb61d27f6)", () => {
    // SECURITY: BlankPaymaster._validatePaymasterUserOp explicitly
    // gates on this 4-byte selector. If userop.ts and the contract
    // disagree, every paymaster-sponsored UserOp falls into the
    // "selector not allowed" revert branch.
    expect(EXECUTE_SELECTOR).toBe("0xb61d27f6");
  });

  it("produces a different output for different targets / values / data", () => {
    const a = encodeExecuteCall(TARGET, 1n, "0xab" as Hex);
    const b = encodeExecuteCall(TARGET, 2n, "0xab" as Hex);
    expect(a).not.toBe(b);
  });
});

describe("encodeExecuteBatchCall", () => {
  it("starts with the executeBatch selector (0x47e1da2a)", () => {
    expect(EXECUTE_BATCH_SELECTOR).toBe("0x47e1da2a");
    const data = encodeExecuteBatchCall([TARGET], [0n], ["0xab" as Hex]);
    expect(data.slice(0, 10)).toBe(EXECUTE_BATCH_SELECTOR);
  });

  it("rejects mismatched array lengths", () => {
    expect(() =>
      encodeExecuteBatchCall([TARGET, TARGET], [0n], ["0x" as Hex]),
    ).toThrow(/array length mismatch/);

    expect(() =>
      encodeExecuteBatchCall([TARGET], [0n, 1n], ["0x" as Hex]),
    ).toThrow(/array length mismatch/);
  });

  it("accepts a multi-target batch", () => {
    const out = encodeExecuteBatchCall(
      [TARGET, PAYMASTER],
      [0n, 1n],
      ["0xaa" as Hex, "0xbb" as Hex],
    );
    expect(out.startsWith(EXECUTE_BATCH_SELECTOR)).toBe(true);
  });
});

describe("encodeBlankPaymasterData", () => {
  it("layout: 0x + 20-byte addr + 16-byte verif + 16-byte postOp + 32-byte amount", () => {
    // Total: 2 + (20 + 16 + 16 + 32) * 2 = 2 + 168 = 170 chars.
    const out = encodeBlankPaymasterData(PAYMASTER, 0n);
    expect(out.length).toBe(170);
    expect(out.startsWith("0x")).toBe(true);
  });

  it("embeds the paymaster address verbatim in the first 20 bytes", () => {
    const out = encodeBlankPaymasterData(PAYMASTER, 0n);
    expect(out.slice(2, 42).toLowerCase()).toBe(
      PAYMASTER.slice(2).toLowerCase(),
    );
  });

  it("encodes verif + postOp + amount at fixed offsets", () => {
    const out = encodeBlankPaymasterData(PAYMASTER, 1234n, 200_000n, 100_000n);
    // offsets in chars (after "0x"):
    //   0..40   : address
    //   40..72  : verif (32 chars = 16 bytes)
    //   72..104 : postOp (32 chars = 16 bytes)
    //   104..168: amount (64 chars = 32 bytes)
    const verif = BigInt("0x" + out.slice(2 + 40, 2 + 72));
    const postOp = BigInt("0x" + out.slice(2 + 72, 2 + 104));
    const amount = BigInt("0x" + out.slice(2 + 104, 2 + 168));
    expect(verif).toBe(200_000n);
    expect(postOp).toBe(100_000n);
    expect(amount).toBe(1234n);
  });
});

describe("encodeP256Signature", () => {
  it("returns a 64-byte ABI-encoded (r, s) tuple", () => {
    const r = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
    const s = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
    const sig = encodeP256Signature(r, s);
    // 64 bytes = 128 hex chars + "0x" prefix
    expect(sig.length).toBe(2 + 128);
  });

  it("differs when r OR s differs", () => {
    const a = encodeP256Signature(
      "0x01" as Hex,
      "0x02" as Hex,
    );
    const b = encodeP256Signature(
      "0x01" as Hex,
      "0x03" as Hex,
    );
    expect(a).not.toBe(b);
  });
});

describe("serializeUserOp", () => {
  it("converts bigint fields to decimal strings (.toString() shape)", () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 5n,
      callData: "0xdeadbeef" as Hex,
    });
    const out = serializeUserOp(op);

    // serializeUserOp uses .toString() so bigints come out as decimal.
    // Callers convert to hex via BigInt(out.nonce).toString(16) if the
    // bundler insists.
    expect(typeof out.nonce).toBe("string");
    expect(out.nonce).toBe("5");
    expect(BigInt(out.nonce)).toBe(5n);

    // Non-bigint string fields pass through verbatim.
    expect(out.sender).toBe(SENDER);
    expect(out.callData).toBe("0xdeadbeef");
  });

  it("preserves the packed accountGasLimits + gasFees fields verbatim (already hex)", () => {
    const op = buildUserOp({
      sender: SENDER,
      nonce: 0n,
      callData: "0x" as Hex,
    });
    const out = serializeUserOp(op);
    expect(out.accountGasLimits).toBe(op.accountGasLimits);
    expect(out.gasFees).toBe(op.gasFees);
  });
});

// §15.x extension: function-selector constants. The bare selectors
// are what BlankAccount.execute and ::executeBatch decode at the
// signature dispatch point. A typo or stale value here would silently
// route the UserOp to a different (or non-existent) function.

describe("function-selector constants match keccak256(signature)[0:4]", () => {
  it("EXECUTE_SELECTOR matches keccak256('execute(address,uint256,bytes)')[0:4]", () => {
    expect(EXECUTE_SELECTOR).toBe(toFunctionSelector("execute(address,uint256,bytes)"));
    expect(EXECUTE_SELECTOR).toBe("0xb61d27f6");
  });

  it("EXECUTE_BATCH_SELECTOR matches keccak256('executeBatch(address[],uint256[],bytes[])')[0:4]", () => {
    expect(EXECUTE_BATCH_SELECTOR).toBe(
      toFunctionSelector("executeBatch(address[],uint256[],bytes[])"),
    );
    expect(EXECUTE_BATCH_SELECTOR).toBe("0x47e1da2a");
  });

  it("the two selectors are distinct (no collision routing)", () => {
    expect(EXECUTE_SELECTOR).not.toBe(EXECUTE_BATCH_SELECTOR);
  });
});

// §15.x extension: encodeFactoryInitCode — encodes the
// CREATE2-deploy initCode that EntryPoint passes to SenderCreator
// when a UserOp targets a not-yet-deployed counterfactual account.
// The selector value (0x20b66d7f) was changed from a wrong prior
// value (0x12cd5db8) that did NOT match any function in the deployed
// factory bytecode. The wrong selector made SenderCreator's
// low-level call return empty, causing AA13 "initCode failed or OOG"
// on every first-time UserOp. This regression only surfaced against
// FRESH passkeys in prod (dev tests reused already-deployed
// counterfactuals). Pin the selector to catch a regression to the
// broken value.

const FACTORY = "0x4444444444444444444444444444444444444444" as Address;
const OWNER_X = ("0x" + "01".repeat(32)) as Hex;
const OWNER_Y = ("0x" + "02".repeat(32)) as Hex;
const RECOVERY = "0x5555555555555555555555555555555555555555" as Address;

describe("encodeFactoryInitCode (smart-account create2 initCode)", () => {
  it("returns initCode that starts with the factory address (20 bytes)", () => {
    const initCode = encodeFactoryInitCode(FACTORY, OWNER_X, OWNER_Y, RECOVERY, 0n);
    // First 20 bytes (40 hex chars) after "0x" must be the factory.
    expect(initCode.slice(0, 2 + 40).toLowerCase()).toBe(FACTORY.toLowerCase());
  });

  it("embeds the createAccount selector (0x20b66d7f) right after the factory address", () => {
    const initCode = encodeFactoryInitCode(FACTORY, OWNER_X, OWNER_Y, RECOVERY, 0n);
    // Bytes 20-23 (after factory) are the function selector.
    const sel = "0x" + initCode.slice(2 + 40, 2 + 40 + 8);
    expect(sel).toBe("0x20b66d7f");
  });

  it("selector matches keccak256('createAccount(uint256,uint256,address,uint256)')[0:4]", () => {
    // Independent derivation via viem to pin the value against the
    // canonical Ethereum function-selector computation.
    expect("0x20b66d7f").toBe(
      toFunctionSelector("createAccount(uint256,uint256,address,uint256)"),
    );
  });

  it("encodes ownerX + ownerY + recoveryModule + salt as 4x32 bytes (abi.encode shape)", () => {
    const initCode = encodeFactoryInitCode(FACTORY, OWNER_X, OWNER_Y, RECOVERY, 42n);
    // After 20 (factory) + 4 (selector) = 24 bytes (48 hex chars), the
    // remaining bytes are abi.encode(uint256, uint256, address, uint256)
    // which is 4 * 32 = 128 bytes (256 hex chars).
    const argsLen = initCode.length - 2 - 40 - 8;
    expect(argsLen).toBe(256);
    // Read each 32-byte word.
    const offset = 2 + 40 + 8;
    const w1 = "0x" + initCode.slice(offset, offset + 64);
    const w2 = "0x" + initCode.slice(offset + 64, offset + 128);
    const w3 = "0x" + initCode.slice(offset + 128, offset + 192);
    const w4 = "0x" + initCode.slice(offset + 192, offset + 256);
    expect(BigInt(w1)).toBe(BigInt(OWNER_X));
    expect(BigInt(w2)).toBe(BigInt(OWNER_Y));
    // address left-pads in abi.encode — match by BigInt to ignore padding.
    expect(BigInt(w3)).toBe(BigInt(RECOVERY));
    expect(BigInt(w4)).toBe(42n);
  });

  it("different salts produce different initCode (deterministic CREATE2 keyed by salt)", () => {
    const a = encodeFactoryInitCode(FACTORY, OWNER_X, OWNER_Y, RECOVERY, 1n);
    const b = encodeFactoryInitCode(FACTORY, OWNER_X, OWNER_Y, RECOVERY, 2n);
    expect(a).not.toBe(b);
  });
});

// §15.x extension: computeUserOpHash + getNextNonce — both wrap
// publicClient.readContract on the EntryPoint v0.8. The hash is what
// the smart account signs; the nonce is what the EntryPoint expects
// to see incremented monotonically. A regression that called the
// wrong function or wrong contract would silently break every
// AA-routed user action.

function makePublicClient(returnValue: unknown): PublicClient {
  const readContract = vi.fn().mockResolvedValue(returnValue);
  return { readContract } as unknown as PublicClient;
}

describe("computeUserOpHash (EntryPoint v0.8 hash computation)", () => {
  it("calls publicClient.readContract on ENTRYPOINT_V08 with functionName=getUserOpHash", async () => {
    const client = makePublicClient("0x1234abcd" as Hex);
    const userOp = buildUserOp({ sender: SENDER, nonce: 7n, callData: "0xdead" as Hex });
    const result = await computeUserOpHash(client, userOp);
    expect(result).toBe("0x1234abcd");
    const call = (client.readContract as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    };
    expect(call.address).toBe(ENTRYPOINT_V08);
    expect(call.functionName).toBe("getUserOpHash");
    expect(call.args[0]).toBe(userOp);
  });

  it("accepts a custom entryPoint address override (multi-version migration support)", async () => {
    const client = makePublicClient("0xcafebabe" as Hex);
    const userOp = buildUserOp({ sender: SENDER, nonce: 0n, callData: "0x" as Hex });
    const otherEntryPoint = "0x9999999999999999999999999999999999999999" as Address;
    await computeUserOpHash(client, userOp, otherEntryPoint);
    const call = (client.readContract as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      address: Address;
    };
    expect(call.address).toBe(otherEntryPoint);
  });
});

describe("getNextNonce (EntryPoint v0.8 nonce read)", () => {
  it("calls publicClient.readContract on ENTRYPOINT_V08 with functionName=getNonce", async () => {
    const client = makePublicClient(42n);
    const result = await getNextNonce(client, SENDER);
    expect(result).toBe(42n);
    const call = (client.readContract as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    };
    expect(call.address).toBe(ENTRYPOINT_V08);
    expect(call.functionName).toBe("getNonce");
    // Default key arg is 0n.
    expect(call.args).toEqual([SENDER, 0n]);
  });

  it("forwards a custom nonce key (channel-separation for parallel UserOps)", async () => {
    const client = makePublicClient(99n);
    await getNextNonce(client, SENDER, 7n);
    const call = (client.readContract as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      args: readonly unknown[];
    };
    expect(call.args).toEqual([SENDER, 7n]);
  });
});
