import { describe, it, expect } from "vitest";
import {
  encodeP256AsErc1271Signature,
  checkSmartWalletAdapterAvailable,
} from "./smart-account-cofhe-bridge";
import type { Hex } from "viem";

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
