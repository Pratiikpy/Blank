// Stripe-style minimal invoice PDF, rendered with @react-pdf/renderer.
//
// We deliberately ship one PDF design — clean, sans-serif, lots of
// whitespace — so freelancers don't have to think about layout. The PDF is
// stored on IPFS so any third party (the client's accountant, the bank, a
// court, etc.) can verify the document referenced by an on-chain CID hasn't
// been tampered with.
//
// Caller passes plaintext amount (the PDF is for humans). The on-chain
// invoice still uses the encrypted handle — only the URL/email leaks the
// number, never the chain.

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Link,
  pdf,
} from "@react-pdf/renderer";
import { pinFile, type PinResult } from "./ipfs";
import { truncateAddress } from "./address";

// ─── Types ──────────────────────────────────────────────────────────────

export interface InvoiceLineItem {
  description: string;
  /** Qty × rate = amount. All in human units (e.g. dollars, hours). */
  quantity: number;
  rate: number;
}

export interface InvoiceData {
  /** On-chain invoice ID. Used in the PDF header (`INV-0042`). */
  invoiceId: number;
  /** Vendor (sender). `name` is ENS / display name; `address` is 0x… */
  vendor: { name: string; address: string; email?: string };
  /** Client (recipient). */
  client: { name: string; address: string; email?: string };
  /** ISO timestamp string. */
  issueDate: string;
  /** ISO timestamp string. Optional. */
  dueDate?: string | null;
  /** Top-level description shown above line items. */
  description: string;
  /** Plaintext total (e.g. "3,700"). Currency rendered separately. */
  amount: string;
  currency?: string;
  /** Optional explicit line items. If omitted, a single row is synthesized
   *  from `description` and `amount`. */
  lineItems?: InvoiceLineItem[];
  /** Free-form note shown at bottom (thank you, terms, etc.). */
  notes?: string;
  /** Absolute URL the "Pay Now" button links to. Should hit /pay/<id>. */
  payUrl: string;
}

// ─── Layout ─────────────────────────────────────────────────────────────

const COLORS = {
  ink: "#1D1D1F",
  body: "#3F3F46",
  muted: "#71717A",
  hairline: "#E4E4E7",
  accent: "#10B981",
  cta: "#1D1D1F",
  ctaText: "#FFFFFF",
};

const styles = StyleSheet.create({
  page: {
    padding: 56,
    fontSize: 10,
    color: COLORS.body,
    fontFamily: "Helvetica",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    color: COLORS.ink,
    fontFamily: "Helvetica-Bold",
    letterSpacing: -0.5,
  },
  invoiceNumber: { fontSize: 11, color: COLORS.muted, marginTop: 4 },
  partiesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  partyBlock: { flex: 1, paddingRight: 16 },
  label: {
    fontSize: 8,
    color: COLORS.muted,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  partyName: { fontSize: 12, color: COLORS.ink, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  partyDetail: { fontSize: 9, color: COLORS.body, marginBottom: 1 },
  partyMono: { fontSize: 9, color: COLORS.muted, fontFamily: "Courier" },
  metaRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop: 12,
    marginBottom: 24,
  },
  metaCell: { flex: 1 },
  itemsHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingBottom: 6,
    marginBottom: 8,
  },
  itemsHeaderCell: { fontSize: 8, color: COLORS.muted, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1 },
  cellDesc: { flex: 4 },
  cellQty: { flex: 1, textAlign: "right" },
  cellRate: { flex: 1, textAlign: "right" },
  cellAmount: { flex: 1, textAlign: "right" },
  itemRow: { flexDirection: "row", paddingVertical: 6 },
  itemText: { fontSize: 10, color: COLORS.ink },
  totalsBlock: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop: 12,
    alignItems: "flex-end",
  },
  totalRow: { flexDirection: "row", marginBottom: 4, width: 240, justifyContent: "space-between" },
  totalLabel: { fontSize: 10, color: COLORS.muted },
  totalValue: { fontSize: 10, color: COLORS.ink },
  totalRowEmphasis: {
    flexDirection: "row",
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    width: 240,
    justifyContent: "space-between",
  },
  grandLabel: { fontSize: 11, color: COLORS.ink, fontFamily: "Helvetica-Bold" },
  grandValue: { fontSize: 14, color: COLORS.ink, fontFamily: "Helvetica-Bold" },
  ctaBlock: { marginTop: 36, alignItems: "center" },
  ctaButton: {
    backgroundColor: COLORS.cta,
    color: COLORS.ctaText,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 8,
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    textDecoration: "none",
  },
  ctaUrl: {
    marginTop: 8,
    fontSize: 8,
    color: COLORS.muted,
    fontFamily: "Courier",
  },
  notes: {
    marginTop: 32,
    padding: 12,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
    color: COLORS.body,
    fontSize: 9,
    lineHeight: 1.5,
  },
  footer: {
    position: "absolute",
    bottom: 32,
    left: 56,
    right: 56,
    fontSize: 8,
    color: COLORS.muted,
    textAlign: "center",
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatId(id: number): string {
  return `INV-${id.toString().padStart(4, "0")}`;
}

function lineItemsFromData(data: InvoiceData): InvoiceLineItem[] {
  if (data.lineItems && data.lineItems.length > 0) return data.lineItems;
  // Single-row synthesis when no detailed line items provided.
  const numericAmount = Number(String(data.amount).replace(/[^\d.-]/g, "")) || 0;
  return [{ description: data.description || "Services rendered", quantity: 1, rate: numericAmount }];
}

// ─── PDF document ───────────────────────────────────────────────────────

interface InvoicePDFProps {
  data: InvoiceData;
}

function InvoicePDF({ data }: InvoicePDFProps) {
  const items = lineItemsFromData(data);
  const subtotal = items.reduce((acc, it) => acc + it.quantity * it.rate, 0);
  const currency = data.currency ?? "USDC";

  return (
    <Document title={`${formatId(data.invoiceId)} — ${data.vendor.name}`}>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Invoice</Text>
            <Text style={styles.invoiceNumber}>{formatId(data.invoiceId)}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.label}>Total Due</Text>
            <Text style={{ fontSize: 22, color: COLORS.ink, fontFamily: "Helvetica-Bold" }}>
              {data.amount} {currency}
            </Text>
          </View>
        </View>

        {/* Parties */}
        <View style={styles.partiesRow}>
          <View style={styles.partyBlock}>
            <Text style={styles.label}>From</Text>
            <Text style={styles.partyName}>{data.vendor.name}</Text>
            {data.vendor.email && <Text style={styles.partyDetail}>{data.vendor.email}</Text>}
            <Text style={styles.partyMono}>{truncateAddress(data.vendor.address)}</Text>
          </View>
          <View style={styles.partyBlock}>
            <Text style={styles.label}>Bill To</Text>
            <Text style={styles.partyName}>{data.client.name}</Text>
            {data.client.email && <Text style={styles.partyDetail}>{data.client.email}</Text>}
            <Text style={styles.partyMono}>{truncateAddress(data.client.address)}</Text>
          </View>
        </View>

        {/* Meta */}
        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.label}>Issued</Text>
            <Text style={styles.itemText}>{formatDate(data.issueDate)}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.label}>Due</Text>
            <Text style={styles.itemText}>{formatDate(data.dueDate)}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.label}>Currency</Text>
            <Text style={styles.itemText}>{currency} (encrypted on-chain)</Text>
          </View>
        </View>

        {/* Line items */}
        <View style={styles.itemsHeader}>
          <Text style={[styles.itemsHeaderCell, styles.cellDesc]}>Description</Text>
          <Text style={[styles.itemsHeaderCell, styles.cellQty]}>Qty</Text>
          <Text style={[styles.itemsHeaderCell, styles.cellRate]}>Rate</Text>
          <Text style={[styles.itemsHeaderCell, styles.cellAmount]}>Amount</Text>
        </View>
        {items.map((item, idx) => (
          <View key={idx} style={styles.itemRow}>
            <Text style={[styles.itemText, styles.cellDesc]}>{item.description}</Text>
            <Text style={[styles.itemText, styles.cellQty]}>{item.quantity}</Text>
            <Text style={[styles.itemText, styles.cellRate]}>{item.rate.toLocaleString()}</Text>
            <Text style={[styles.itemText, styles.cellAmount]}>
              {(item.quantity * item.rate).toLocaleString()}
            </Text>
          </View>
        ))}

        {/* Totals */}
        <View style={styles.totalsBlock}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>
              {subtotal.toLocaleString()} {currency}
            </Text>
          </View>
          <View style={styles.totalRowEmphasis}>
            <Text style={styles.grandLabel}>Total Due</Text>
            <Text style={styles.grandValue}>
              {data.amount} {currency}
            </Text>
          </View>
        </View>

        {/* CTA */}
        <View style={styles.ctaBlock}>
          <Link src={data.payUrl} style={styles.ctaButton}>
            Pay Invoice
          </Link>
          <Text style={styles.ctaUrl}>{data.payUrl}</Text>
        </View>

        {/* Notes */}
        {data.notes && (
          <View style={styles.notes}>
            <Text>{data.notes}</Text>
          </View>
        )}

        {/* Footer */}
        <Text style={styles.footer}>
          Generated by Blank · Encrypted payments on Fhenix CoFHE · Amount is private on-chain
        </Text>
      </Page>
    </Document>
  );
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Render the invoice to a Blob (`application/pdf`). Useful for download. */
export async function renderInvoicePdf(data: InvoiceData): Promise<Blob> {
  return await pdf(<InvoicePDF data={data} />).toBlob();
}

/**
 * Render the invoice and pin the resulting PDF to IPFS via Pinata.
 * Returns the IPFS CID + the rendered Blob (for immediate download/preview).
 */
export async function renderAndPinInvoicePdf(
  data: InvoiceData,
  options: { jwt?: string } = {},
): Promise<{ cid: string; blob: Blob; pin: PinResult }> {
  const blob = await renderInvoicePdf(data);
  const pin = await pinFile(blob, {
    name: `${formatId(data.invoiceId)}.pdf`,
    jwt: options.jwt,
  });
  return { cid: pin.cid, blob, pin };
}
