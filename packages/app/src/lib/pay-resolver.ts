// Resolve the `:identifier` in `/pay/:identifier` to a payable Ethereum
// address. The identifier may be:
//
//   • A plain `0x…40hex` address       — used as-is
//   • An ENS / Basenames name           — resolved via mainnet (CCIP-Read for
//                                         Basenames)
//   • An `INV-<n>` invoice ID           — looked up in the `invoices` table
//                                         and resolved to the vendor address
//
// The function returns a discriminated union so callers can render
// invoice-specific UI when applicable (description, due date, status badge).

import { isAddress, type Address } from "viem";
import { resolveName, looksLikeEnsName } from "./address-resolver";
import { supabase, type InvoiceRow } from "./supabase";
import { log } from "./log";

export type PayTarget =
  | { kind: "address"; address: Address; ensName?: string }
  | { kind: "name"; address: Address; ensName: string }
  | {
      kind: "invoice";
      address: Address;
      invoice: InvoiceRow;
      ensName?: string;
    };

export type PayResolveError =
  | { kind: "not-found"; identifier: string }
  | { kind: "ens-failed"; identifier: string }
  | { kind: "invalid"; identifier: string }
  | { kind: "supabase-unavailable" };

export type PayResolveResult =
  | { ok: true; target: PayTarget }
  | { ok: false; error: PayResolveError };

const INVOICE_PATTERN = /^INV-?(\d+)$/i;

/** Look up an invoice row by its on-chain `invoice_id`. */
async function fetchInvoice(invoiceId: number): Promise<InvoiceRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn("payResolver.fetchInvoice.failed", { error: error.message });
    return null;
  }
  return (data as InvoiceRow | null) ?? null;
}

/** Resolve a /pay/:identifier route param to a payable target. */
export async function resolvePayTarget(
  identifier: string,
): Promise<PayResolveResult> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, error: { kind: "invalid", identifier } };
  }

  // Invoice ID — exact match wins so "INV-42" never gets ENS-resolved.
  const invoiceMatch = trimmed.match(INVOICE_PATTERN);
  if (invoiceMatch) {
    if (!supabase) {
      return { ok: false, error: { kind: "supabase-unavailable" } };
    }
    const id = Number(invoiceMatch[1]);
    if (!Number.isFinite(id) || id < 0) {
      return { ok: false, error: { kind: "invalid", identifier } };
    }
    const invoice = await fetchInvoice(id);
    if (!invoice) {
      return { ok: false, error: { kind: "not-found", identifier } };
    }
    return {
      ok: true,
      target: {
        kind: "invoice",
        address: invoice.vendor_address as Address,
        invoice,
      },
    };
  }

  // Plain address.
  if (isAddress(trimmed)) {
    return { ok: true, target: { kind: "address", address: trimmed } };
  }

  // ENS / Basenames.
  if (looksLikeEnsName(trimmed)) {
    const addr = await resolveName(trimmed);
    if (!addr) {
      return { ok: false, error: { kind: "ens-failed", identifier } };
    }
    return {
      ok: true,
      target: { kind: "name", address: addr, ensName: trimmed },
    };
  }

  return { ok: false, error: { kind: "invalid", identifier } };
}
