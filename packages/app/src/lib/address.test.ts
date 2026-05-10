import { describe, it, expect } from "vitest";
import { truncateAddress } from "./address";

// §15.x lib test for the address truncator. Used everywhere a full
// 0x-address would overflow a UI cell.

describe("truncateAddress", () => {
  it("truncates a full 42-char Ethereum address with default lengths", () => {
    expect(truncateAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234...5678",
    );
  });

  it("respects custom prefix + suffix lengths", () => {
    expect(
      truncateAddress("0x1234567890abcdef1234567890abcdef12345678", 4, 6),
    ).toBe("0x12...345678");
  });

  it("returns the input unchanged when too short to truncate meaningfully", () => {
    // shorter than prefix+suffix+3 (the ellipsis allowance) returns as-is
    expect(truncateAddress("0xabc")).toBe("0xabc");
    expect(truncateAddress("0x12345678")).toBe("0x12345678");
  });

  it("returns empty string unchanged", () => {
    expect(truncateAddress("")).toBe("");
  });
});
