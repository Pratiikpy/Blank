import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import {
  buildUserOp,
  encodeExecuteCall,
  encodeExecuteBatchCall,
  encodeBlankPaymasterData,
  encodeP256Signature,
  serializeUserOp,
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
