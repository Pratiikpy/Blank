// Settlement paths for a BusinessHub invoice in PaymentPending or Disputed.
//
// The contract records how each invoice was paid (invoicePaymentMode) and
// accepts only that mode's finalize:
//   Direct (1): payInvoiceFinalize, client only. Match -> Paid, mismatch ->
//               Disputed (the funds already reached the vendor).
//   Escrow (2): releaseInvoiceEscrow. The client may settle at once; anyone
//               may after INVOICE_ESCROW_RELEASE_DELAY (7 days). Match pays
//               the vendor, mismatch refunds the payer.
//   Legacy (0): paid before modes were recorded. A legacy escrow payment must
//               be revalidated first (revalidateLegacyInvoiceEscrow); any
//               other legacy payment is finalized by the vendor only.
//
// A Disputed direct payment is refunded in two steps: the vendor calls
// refundDisputedInvoice, then anyone publishes the decrypted refund check via
// finalizeDisputedRefund. Cancelled only when the full paid amount went back.

import type { PublicClient } from "viem";
import { BusinessHubAbi } from "@/lib/abis";

export const PAYMENT_MODE = { Legacy: 0, Direct: 1, Escrow: 2 } as const;
export type PaymentMode = (typeof PAYMENT_MODE)[keyof typeof PAYMENT_MODE];

export const INVOICE_STATUS = {
  Pending: 0,
  Paid: 1,
  Cancelled: 2,
  PaymentPending: 3,
  Disputed: 4,
} as const;

/** Mirrors BusinessHub.INVOICE_ESCROW_RELEASE_DELAY. */
export const INVOICE_ESCROW_RELEASE_DELAY_SECONDS = 7 * 24 * 60 * 60;

export interface InvoiceSettlementState {
  mode: PaymentMode;
  /** Unix seconds the payment was made. 0 for legacy records. */
  paidAt: number;
  /** A refundDisputedInvoice attempt awaits finalizeDisputedRefund. */
  refundPending: boolean;
}

export type FinalizeAction =
  | { kind: "payInvoiceFinalize" }
  | { kind: "releaseInvoiceEscrow" }
  | { kind: "revalidateThenRelease" }
  | { kind: "blocked"; reason: string };

type Reader = Pick<PublicClient, "readContract">;

export async function readInvoiceSettlement(
  client: Reader,
  hub: `0x${string}`,
  invoiceId: number,
): Promise<InvoiceSettlementState> {
  const id = BigInt(invoiceId);
  const [mode, paidAt, refundPending] = await Promise.all([
    client.readContract({ address: hub, abi: BusinessHubAbi, functionName: "invoicePaymentMode", args: [id] }),
    client.readContract({ address: hub, abi: BusinessHubAbi, functionName: "invoicePaidAt", args: [id] }),
    client.readContract({ address: hub, abi: BusinessHubAbi, functionName: "invoiceRefundPending", args: [id] }),
  ]);
  return {
    mode: Number(mode) as PaymentMode,
    paidAt: Number(paidAt as bigint),
    refundPending: Boolean(refundPending),
  };
}

/** Seconds until a non-client may release an escrowed invoice. 0 = now. */
export function secondsUntilOpenRelease(paidAt: number, nowSeconds: number): number {
  if (paidAt <= 0) return INVOICE_ESCROW_RELEASE_DELAY_SECONDS;
  return Math.max(0, paidAt + INVOICE_ESCROW_RELEASE_DELAY_SECONDS - nowSeconds);
}

export function formatWait(seconds: number): string {
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  const minutes = Math.max(1, Math.ceil((seconds % 3600) / 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Which finalize call the caller may make for a PaymentPending invoice.
 * `isLegacyEscrow` only matters for mode Legacy; it is true when
 * revalidateLegacyInvoiceEscrow would succeed.
 */
export function chooseFinalizeAction(params: {
  mode: PaymentMode;
  paidAt: number;
  nowSeconds: number;
  isClient: boolean;
  isVendor: boolean;
  isLegacyEscrow: boolean;
}): FinalizeAction {
  const { mode, paidAt, nowSeconds, isClient, isVendor, isLegacyEscrow } = params;
  if (mode === PAYMENT_MODE.Direct) {
    return isClient
      ? { kind: "payInvoiceFinalize" }
      : { kind: "blocked", reason: "Only the client can finalize a direct payment." };
  }
  if (mode === PAYMENT_MODE.Escrow) {
    if (isClient) return { kind: "releaseInvoiceEscrow" };
    const wait = secondsUntilOpenRelease(paidAt, nowSeconds);
    return wait === 0
      ? { kind: "releaseInvoiceEscrow" }
      : { kind: "blocked", reason: `The client can release now. Anyone can release in ${formatWait(wait)}.` };
  }
  if (isLegacyEscrow) {
    // Revalidation is open to anyone, but if paidAt was never recorded it
    // starts the 7-day window now, so only the client can finish in one go.
    if (isClient) return { kind: "revalidateThenRelease" };
    const wait = secondsUntilOpenRelease(paidAt, nowSeconds);
    return wait === 0
      ? { kind: "revalidateThenRelease" }
      : { kind: "blocked", reason: `The client can release now. Anyone can release in ${formatWait(wait)}.` };
  }
  return isVendor
    ? { kind: "payInvoiceFinalize" }
    : { kind: "blocked", reason: "This payment predates payment modes. Only the vendor can finalize it." };
}

/** Poll the Threshold Network until a publicly decryptable ebool is signed. */
export async function pollDecryptBool(
  decryptForTx: (
    ctHash: bigint,
    fheType: "uint64" | "ebool",
  ) => Promise<{ decryptedValue: bigint | boolean; signature: `0x${string}` } | null>,
  handle: bigint,
  timeoutMs = 180_000,
  intervalMs = 5_000,
): Promise<{ value: boolean; signature: `0x${string}` }> {
  const startedAt = Date.now();
  for (;;) {
    const result = await decryptForTx(handle, "ebool");
    if (result) {
      const value =
        typeof result.decryptedValue === "boolean" ? result.decryptedValue : result.decryptedValue !== 0n;
      return { value, signature: result.signature };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Decryption timed out. Try again in a moment.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
