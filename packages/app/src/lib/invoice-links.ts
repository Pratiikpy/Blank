// Invoice deep-links — the only thing a vendor sends to a client out
// of band. Format mirrors the Express-style route: `/app/invoice/:chainId/:invoiceId`.
//
// Pure helpers — no React, no DOM. Reused by the InvoicePage route, the
// "copy link" button, and (later) the email integration.

import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";

const SUPPORTED: ReadonlySet<number> = new Set([ETH_SEPOLIA_ID, BASE_SEPOLIA_ID]);

/** Returns `https://<host>/app/invoice/<chainId>/<invoiceId>`. */
export function buildInvoiceLink(
  chainId: number,
  invoiceId: number | string,
  origin: string = typeof window !== "undefined" ? window.location.origin : "",
): string {
  const id = String(invoiceId);
  // Reject anything that isn't a non-negative integer — keeps us out of
  // a path-traversal class of bug if a caller passes a bad id.
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`buildInvoiceLink: invoiceId must be a non-negative integer, got ${id}`);
  }
  if (!SUPPORTED.has(chainId)) {
    throw new Error(`buildInvoiceLink: unsupported chain ${chainId}`);
  }
  return `${origin}/app/invoice/${chainId}/${id}`;
}

/** Returns `/app/invoice/<chainId>/<invoiceId>` (no host). Useful for in-app `navigate(...)`. */
export function buildInvoicePath(chainId: number, invoiceId: number | string): string {
  const id = String(invoiceId);
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`buildInvoicePath: invoiceId must be a non-negative integer, got ${id}`);
  }
  if (!SUPPORTED.has(chainId)) {
    throw new Error(`buildInvoicePath: unsupported chain ${chainId}`);
  }
  return `/app/invoice/${chainId}/${id}`;
}

/** Parses any invoice link/path. Returns null on malformed input. */
export function parseInvoiceLink(
  input: string,
): { chainId: number; invoiceId: number } | null {
  if (typeof input !== "string" || input.length === 0) return null;
  // Accept absolute URLs and bare paths. `URL` throws on bare paths so we
  // try-construct first, then fall through to manual path parsing.
  let pathname: string;
  try {
    pathname = new URL(input).pathname;
  } catch {
    pathname = input.startsWith("/") ? input : `/${input}`;
  }
  const m = pathname.match(/^\/app\/invoice\/(\d+)\/(\d+)\/?$/);
  if (!m) return null;
  const chainId = Number(m[1]);
  const invoiceId = Number(m[2]);
  if (!SUPPORTED.has(chainId)) return null;
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 0) return null;
  return { chainId, invoiceId };
}
