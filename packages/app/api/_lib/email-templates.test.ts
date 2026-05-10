import { describe, it, expect } from "vitest";
import {
  renderBrandedEmail,
  renderInvoiceEmail,
  renderPaymentRequestEmail,
} from "./email-templates.js";

// §15.x server-side test for the email-template renderers. Every
// transactional email (invoice, payment-request, etc.) flows
// through these. SECURITY: HTML escaping is the only thing
// stopping a vendor's invoice description from injecting <script>
// into the recipient's inbox. Pin the escape behavior + the
// subject + plain-text mirror.

describe("renderBrandedEmail", () => {
  it("returns both html and text fields", () => {
    const out = renderBrandedEmail({
      preheader: "p",
      title: "Hello",
      intro: "World",
      ctaLabel: "Click",
      ctaUrl: "https://example.com",
    });
    expect(out.html).toContain("Hello");
    expect(out.html).toContain("World");
    expect(out.text).toContain("Hello");
    expect(out.text).toContain("World");
  });

  it("HTML-escapes title + intro + preheader to block XSS", () => {
    const out = renderBrandedEmail({
      preheader: "<script>alert(1)</script>",
      title: "<b>x</b>",
      intro: "danger & < > \"'",
      ctaLabel: "<x>",
      ctaUrl: "https://example.com",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<b>x</b>");
    expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out.html).toContain("danger &amp; &lt; &gt; &quot;&#39;");
  });

  it("escapes the CTA URL attribute", () => {
    const out = renderBrandedEmail({
      preheader: "p",
      title: "t",
      intro: "i",
      ctaLabel: "l",
      ctaUrl: 'https://x.com/?q="><script>alert(1)</script>',
    });
    expect(out.html).not.toContain('"><script>');
    expect(out.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("renders rows table when rows are provided", () => {
    const out = renderBrandedEmail({
      preheader: "p",
      title: "t",
      intro: "i",
      ctaLabel: "l",
      ctaUrl: "https://example.com",
      rows: [
        { label: "Amount", value: "100 USDC" },
        { label: "Memo", value: "rent" },
      ],
    });
    expect(out.html).toContain("Amount");
    expect(out.html).toContain("100 USDC");
    expect(out.html).toContain("Memo");
    expect(out.text).toContain("Amount: 100 USDC");
    expect(out.text).toContain("Memo: rent");
  });

  it("renders footer when provided", () => {
    const out = renderBrandedEmail({
      preheader: "p",
      title: "t",
      intro: "i",
      ctaLabel: "l",
      ctaUrl: "https://example.com",
      footer: "Encrypted on-chain",
    });
    expect(out.html).toContain("Encrypted on-chain");
    expect(out.text).toContain("Encrypted on-chain");
  });

  it("plain-text mirror includes CTA label + URL", () => {
    const out = renderBrandedEmail({
      preheader: "p",
      title: "t",
      intro: "i",
      ctaLabel: "Pay now",
      ctaUrl: "https://example.com/pay",
    });
    expect(out.text).toContain("Pay now: https://example.com/pay");
  });
});

describe("renderInvoiceEmail", () => {
  it("subject mentions vendor + amount + currency", () => {
    const out = renderInvoiceEmail({
      invoiceId: 7,
      vendorName: "Acme Corp",
      amount: "100",
      currency: "USDC",
      description: "consulting",
      dueDate: null,
      payUrl: "https://blank/pay/INV-7",
    });
    expect(out.subject).toContain("Acme Corp");
    expect(out.subject).toContain("100");
    expect(out.subject).toContain("USDC");
  });

  it("includes invoice id padded to 4 digits", () => {
    const out = renderInvoiceEmail({
      invoiceId: 7,
      vendorName: "v",
      amount: "1",
      currency: "USDC",
      description: "",
      dueDate: null,
      payUrl: "https://x",
    });
    expect(out.html).toContain("#0007");
  });

  it("falls back to placeholder for empty description", () => {
    const out = renderInvoiceEmail({
      invoiceId: 1,
      vendorName: "v",
      amount: "1",
      currency: "USDC",
      description: "",
      dueDate: null,
      payUrl: "https://x",
    });
    expect(out.text).toContain("Description: —");
  });

  it("escapes vendor + description (XSS via invoice fields)", () => {
    const out = renderInvoiceEmail({
      invoiceId: 1,
      vendorName: "<script>",
      amount: "1",
      currency: "USDC",
      description: "<img onerror=alert(1)>",
      dueDate: null,
      payUrl: "https://x",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img onerror");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("&lt;img onerror=alert(1)&gt;");
  });
});

describe("renderPaymentRequestEmail", () => {
  it("subject mentions requester name", () => {
    const out = renderPaymentRequestEmail({
      requestId: 1,
      requesterName: "Alice",
      note: "",
      reviewUrl: "https://x",
    });
    expect(out.subject).toContain("Alice");
  });

  it("omits Note row when note is empty", () => {
    const out = renderPaymentRequestEmail({
      requestId: 1,
      requesterName: "Alice",
      note: "",
      reviewUrl: "https://x",
    });
    expect(out.text).not.toContain("Note:");
    expect(out.text).toContain("From: Alice");
    expect(out.text).toContain("Request: #1");
  });

  it("includes Note row when note is set", () => {
    const out = renderPaymentRequestEmail({
      requestId: 1,
      requesterName: "Alice",
      note: "for the rent split",
      reviewUrl: "https://x",
    });
    expect(out.text).toContain("Note: for the rent split");
  });

  it("escapes note + requester (XSS via request fields)", () => {
    const out = renderPaymentRequestEmail({
      requestId: 1,
      requesterName: "<script>",
      note: '"><img onerror=alert(1)>',
      reviewUrl: "https://x",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain('"><img');
  });
});
