import { describe, it, expect } from "vitest";
import { formatUsdcInput, formatUsdcBigint } from "./format";

// §15.x lib test for USDC display formatting. Every balance + amount
// surfaced to users routes through one of these. Locale defaults
// silently drop precision or commas depending on JS engine, so we pin
// expected output for both helpers.

describe("formatUsdcInput", () => {
  it("returns '0.00' for empty / non-finite input", () => {
    expect(formatUsdcInput("")).toBe("0.00");
    expect(formatUsdcInput("not-a-number")).toBe("0.00");
    expect(formatUsdcInput("NaN")).toBe("0.00");
  });

  it("formats integer string with 2 minimum fraction digits", () => {
    expect(formatUsdcInput("100")).toBe("100.00");
    expect(formatUsdcInput("0")).toBe("0.00");
  });

  it("preserves decimal places up to 6", () => {
    expect(formatUsdcInput("100.5")).toBe("100.50");
    expect(formatUsdcInput("100.123456")).toBe("100.123456");
  });

  it("groups thousands with commas in en-US locale", () => {
    expect(formatUsdcInput("1234567")).toBe("1,234,567.00");
  });
});

describe("formatUsdcBigint", () => {
  it("returns '0.00' for zero", () => {
    expect(formatUsdcBigint(0n)).toBe("0.00");
  });

  it("formats 1 USDC (6-decimal) as 1.00", () => {
    expect(formatUsdcBigint(1_000_000n)).toBe("1.00");
  });

  it("formats 1.5 USDC as 1.50", () => {
    expect(formatUsdcBigint(1_500_000n)).toBe("1.50");
  });

  it("preserves up to 6 fraction digits when present", () => {
    expect(formatUsdcBigint(1_234_567n)).toBe("1.234567");
  });

  it("groups thousands with commas", () => {
    expect(formatUsdcBigint(1_234_567_000_000n)).toBe("1,234,567.00");
  });

  it("respects the decimals override (e.g. 18-decimal token)", () => {
    expect(formatUsdcBigint(1_500_000_000_000_000_000n, 18)).toBe("1.50");
  });
});
