import { describe, it, expect } from "vitest";
import {
  buildInvoiceLink,
  buildInvoicePath,
  parseInvoiceLink,
} from "./invoice-links";
import { BASE_SEPOLIA_ID, ETH_SEPOLIA_ID } from "./constants";

describe("invoice-links", () => {
  describe("buildInvoiceLink", () => {
    it("builds a full URL on Base Sepolia", () => {
      expect(
        buildInvoiceLink(BASE_SEPOLIA_ID, 42, "https://www.myblank.app"),
      ).toBe("https://www.myblank.app/app/invoice/84532/42");
    });

    it("builds a full URL on ETH Sepolia", () => {
      expect(
        buildInvoiceLink(ETH_SEPOLIA_ID, 7, "https://www.myblank.app"),
      ).toBe("https://www.myblank.app/app/invoice/11155111/7");
    });

    it("accepts numeric or string invoiceId", () => {
      expect(buildInvoiceLink(BASE_SEPOLIA_ID, 1, "x")).toBe(
        "x/app/invoice/84532/1",
      );
      expect(buildInvoiceLink(BASE_SEPOLIA_ID, "1", "x")).toBe(
        "x/app/invoice/84532/1",
      );
    });

    it("rejects non-integer invoice ids", () => {
      expect(() => buildInvoiceLink(BASE_SEPOLIA_ID, "abc")).toThrow();
      expect(() => buildInvoiceLink(BASE_SEPOLIA_ID, "../etc/passwd")).toThrow();
      expect(() => buildInvoiceLink(BASE_SEPOLIA_ID, "1.5")).toThrow();
    });

    it("rejects unsupported chains", () => {
      expect(() => buildInvoiceLink(1, 1)).toThrow(); // mainnet
      expect(() => buildInvoiceLink(0, 1)).toThrow();
    });
  });

  describe("buildInvoicePath", () => {
    it("returns the bare path", () => {
      expect(buildInvoicePath(BASE_SEPOLIA_ID, 99)).toBe(
        "/app/invoice/84532/99",
      );
    });
  });

  describe("parseInvoiceLink", () => {
    it("parses an absolute URL", () => {
      expect(
        parseInvoiceLink("https://www.myblank.app/app/invoice/84532/12"),
      ).toEqual({ chainId: BASE_SEPOLIA_ID, invoiceId: 12 });
    });

    it("parses a bare path", () => {
      expect(parseInvoiceLink("/app/invoice/11155111/0")).toEqual({
        chainId: ETH_SEPOLIA_ID,
        invoiceId: 0,
      });
    });

    it("tolerates a trailing slash", () => {
      expect(parseInvoiceLink("/app/invoice/84532/3/")).toEqual({
        chainId: BASE_SEPOLIA_ID,
        invoiceId: 3,
      });
    });

    it("round-trips with buildInvoiceLink", () => {
      const link = buildInvoiceLink(BASE_SEPOLIA_ID, 5, "http://localhost");
      expect(parseInvoiceLink(link)).toEqual({
        chainId: BASE_SEPOLIA_ID,
        invoiceId: 5,
      });
    });

    it("returns null for unsupported chains", () => {
      expect(parseInvoiceLink("/app/invoice/1/1")).toBeNull();
      expect(parseInvoiceLink("/app/invoice/0/1")).toBeNull();
    });

    it("returns null for malformed paths", () => {
      expect(parseInvoiceLink("/app/invoice/abc/1")).toBeNull();
      expect(parseInvoiceLink("/app/invoice/84532/abc")).toBeNull();
      expect(parseInvoiceLink("/app/invoice/84532")).toBeNull();
      expect(parseInvoiceLink("/app/invoice/")).toBeNull();
      expect(parseInvoiceLink("")).toBeNull();
      expect(parseInvoiceLink("/somewhere/else")).toBeNull();
    });
  });
});
