import { describe, it, expect, vi, beforeEach } from "vitest";

// §15.x test for the receipt-OCR parsing heuristics. The 3 inner
// helpers (extractTotal / extractMerchant / extractDate) aren't
// exported, so we drive them through `recognizeReceipt` and mock
// the tesseract.js dynamic import to return arbitrary text.

let currentText = "";

vi.mock("tesseract.js", () => ({
  recognize: vi.fn(async () => ({ data: { text: currentText } })),
}));

import { recognizeReceipt } from "./receipt-ocr";

beforeEach(() => {
  currentText = "";
});

const FAKE_BLOB = new Blob(["x"], { type: "image/png" });

describe("recognizeReceipt (§15.x)", () => {
  it("returns the raw OCR text untouched", async () => {
    currentText = "Hello\nWorld";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.rawText).toBe("Hello\nWorld");
  });
});

describe("extractTotal (via recognizeReceipt)", () => {
  it("picks the value on a 'TOTAL' line over a subtotal", async () => {
    currentText = [
      "Subtotal     12.00",
      "Tax           1.20",
      "TOTAL        13.20",
    ].join("\n");
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(13.20);
  });

  it("picks the largest amount when 'TOTAL' has multiple values", async () => {
    currentText = [
      "TOTAL DUE   42.50  (after tip 50.00)",
    ].join("\n");
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(50.00);
  });

  it("falls back to the largest numeric value when no keyword present", async () => {
    currentText = "Item 1   3.50\nItem 2  19.99\nItem 3   2.50";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(19.99);
  });

  it("returns null when no plausible numeric value exists", async () => {
    currentText = "Thank you for shopping";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBeNull();
  });

  it("ignores zero / negative values", async () => {
    currentText = "TOTAL 0.00";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBeNull();
  });

  it("handles comma-style thousands (1,234.56)", async () => {
    currentText = "Grand Total $1,234.56";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(1234.56);
  });

  it("recognizes 'AMOUNT DUE' and 'BALANCE DUE' keyword variants", async () => {
    currentText = "Amount Due 99.00\nOther 100.00";
    let out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(99.00);

    currentText = "Balance Due 77.00\nOther 100.00";
    out = await recognizeReceipt(FAKE_BLOB);
    expect(out.total).toBe(77.00);
  });
});

describe("extractMerchant (via recognizeReceipt)", () => {
  it("returns the first alpha-rich line as merchant", async () => {
    currentText = "Acme Coffee\n2026-05-11\nTOTAL 5.00";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.merchant).toBe("Acme Coffee");
  });

  it("skips lines with < 3 alpha characters", async () => {
    currentText = "###\n12345\nAB\nReal Merchant Name\nTOTAL 5.00";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.merchant).toBe("Real Merchant Name");
  });

  it("truncates long merchant names to 64 characters", async () => {
    const long = "A".repeat(80) + " store";
    currentText = `${long}\nTOTAL 1.00`;
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.merchant!.length).toBe(64);
  });

  it("returns null when no alpha-rich line is found", async () => {
    currentText = "###\n12345\n----\n";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.merchant).toBeNull();
  });
});

describe("extractDate (via recognizeReceipt)", () => {
  it("parses YYYY-MM-DD format", async () => {
    currentText = "Receipt 2026-05-11\nTOTAL 5.00";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("2026-05-11");
  });

  it("parses YYYY/MM/DD format", async () => {
    currentText = "Date 2026/01/05";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("2026-01-05");
  });

  it("parses MM/DD/YYYY format with 4-digit year", async () => {
    currentText = "5/11/2026";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("2026-05-11");
  });

  it("expands 2-digit year >50 to 19xx", async () => {
    currentText = "5/11/95";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("1995-05-11");
  });

  it("expands 2-digit year <=50 to 20xx", async () => {
    currentText = "5/11/26";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("2026-05-11");
  });

  it("returns null when no date is found", async () => {
    currentText = "Just text\nTOTAL 5.00";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBeNull();
  });

  it("pads single-digit month + day with leading zero", async () => {
    currentText = "Date 2026-1-5";
    const out = await recognizeReceipt(FAKE_BLOB);
    expect(out.date).toBe("2026-01-05");
  });
});
