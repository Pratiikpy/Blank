import { describe, it, expect, vi } from "vitest";
import { encodeFunctionData } from "viem";
import {
  computeNextFireSeconds,
  formatTimeUntil,
  PERIOD_PRESETS,
  buildSessionScope,
  fetchActiveScopes,
  SessionKeyValidatorAbi,
  SESSION_FIRE_GAS,
  DEFAULT_SESSION_MAX_FEE_PER_GAS,
} from "./scheduled-sends";

// §15.x lib test for the scheduled-send timing helpers. Drives the
// "Next fire in 2d 3h" UI label and the contract's validAfter
// calculation. Off-by-one in either function means the UI shows a
// wrong countdown OR the user submits a tx the contract rejects.

describe("PERIOD_PRESETS", () => {
  it("includes Daily / Weekly / Bi-weekly / Monthly presets", () => {
    const labels = PERIOD_PRESETS.map((p) => p.label);
    expect(labels).toContain("Daily");
    expect(labels).toContain("Weekly");
    expect(labels).toContain("Bi-weekly");
    expect(labels).toContain("Monthly (30d)");
  });

  it("seconds match documented period lengths", () => {
    const byLabel = Object.fromEntries(PERIOD_PRESETS.map((p) => [p.label, p.seconds]));
    expect(byLabel["Daily"]).toBe(86_400);
    expect(byLabel["Weekly"]).toBe(86_400 * 7);
    expect(byLabel["Bi-weekly"]).toBe(86_400 * 14);
    expect(byLabel["Monthly (30d)"]).toBe(86_400 * 30);
  });

  it("seconds are strictly increasing in preset order", () => {
    for (let i = 1; i < PERIOD_PRESETS.length; i++) {
      expect(PERIOD_PRESETS[i].seconds).toBeGreaterThan(PERIOD_PRESETS[i - 1].seconds);
    }
  });
});

describe("computeNextFireSeconds", () => {
  it("returns 0 when the scope has never fired (validAfter=0 path)", () => {
    expect(computeNextFireSeconds({ lastFiredAt: 0, periodSeconds: 86_400 })).toBe(0);
  });

  it("adds periodSeconds to the last-fired timestamp", () => {
    expect(
      computeNextFireSeconds({ lastFiredAt: 1_700_000_000, periodSeconds: 86_400 }),
    ).toBe(1_700_086_400);
  });

  it("works for weekly cadence", () => {
    expect(
      computeNextFireSeconds({ lastFiredAt: 1_000_000, periodSeconds: 7 * 86_400 }),
    ).toBe(1_604_800);
  });
});

describe("formatTimeUntil", () => {
  it("returns 'Now' for 0 or negative seconds", () => {
    expect(formatTimeUntil(0)).toBe("Now");
    expect(formatTimeUntil(-30)).toBe("Now");
  });

  it("renders sub-minute as seconds", () => {
    expect(formatTimeUntil(30)).toBe("in 30s");
    expect(formatTimeUntil(1)).toBe("in 1s");
  });

  it("renders sub-hour as minutes (rounded up)", () => {
    expect(formatTimeUntil(60)).toBe("in 1m");
    expect(formatTimeUntil(120)).toBe("in 2m");
    expect(formatTimeUntil(90)).toBe("in 2m"); // ceil
    expect(formatTimeUntil(3599)).toBe("in 60m");
  });

  it("renders sub-day as hours (rounded up)", () => {
    expect(formatTimeUntil(3600)).toBe("in 1h");
    expect(formatTimeUntil(7200)).toBe("in 2h");
    expect(formatTimeUntil(86_399)).toBe("in 24h");
  });

  it("renders 1 day and beyond as days (rounded up)", () => {
    expect(formatTimeUntil(86_400)).toBe("in 1d");
    expect(formatTimeUntil(86_400 * 2)).toBe("in 2d");
    expect(formatTimeUntil(86_400 * 7)).toBe("in 7d");
  });

  it("ceils on partial periods (so countdown never undershoots)", () => {
    // 59 seconds rounds up to 1m so the UI never shows "in 0s"
    // mid-second. Ceil keeps the user-visible countdown
    // monotonically non-increasing.
    expect(formatTimeUntil(59)).toBe("in 59s");
    expect(formatTimeUntil(61)).toBe("in 2m");
    expect(formatTimeUntil(3601)).toBe("in 2h");
    expect(formatTimeUntil(86_401)).toBe("in 2d");
  });
});

describe("buildSessionScope (security-v1 Scope struct)", () => {
  const base = {
    recipient: "0x1111111111111111111111111111111111111111" as const,
    spendToken: "0x2222222222222222222222222222222222222222" as const,
    maxAmountPerCall: 5_000_000n,
    periodSeconds: 86_400,
    validUntil: 2_000_000_000,
  };

  it("defaults the gas caps to the cron's per-fire budget + 25% and 50 gwei", () => {
    const s = buildSessionScope({ ...base, paymaster: null });
    expect(s.maxFeePerGas).toBe(DEFAULT_SESSION_MAX_FEE_PER_GAS);
    expect(s.maxTotalGas).toBe((SESSION_FIRE_GAS * 5n) / 4n);
    expect(s.paymaster).toBe("0x0000000000000000000000000000000000000000");
    expect(s.lastFiredAt).toBe(0);
  });

  it("names the paymaster and honours explicit caps", () => {
    const pm = "0x3333333333333333333333333333333333333333" as const;
    const s = buildSessionScope({ ...base, paymaster: pm, maxFeePerGas: 7n, maxTotalGas: 9n });
    expect([s.paymaster, s.maxFeePerGas, s.maxTotalGas]).toEqual([pm, 7n, 9n]);
  });

  it("encodes against the validator ABI's 9-field tuple", () => {
    const s = buildSessionScope({ ...base, paymaster: null });
    const data = encodeFunctionData({
      abi: SessionKeyValidatorAbi,
      functionName: "setScope",
      args: ["0x4444444444444444444444444444444444444444", s],
    });
    // selector + sessionKey + 9 static words
    expect((data.length - 10) / 64).toBe(10);
  });
});

describe("fetchActiveScopes merges ScopeGasSet into the live scope", () => {
  it("attaches gas caps + paymaster from the same block's ScopeGasSet", async () => {
    const KEY = "0x5555555555555555555555555555555555555555";
    const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
      if (event.name === "ScopeSet") {
        return [{
          blockNumber: 10n, logIndex: 1,
          args: { sessionKey: KEY, recipient: "0x1111111111111111111111111111111111111111", spendToken: "0x2222222222222222222222222222222222222222", maxAmountPerCall: 5n, periodSeconds: 60n, validUntil: 9_999_999_999n },
        }];
      }
      if (event.name === "ScopeGasSet") {
        return [{ blockNumber: 10n, logIndex: 2, args: { sessionKey: KEY, maxFeePerGas: 123n, maxTotalGas: 456n, paymaster: "0x3333333333333333333333333333333333333333" } }];
      }
      return [];
    });
    const out = await fetchActiveScopes({
      publicClient: { getLogs } as never,
      validatorAddress: "0x6666666666666666666666666666666666666666",
      accountAddress: "0x7777777777777777777777777777777777777777",
    });
    expect(out).toHaveLength(1);
    expect(out[0].maxFeePerGas).toBe(123n);
    expect(out[0].maxTotalGas).toBe(456n);
    expect(out[0].paymaster).toBe("0x3333333333333333333333333333333333333333");
  });
});
