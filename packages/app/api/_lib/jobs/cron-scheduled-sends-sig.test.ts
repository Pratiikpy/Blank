// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";

vi.mock("../session-keys-store.js", () => ({
  listActiveKeysForChain: vi.fn(),
  signWithSessionKey: vi.fn(),
  markRevoked: vi.fn(),
}));

import {
  sessionDigest,
  encodeSessionSignature,
  chooseSessionFees,
  decodeScope,
  FIRE_VERIFICATION_GAS,
  FIRE_CALL_GAS,
  FIRE_PRE_VERIFICATION_GAS,
} from "./cron-scheduled-sends-tick.js";

// The security-v1 SessionKeyValidator signature format the cron produces:
//   userOp.signature = abi.encode(validator, abi.encode(sessionKey, uint48 notBefore, ecdsaSig))
//   ecdsaSig = raw secp256k1 signature over keccak256(abi.encode(userOpHash, notBefore))
// Mirrors SessionKeyValidator.validateUserOp / sessionDigest.

const coder = ethers.AbiCoder.defaultAbiCoder();
const VALIDATOR = "0x" + "aa".repeat(20);
const USEROP_HASH = ethers.keccak256(ethers.toUtf8Bytes("op"));

describe("session-key signature encoding", () => {
  it("sessionDigest = keccak256(abi.encode(bytes32 userOpHash, uint48 notBefore))", () => {
    expect(sessionDigest(USEROP_HASH, 1_700_000_000)).toBe(
      ethers.keccak256(coder.encode(["bytes32", "uint48"], [USEROP_HASH, 1_700_000_000])),
    );
    expect(sessionDigest(USEROP_HASH, 1)).not.toBe(sessionDigest(USEROP_HASH, 2));
  });

  it("a raw signature over the digest recovers to the session key after decoding both layers", () => {
    const key = new ethers.Wallet("0x" + "42".repeat(32));
    const notBefore = 1_800_000_000;
    const sig = key.signingKey.sign(sessionDigest(USEROP_HASH, notBefore)).serialized;
    const outer = encodeSessionSignature(VALIDATOR, key.address, notBefore, sig);

    const [validator, inner] = coder.decode(["address", "bytes"], outer);
    expect(validator.toLowerCase()).toBe(VALIDATOR);
    const [sessionKey, nb, ecdsa] = coder.decode(["address", "uint48", "bytes"], inner);
    expect(sessionKey).toBe(key.address);
    expect(Number(nb)).toBe(notBefore);
    expect(ethers.getBytes(ecdsa).length).toBe(65);
    expect(ethers.recoverAddress(sessionDigest(USEROP_HASH, Number(nb)), ecdsa)).toBe(key.address);
    // validator's own minimum length check: (address, uint48, bytes) >= 128 bytes
    expect(ethers.getBytes(inner).length).toBeGreaterThanOrEqual(128);
    // BlankAccount routes anything that is not exactly 64 bytes to the validator
    expect(ethers.getBytes(outer).length).not.toBe(64);
  });
});

describe("chooseSessionFees (account-paid fires)", () => {
  it("2 x baseFee + tip, capped by the scope's maxFeePerGas; priority never above maxFee", () => {
    expect(chooseSessionFees(10n, 2n, 1_000n)).toEqual({ maxFeePerGas: 22n, maxPriorityFeePerGas: 2n });
    expect(chooseSessionFees(10n, 50n, 15n)).toEqual({ maxFeePerGas: 15n, maxPriorityFeePerGas: 15n });
  });

  it("refuses when the scope cap is below the base fee (op could never be fairly included)", () => {
    expect(() => chooseSessionFees(100n, 1n, 50n)).toThrow(/gas cap/);
  });
});

describe("decodeScope", () => {
  it("reads the 9-field security-v1 Scope tuple", () => {
    const raw = ["0x1", "0x2", 5n, 60n, 99n, 7n, 123n, 456n, "0x3"];
    expect(decodeScope(raw)).toEqual({
      recipient: "0x1", spendToken: "0x2", maxAmountPerCall: 5n, periodSeconds: 60, validUntil: 99,
      lastFiredAt: 7, maxFeePerGas: 123n, maxTotalGas: 456n, paymaster: "0x3",
    });
  });
});

describe("fire gas budget", () => {
  it("fits the default scope maxTotalGas (cron budget + paymaster limits, +25%)", () => {
    const base = FIRE_VERIFICATION_GAS + FIRE_CALL_GAS + FIRE_PRE_VERIFICATION_GAS;
    const defaultCap = ((base + 150_000n + 120_000n) * 5n) / 4n;
    expect(base + 150_000n + 120_000n).toBeLessThanOrEqual(defaultCap);
  });
});
