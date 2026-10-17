import { describe, it, expect, vi } from "vitest";
import {
  INVOICE_ESCROW_RELEASE_DELAY_SECONDS,
  PAYMENT_MODE,
  chooseFinalizeAction,
  formatWait,
  pollDecryptBool,
  readInvoiceSettlement,
  secondsUntilOpenRelease,
} from "./invoice-settlement";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("secondsUntilOpenRelease", () => {
  it("counts down from paidAt + 7 days, never negative", () => {
    expect(secondsUntilOpenRelease(NOW - DAY, NOW)).toBe(6 * DAY);
    expect(secondsUntilOpenRelease(NOW - 7 * DAY, NOW)).toBe(0);
    expect(secondsUntilOpenRelease(NOW - 30 * DAY, NOW)).toBe(0);
  });

  it("unrecorded paidAt (0) is treated as a full window, not open", () => {
    expect(secondsUntilOpenRelease(0, NOW)).toBe(INVOICE_ESCROW_RELEASE_DELAY_SECONDS);
  });
});

describe("formatWait", () => {
  it("formats days, hours, minutes", () => {
    expect(formatWait(0)).toBe("now");
    expect(formatWait(6 * DAY)).toBe("6d");
    expect(formatWait(6 * DAY + 3 * 3600)).toBe("6d 3h");
    expect(formatWait(2 * 3600 + 120)).toBe("2h 2m");
    expect(formatWait(30)).toBe("1m");
  });
});

describe("chooseFinalizeAction", () => {
  const base = { paidAt: NOW - DAY, nowSeconds: NOW, isLegacyEscrow: false };

  it("Direct: client only", () => {
    expect(chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Direct, isClient: true, isVendor: false }))
      .toEqual({ kind: "payInvoiceFinalize" });
    expect(chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Direct, isClient: false, isVendor: true }).kind)
      .toBe("blocked");
  });

  it("Escrow: client any time, anyone after 7 days", () => {
    expect(chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Escrow, isClient: true, isVendor: false }))
      .toEqual({ kind: "releaseInvoiceEscrow" });
    const early = chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Escrow, isClient: false, isVendor: true });
    expect(early.kind).toBe("blocked");
    expect(early.kind === "blocked" && early.reason).toContain("6d");
    expect(
      chooseFinalizeAction({ ...base, paidAt: NOW - 7 * DAY, mode: PAYMENT_MODE.Escrow, isClient: false, isVendor: false }),
    ).toEqual({ kind: "releaseInvoiceEscrow" });
  });

  it("Legacy escrow: revalidate first; non-client only once the window has passed", () => {
    expect(
      chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Legacy, isLegacyEscrow: true, isClient: true, isVendor: false }),
    ).toEqual({ kind: "revalidateThenRelease" });
    expect(
      chooseFinalizeAction({ ...base, paidAt: 0, mode: PAYMENT_MODE.Legacy, isLegacyEscrow: true, isClient: false, isVendor: true }).kind,
    ).toBe("blocked");
    expect(
      chooseFinalizeAction({ ...base, paidAt: NOW - 8 * DAY, mode: PAYMENT_MODE.Legacy, isLegacyEscrow: true, isClient: false, isVendor: true }),
    ).toEqual({ kind: "revalidateThenRelease" });
  });

  it("Legacy direct (incl. retired swap/oracle records): vendor only", () => {
    expect(chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Legacy, isClient: false, isVendor: true }))
      .toEqual({ kind: "payInvoiceFinalize" });
    const client = chooseFinalizeAction({ ...base, mode: PAYMENT_MODE.Legacy, isClient: true, isVendor: false });
    expect(client.kind === "blocked" && client.reason).toContain("Only the vendor");
  });
});

describe("readInvoiceSettlement", () => {
  it("reads mode, paidAt, refundPending for the id", async () => {
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      expect(args).toEqual([5n]);
      if (functionName === "invoicePaymentMode") return 2;
      if (functionName === "invoicePaidAt") return 123n;
      if (functionName === "invoiceRefundPending") return true;
      throw new Error(functionName);
    });
    const s = await readInvoiceSettlement({ readContract } as never, "0x1111111111111111111111111111111111111111", 5);
    expect(s).toEqual({ mode: 2, paidAt: 123, refundPending: true });
  });
});

describe("pollDecryptBool", () => {
  it("normalizes bigint and boolean results", async () => {
    const sig = "0xabc" as `0x${string}`;
    await expect(pollDecryptBool(async () => ({ decryptedValue: 1n, signature: sig }), 9n)).resolves.toEqual({ value: true, signature: sig });
    await expect(pollDecryptBool(async () => ({ decryptedValue: 0n, signature: sig }), 9n)).resolves.toEqual({ value: false, signature: sig });
    await expect(pollDecryptBool(async () => ({ decryptedValue: true, signature: sig }), 9n)).resolves.toEqual({ value: true, signature: sig });
  });

  it("retries until signed, then times out honestly", async () => {
    vi.useFakeTimers();
    const decrypt = vi.fn().mockResolvedValue(null);
    const p = pollDecryptBool(decrypt, 9n, 10_000, 5_000);
    const settled = expect(p).rejects.toThrow("Decryption timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    expect(decrypt.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(decrypt).toHaveBeenCalledWith(9n, "ebool");
    vi.useRealTimers();
  });
});
