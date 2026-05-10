import { describe, it, expect } from "vitest";
import { Encryptable, FheTypes } from "./cofhe-shim";

// §15.x lib test for the Encryptable + FheTypes shim proxies. These
// fall back to hardcoded values until the real @cofhe/sdk loads, so
// the fallback shape MUST match @cofhe/sdk/core/types.ts FheTypes
// enum exactly. Callers that build encrypted-input shapes before
// connect would otherwise emit values that the SDK rejects (or
// worse, accepts with a wrong utype) on first encrypt.
//
// Source-of-truth comment in cofhe-shim.ts:
//   FheTypes enum: Bool=0, Uint4=1, Uint8=2, Uint16=3, Uint32=4,
//                  Uint64=5, Uint128=6, Uint160=7

describe("FheTypes proxy fallback", () => {
  it("Bool=0", () => expect(FheTypes.Bool).toBe(0));
  it("Uint4=1", () => expect(FheTypes.Uint4).toBe(1));
  it("Uint8=2", () => expect(FheTypes.Uint8).toBe(2));
  it("Uint16=3", () => expect(FheTypes.Uint16).toBe(3));
  it("Uint32=4", () => expect(FheTypes.Uint32).toBe(4));
  it("Uint64=5", () => expect(FheTypes.Uint64).toBe(5));
  it("Uint128=6", () => expect(FheTypes.Uint128).toBe(6));
  it("Uint160=7 / Address=7", () => {
    expect(FheTypes.Uint160).toBe(7);
    expect(FheTypes.Address).toBe(7);
  });

  it("returns 0 for unknown keys (defensive default)", () => {
    expect(FheTypes.NonExistentType).toBe(0);
  });
});

describe("Encryptable proxy fallback", () => {
  it("uint64 returns InEuint64 ABI tuple shape with utype=5", () => {
    const out = Encryptable.uint64(42);
    expect(out).toEqual({
      ctHash: 42n,
      securityZone: 0,
      utype: 5,
      signature: "0x",
    });
  });

  it("bool returns utype=0", () => {
    expect(Encryptable.bool(1).utype).toBe(0);
  });

  it("uint8 returns utype=2", () => {
    expect(Encryptable.uint8(42).utype).toBe(2);
  });

  it("uint16 returns utype=3", () => {
    expect(Encryptable.uint16(42).utype).toBe(3);
  });

  it("uint32 returns utype=4", () => {
    expect(Encryptable.uint32(42).utype).toBe(4);
  });

  it("uint128 returns utype=6", () => {
    expect(Encryptable.uint128(42).utype).toBe(6);
  });

  it("address returns utype=7 (matches FheTypes.Uint160 / Address)", () => {
    expect(Encryptable.address(42).utype).toBe(7);
  });

  it("converts the value to bigint regardless of input type", () => {
    expect(Encryptable.uint64(0).ctHash).toBe(0n);
    expect(Encryptable.uint64(1n).ctHash).toBe(1n);
    expect(Encryptable.uint64("123").ctHash).toBe(123n);
  });

  it("unknown encryptable key falls back to utype=4 (uint32)", () => {
    // Defensive default — keeps an unknown caller from emitting NaN.
    const out = Encryptable.notARealMethod(0);
    expect(out.utype).toBe(4);
  });
});
