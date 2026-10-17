import { describe, it, expect } from "vitest";
import { ESCROW_DISPUTE_TIMEOUT_SECONDS, disputeTimeoutAt, escrowArbiterError, hasArbiter } from "./escrow-rules";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("escrowArbiterError", () => {
  it("no arbiter is fine", () => {
    expect(escrowArbiterError("", ME, BOB)).toBeNull();
    expect(escrowArbiterError(ZERO, ME, BOB)).toBeNull();
    expect(escrowArbiterError(undefined, ME, BOB)).toBeNull();
  });

  it("a third party is fine", () => {
    expect(escrowArbiterError(CAROL, ME, BOB)).toBeNull();
  });

  it("depositor or beneficiary is rejected, case-insensitively", () => {
    expect(escrowArbiterError(ME.toUpperCase().replace("0X", "0x"), ME, BOB)).toContain("cannot be you");
    expect(escrowArbiterError(` ${BOB} `, ME, BOB.toUpperCase().replace("0X", "0x"))).toContain("beneficiary");
  });
});

describe("hasArbiter", () => {
  it("only a real address counts", () => {
    expect(hasArbiter(CAROL)).toBe(true);
    expect(hasArbiter("")).toBe(false);
    expect(hasArbiter(ZERO)).toBe(false);
    expect(hasArbiter(null)).toBe(false);
  });
});

describe("disputeTimeoutAt", () => {
  it("30 days after the dispute, or after the deadline for unrecorded disputes", () => {
    expect(disputeTimeoutAt(1000, 5000)).toBe(1000 + ESCROW_DISPUTE_TIMEOUT_SECONDS);
    expect(disputeTimeoutAt(0, 5000)).toBe(5000 + ESCROW_DISPUTE_TIMEOUT_SECONDS);
  });
});
