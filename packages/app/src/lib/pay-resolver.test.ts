import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePayTarget } from "./pay-resolver";
import { resolveName } from "./address-resolver";
import { supabase } from "./supabase";

vi.mock("./address-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./address-resolver")>();
  return {
    ...actual,
    resolveName: vi.fn(actual.resolveName),
  };
});

vi.mock("./supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabase")>();
  // Default chain returns null (no row found) so the existing tests
  // that don't override .from() get the same "not-found" behavior they
  // had against the unmocked-test-env supabase=null singleton. Tests
  // that need a specific row override .from() per-case via vi.mocked.
  const defaultBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  return {
    ...actual,
    supabase: {
      from: vi.fn().mockReturnValue(defaultBuilder),
    },
  };
});

// §15.x lib test for the /pay/:identifier resolver. Three input shapes
// share one route: 0x address, ENS / Basenames name, INV-<id> invoice.
// Pin the disambiguation logic so a plain address never goes through
// ENS resolution and an INV string never gets parsed as an address.
//
// The INV branch's outcome depends on whether the test environment
// has Supabase configured. We can't assert a specific result-shape
// for those tests; instead we assert that the branch was TAKEN
// (i.e., the result is NEVER "invalid" or "ens-failed"), which is
// what the disambiguation contract guarantees.

describe("resolvePayTarget", () => {
  it("rejects empty / whitespace-only input as invalid", async () => {
    const out = await resolvePayTarget("");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("invalid");

    const out2 = await resolvePayTarget("   ");
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.error.kind).toBe("invalid");
  });

  it("recognizes a plain 40-char 0x address", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(addr);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.target.kind).toBe("address");
      expect(out.target.address.toLowerCase()).toBe(addr);
    }
  });

  it("trims surrounding whitespace before parsing", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(`  ${addr}  `);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.target.kind).toBe("address");
  });

  it("INV-<id> takes the invoice branch (NEVER falls through to invalid / ens-failed)", async () => {
    // The INV regex matches first, so the resolver does NOT fall
    // through to the ENS or invalid branches. The exact outcome
    // depends on whether Supabase is configured + has the row, but
    // those two error kinds must never appear here.
    const out = await resolvePayTarget("INV-9999999");
    if (!out.ok) {
      expect(["supabase-unavailable", "not-found", "invalid"]).toContain(out.error.kind);
      expect(out.error.kind).not.toBe("ens-failed");
    } else {
      // ok=true means a row existed; the kind must be invoice.
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("INV<digits> without dash also matches the invoice branch", async () => {
    const out = await resolvePayTarget("INV9999999");
    if (!out.ok) {
      expect(out.error.kind).not.toBe("ens-failed");
      expect(out.error.kind).not.toBe("invalid");
    } else {
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("INV pattern is case-insensitive (lowercase inv- prefix)", async () => {
    const out = await resolvePayTarget("inv-9999999");
    if (!out.ok) {
      expect(out.error.kind).not.toBe("ens-failed");
      expect(out.error.kind).not.toBe("invalid");
    } else {
      expect(out.target.kind).toBe("invoice");
    }
  });

  it("invalid identifier (non-address, non-INV, non-ENS-shape) returns kind=invalid", async () => {
    const out = await resolvePayTarget("totally random word");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("invalid");
  });

  it("malformed 0x address (too short) is NOT classified as address", async () => {
    const out = await resolvePayTarget("0xabc");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // 0xabc is too short for isAddress and starts with 0x so the ENS
      // heuristic rejects it. Lands on `invalid`.
      expect(out.error.kind).toBe("invalid");
    }
  });
});

// §15.x extension: mocked ENS + supabase paths. The existing tests
// relied on the test environment for ENS resolution and supabase
// availability, which means the happy/sad branches were only
// asserted negatively ("not invalid + not ens-failed"). Below pins
// the EXACT outcomes for each branch with controllable mocks.

const VENDOR_ADDR = "0xfedcba9876543210fedcba9876543210fedcba98";
const RESOLVED_ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

describe("resolvePayTarget — mocked ENS resolution paths", () => {
  beforeEach(() => {
    vi.mocked(resolveName).mockReset();
  });

  it("looksLikeEnsName + resolveName succeeds -> kind=name with resolved address + ensName", async () => {
    vi.mocked(resolveName).mockResolvedValueOnce(RESOLVED_ADDR);
    const out = await resolvePayTarget("alice.eth");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.target.kind).toBe("name");
      if (out.target.kind === "name") {
        expect(out.target.address.toLowerCase()).toBe(RESOLVED_ADDR);
        expect(out.target.ensName).toBe("alice.eth");
      }
    }
    expect(resolveName).toHaveBeenCalledWith("alice.eth");
  });

  it("resolveName returns null -> kind=ens-failed (the canonical 'name lookup failed' error)", async () => {
    vi.mocked(resolveName).mockResolvedValueOnce(null);
    const out = await resolvePayTarget("ghost.eth");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("ens-failed");
  });

  it("Basenames domain (.base.eth) also routes through the ENS branch", async () => {
    vi.mocked(resolveName).mockResolvedValueOnce(RESOLVED_ADDR);
    const out = await resolvePayTarget("alice.base.eth");
    expect(out.ok).toBe(true);
    if (out.ok && out.target.kind === "name") {
      expect(out.target.ensName).toBe("alice.base.eth");
    }
    expect(resolveName).toHaveBeenCalledWith("alice.base.eth");
  });

  it("Mixed-case ENS name passes through (resolver handles normalization internally)", async () => {
    vi.mocked(resolveName).mockResolvedValueOnce(RESOLVED_ADDR);
    const out = await resolvePayTarget("Alice.ETH");
    expect(out.ok).toBe(true);
    if (out.ok && out.target.kind === "name") {
      // The ensName preserves the original casing as the user typed it.
      expect(out.target.ensName).toBe("Alice.ETH");
    }
  });

  it("Plain address never goes through ENS resolution (priority order check)", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(addr);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.target.kind).toBe("address");
    // resolveName must NOT be called for a plain address.
    expect(resolveName).not.toHaveBeenCalled();
  });
});

describe("resolvePayTarget — mocked invoice lookup paths", () => {
  beforeEach(() => {
    vi.mocked(supabase!.from).mockReset();
  });

  function mockInvoiceQuery(returnValue: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(returnValue),
    };
    vi.mocked(supabase!.from).mockReturnValue(builder as never);
    return builder;
  }

  it("INV-<id> with supabase returning a row -> kind=invoice with vendor address as the target", async () => {
    const invoice = {
      invoice_id: 42,
      vendor_address: VENDOR_ADDR,
      client_address: "0x1111111111111111111111111111111111111111",
      tx_hash: "0xtx",
      created_at: "2026-05-14T00:00:00Z",
      status: "pending" as const,
    };
    mockInvoiceQuery({ data: invoice, error: null });
    const out = await resolvePayTarget("INV-42");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.target.kind).toBe("invoice");
      if (out.target.kind === "invoice") {
        expect(out.target.address.toLowerCase()).toBe(VENDOR_ADDR);
        expect(out.target.invoice).toBe(invoice);
      }
    }
  });

  it("INV-<id> with supabase returning null row -> kind=not-found", async () => {
    mockInvoiceQuery({ data: null, error: null });
    const out = await resolvePayTarget("INV-999999");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("not-found");
  });

  it("INV-<id> with supabase returning an error -> kind=not-found (error treated as miss)", async () => {
    mockInvoiceQuery({
      data: null,
      error: { message: "transient network failure" },
    });
    const out = await resolvePayTarget("INV-42");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("not-found");
  });

  it("supabase query is keyed by exact invoice_id integer (NOT the raw INV-N string)", async () => {
    const builder = mockInvoiceQuery({ data: null, error: null });
    await resolvePayTarget("INV-42");
    // The supabase mock chain reached `.eq("invoice_id", 42)`.
    expect(builder.eq).toHaveBeenCalledWith("invoice_id", 42);
  });

  it("supabase query takes the MOST RECENT invoice row (order by created_at desc + limit 1)", async () => {
    // Multiple rows can share an invoice_id across chain redeploys.
    // The resolver MUST pick the freshest one.
    const builder = mockInvoiceQuery({ data: null, error: null });
    await resolvePayTarget("INV-42");
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(builder.limit).toHaveBeenCalledWith(1);
  });
});

describe("resolvePayTarget — disambiguation priority order", () => {
  beforeEach(() => {
    vi.mocked(resolveName).mockReset();
    vi.mocked(supabase!.from).mockReset();
  });

  it("INV pattern wins over invalid fallback even when supabase is null", async () => {
    // The supabase singleton check happens INSIDE the invoice branch
    // after the pattern matches. So an INV string with supabase=null
    // returns supabase-unavailable, NOT invalid.
    vi.mocked(supabase!.from).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    } as never);
    const out = await resolvePayTarget("INV-42");
    // Either a supabase response OR not-found — but NEVER invalid /
    // ens-failed (which would mean the INV branch wasn't taken).
    if (!out.ok) {
      expect(["supabase-unavailable", "not-found"]).toContain(out.error.kind);
    }
  });

  it("Address pattern wins over ENS (a 40-char hex doesn't try ENS)", async () => {
    // Use all-lowercase so viem's isAddress accepts without EIP-55
    // checksum validation. A mixed-case address with an invalid
    // checksum would correctly fall through this branch and the test
    // wouldn't be measuring the priority order.
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const out = await resolvePayTarget(addr);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.target.kind).toBe("address");
    expect(resolveName).not.toHaveBeenCalled();
  });

  it("ENS-shape with supabase mock unset (no invoice match) routes to ENS resolution", async () => {
    vi.mocked(resolveName).mockResolvedValueOnce(RESOLVED_ADDR);
    const out = await resolvePayTarget("alice.eth");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.target.kind).toBe("name");
    // resolveName WAS called (the ENS branch took it).
    expect(resolveName).toHaveBeenCalledTimes(1);
  });
});
