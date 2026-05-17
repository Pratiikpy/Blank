import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as React from "react";

// §15.x test for /api/og/proof — dynamic OG image for encrypted
// income/balance proofs. This is the viral-artifact half of the
// "income-proof share link" feature: without per-proof OG, sharing
// /verify/<id> on Twitter falls back to the generic index.html
// preview. Pin the variant selection (missing / pending / verified
// / false) + threshold formatting + cache headers + getProof read
// shape so a regression doesn't silently degrade every shared link.

const capturedElement = vi.hoisted<{
  element: React.ReactElement | null;
  options: { width?: number; height?: number; headers?: Record<string, string> } | null;
}>(() => ({ element: null, options: null }));

vi.mock("@vercel/og", () => ({
  ImageResponse: vi.fn(function (
    this: unknown,
    element: React.ReactElement,
    options: unknown,
  ) {
    capturedElement.element = element;
    capturedElement.options = options as typeof capturedElement.options;
    return { arrayBuffer: async () => new ArrayBuffer(42) };
  }),
}));

// Mock ethers — both JsonRpcProvider + Contract. The Contract instance's
// getProof returns whatever the test sets per case.
const getProofMock = vi.hoisted(() => vi.fn());

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: vi.fn(),
      Contract: vi.fn(function () {
        return { getProof: getProofMock };
      }),
    },
  };
});

vi.mock("../_lib/addresses.js", () => ({
  CONTRACTS_BY_CHAIN: {
    11155111: { PaymentReceipts: "0xE2087A39cEa3C77566DF15936c2750511f808148" },
    84532: { PaymentReceipts: "0x23f0530e107cCF940093c238bbc97EbdAD6fAD7c" },
  },
  RPC_URLS: { 11155111: "https://sepolia", 84532: "https://base-sepolia" },
}));

import handler from "./proof.js";

interface MockRes {
  headers: Record<string, string>;
  statusCode: number;
  body: Buffer | null;
  setHeader(k: string, v: string): void;
  status(s: number): MockRes;
  end(b: Buffer): void;
}

function makeRes(): MockRes {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: Buffer | null = null;
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(s) { statusCode = s; return this; },
    end(b) { body = b; },
  } as MockRes;
}

function makeReq(query: string) {
  return { url: `/api/og/proof${query}` };
}

// Walk a React element tree and concatenate all text-node children
// joined by '|' so distinct text fragments can be asserted individually.
function extractText(el: unknown): string {
  if (el == null) return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  if (Array.isArray(el)) return el.map(extractText).join("|");
  const node = el as { props?: { children?: unknown } };
  if (node.props && "children" in node.props) return extractText(node.props.children);
  return "";
}

beforeEach(() => {
  capturedElement.element = null;
  capturedElement.options = null;
  getProofMock.mockReset();
});

// ─── Variant selection (the 4 branches of the verdict pill) ────────

describe("variant selection", () => {
  it("renders 'Verified on-chain' when proof.isReady && proof.isTrue", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, // $50k in 6-decimal USDC units
      100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=42&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("Verified on-chain");
    expect(text).toContain("✓");
    expect(text).not.toContain("Pending");
    expect(text).not.toContain("Not verified");
  });

  it("renders 'Not verified' when proof.isReady && !proof.isTrue", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n,
      100n, 1700000000n, "income", false, true,
    ]);
    await handler(makeReq("?id=42&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("Not verified");
    expect(text).toContain("✗");
  });

  it("renders 'Pending verification' when !proof.isReady (TN signature not yet published)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n,
      100n, 1700000000n, "income", false, false,
    ]);
    await handler(makeReq("?id=42&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("Pending verification");
    expect(text).toContain("⏳");
  });

  it("renders 'Proof not found' when the contract reverts (unknown proofId)", async () => {
    getProofMock.mockRejectedValue(new Error("PaymentReceipts: proof not found"));
    await handler(makeReq("?id=99999999&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("Proof not found");
    expect(text).toContain("?");
  });
});

// ─── Input validation + defensive defaults ────────────────────────

describe("input validation", () => {
  it("renders 'Proof not found' when id query param is missing entirely", async () => {
    await handler(makeReq(""), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("Proof not found");
    // getProof must NOT have been called when id is absent.
    expect(getProofMock).not.toHaveBeenCalled();
  });

  it("renders 'Proof not found' when id is non-numeric (defensive — never crashes)", async () => {
    await handler(makeReq("?id=abc&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("Proof not found");
    expect(getProofMock).not.toHaveBeenCalled();
  });

  it("defaults to Eth Sepolia chain (11155111) when chain param is missing", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1"), makeRes());
    // Verified path reached -> default chain id resolved Eth Sepolia.
    expect(extractText(capturedElement.element)).toContain("Verified");
  });

  it("treats unsupported chain ids as 'Proof not found' (no RPC, no crash)", async () => {
    await handler(makeReq("?id=1&chain=999999"), makeRes());
    expect(extractText(capturedElement.element)).toContain("Proof not found");
    expect(getProofMock).not.toHaveBeenCalled();
  });
});

// ─── Threshold formatting (USDC 6-decimals -> USD display) ──────────

describe("threshold formatting", () => {
  it("renders $50,000 for 50_000_000_000 raw units (6-decimal scale)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("$50,000");
  });

  it("renders $1,000,000 for 1_000_000_000_000 raw units (large threshold path)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      1_000_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("$1,000,000");
  });

  it("renders $50 with no decimals when threshold is a small whole number", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("$50");
  });
});

// ─── kind discrimination (income vs balance) ──────────────────────

describe("kind discrimination", () => {
  it("'income' kind renders 'Income ≥ $X' headline", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("Income ≥ $50,000");
  });

  it("'balance' kind renders 'Balance ≥ $X' headline", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "balance", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("Balance ≥ $50,000");
  });
});

// ─── Prover address truncation (short form for the OG image) ──────

describe("prover address rendering", () => {
  it("truncates to first-6 + last-4 with ellipsis (0xprove…0000 form)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    // First 6 + ellipsis + last 4 -> "0xprov…0000". Note source uses
    // an actual single-char ellipsis Unicode (…).
    expect(text).toContain("0xprov");
    expect(text).toContain("0000");
    expect(text).toContain("by ");
  });
});

// ─── HTTP response shape + caching ────────────────────────────────

describe("HTTP response shape", () => {
  it("sets Content-Type: image/png", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.headers["content-type"]).toBe("image/png");
  });

  it("sets Cache-Control to 5min public + 24h SWR (immutable published proofs)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
  });

  it("returns status 200", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.statusCode).toBe(200);
  });

  it("writes the PNG bytes via res.end (Node-handler shape)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    const res = makeRes();
    await handler(makeReq("?id=1&chain=11155111"), res);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body!.byteLength).toBe(42);
  });
});

// ─── ImageResponse options ────────────────────────────────────────

describe("@vercel/og ImageResponse options", () => {
  it("renders at 1200x630 (the documented OG image size)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(capturedElement.options?.width).toBe(1200);
    expect(capturedElement.options?.height).toBe(630);
  });

  it("passes the same Cache-Control to ImageResponse headers (framework respects it)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(capturedElement.options?.headers).toMatchObject({
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
    });
  });
});

// ─── Brand surface (always present regardless of variant) ────────

describe("brand surface", () => {
  it("'Blank' brand name always present in the rendered image", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    expect(extractText(capturedElement.element)).toContain("Blank");
  });

  it("FHE-explainer tagline appears below the headline (the 5-second explainer)", async () => {
    getProofMock.mockResolvedValue([
      "0xprover0000000000000000000000000000000000",
      50_000_000_000n, 100n, 1700000000n, "income", true, true,
    ]);
    await handler(makeReq("?id=1&chain=11155111"), makeRes());
    const text = extractText(capturedElement.element);
    expect(text).toContain("comparison run inside FHE");
    expect(text).toContain("Verify on-chain");
  });
});
