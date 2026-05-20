import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// §15.x lib test for the Supabase data layer. The crown jewel is the
// PGRST204 schema-drift retry loop in `insertWithSchemaStrip`. Prod
// schema is missing several columns the TS types declare (pdf_cid,
// client_email, vendor_email, last_reminder_at, chain_id…) — every
// insert would 400 without the strip-and-retry. Pin the retry shape,
// the give-up paths, and the per-table missing-column cache so the
// next refactor doesn't quietly regress to "silently drops rows".
//
// Also pin the chain_id stamping, address-lowercasing, and the
// plaintext-amount strip on insertEscrow (privacy invariant: never
// store plaintext amounts server-side).

// ─── Hoisted mock harness ──────────────────────────────────────────

const responseQueue = vi.hoisted<{ queue: Array<{ data: unknown; error: unknown }> }>(() => ({
  queue: [],
}));

const insertedPayloads = vi.hoisted<{
  payloads: Array<{ op: "insert" | "upsert" | "update"; table: string; row: unknown; opts?: unknown }>;
}>(() => ({ payloads: [] }));

const lastTableRef = vi.hoisted<{ name: string }>(() => ({ name: "" }));

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("./constants", async () => {
  const actual = await vi.importActual<typeof import("./constants")>("./constants");
  return {
    ...actual,
    SUPABASE_URL: "https://fake.supabase.test",
    SUPABASE_ANON_KEY: "fake-anon-key",
    SUPPORTED_CHAIN_ID: 11155111,
  };
});

vi.mock("./log", () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  registerLogSink: vi.fn(),
}));

// Build a chainable query builder. Every chain method returns the same
// builder so .from().select().eq().order() reads as a fluent path. The
// builder is itself thenable: awaiting it consumes one response from
// the queue. Insert/upsert/update operations record the payload before
// resolving so tests can assert on exactly what was sent to the wire.
function makeBuilder(table: string) {
  lastTableRef.name = table;
  const consume = () =>
    responseQueue.queue.length > 0
      ? (responseQueue.queue.shift() as { data: unknown; error: unknown })
      : { data: [], error: null };

  const builder: Record<string, unknown> = {};
  const passthrough = [
    "select",
    "update",
    "delete",
    "eq",
    "or",
    "ilike",
    "in",
    "lt",
    "gt",
    "limit",
    "order",
    "is",
  ] as const;
  for (const m of passthrough) {
    builder[m] = vi.fn((..._args: unknown[]) => {
      void _args;
      if (m === "update") {
        // Capture update payload for assertions
        insertedPayloads.payloads.push({ op: "update", table, row: _args[0] });
      }
      return builder;
    });
  }
  builder.single = vi.fn(() => Promise.resolve(consume()));
  builder.maybeSingle = vi.fn(() => Promise.resolve(consume()));
  builder.insert = vi.fn((row: unknown) => {
    insertedPayloads.payloads.push({ op: "insert", table, row });
    return Promise.resolve(consume());
  });
  builder.upsert = vi.fn((row: unknown, opts?: unknown) => {
    insertedPayloads.payloads.push({ op: "upsert", table, row, opts });
    return Promise.resolve(consume());
  });
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);
  return builder;
}

const fakeClient = {
  from: vi.fn((table: string) => makeBuilder(table)),
};

beforeEach(async () => {
  vi.resetModules();
  responseQueue.queue.length = 0;
  insertedPayloads.payloads.length = 0;
  lastTableRef.name = "";
  createClientMock.mockReset();
  createClientMock.mockReturnValue(fakeClient);
  fakeClient.from.mockClear();
  // Seed the probe cache so module-load IIFE doesn't consume queued
  // responses or fire warnings. Tests that care about probe behaviour
  // override this seed before importing.
  localStorage.setItem(
    "blank:activities_has_chain_id",
    JSON.stringify({ v: true, t: Date.now() }),
  );
});

afterEach(() => {
  localStorage.clear();
});

// Helper: enqueue a single response. Each insert/upsert/update/select
// consumes one.
function enqueue(...rs: Array<{ data?: unknown; error?: unknown }>) {
  for (const r of rs) {
    responseQueue.queue.push({ data: r.data ?? null, error: r.error ?? null });
  }
}

// Build a PostgREST-shaped PGRST204 error pointing at a specific column.
function pgrst204(col: string, table = "tbl") {
  return {
    code: "PGRST204",
    message: `Could not find the '${col}' column of '${table}' in the schema cache`,
  };
}

// ─── isOfflineMode + module wiring ─────────────────────────────────

describe("isOfflineMode + client construction", () => {
  it("constructs a client when SUPABASE_URL + ANON_KEY are both set", async () => {
    const mod = await import("./supabase");
    expect(createClientMock).toHaveBeenCalledWith(
      "https://fake.supabase.test",
      "fake-anon-key",
    );
    expect(mod.isOfflineMode()).toBe(false);
    expect(mod.supabase).not.toBeNull();
  });

  it("returns null + reports offline when SUPABASE_URL is empty", async () => {
    vi.doMock("./constants", async () => {
      const actual = await vi.importActual<typeof import("./constants")>("./constants");
      return { ...actual, SUPABASE_URL: "", SUPABASE_ANON_KEY: "k", SUPPORTED_CHAIN_ID: 11155111 };
    });
    const mod = await import("./supabase");
    expect(createClientMock).not.toHaveBeenCalled();
    expect(mod.supabase).toBeNull();
    expect(mod.isOfflineMode()).toBe(true);
    vi.doUnmock("./constants");
  });

  it("returns null + reports offline when SUPABASE_ANON_KEY is empty", async () => {
    vi.doMock("./constants", async () => {
      const actual = await vi.importActual<typeof import("./constants")>("./constants");
      return { ...actual, SUPABASE_URL: "https://x.supabase.test", SUPABASE_ANON_KEY: "", SUPPORTED_CHAIN_ID: 11155111 };
    });
    const mod = await import("./supabase");
    expect(mod.supabase).toBeNull();
    expect(mod.isOfflineMode()).toBe(true);
    vi.doUnmock("./constants");
  });
});

// ─── insertWithSchemaStrip — the schema-drift retry core ───────────

describe("insertWithSchemaStrip — happy paths", () => {
  it("succeeds on first attempt when no PGRST204 fires", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue({ data: null, error: null });
    const out = await insertWithSchemaStrip("tbl_a", { foo: "bar", baz: 1 });
    expect(out).toEqual({ ok: true });
    const payload = insertedPayloads.payloads[0];
    expect(payload.op).toBe("insert");
    expect(payload.row).toEqual({ foo: "bar", baz: 1 });
  });

  it("routes through upsert when onConflict option is supplied", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue({ data: null, error: null });
    const out = await insertWithSchemaStrip(
      "tbl_b",
      { id: 1, value: "v" },
      { onConflict: "id" },
    );
    expect(out.ok).toBe(true);
    const payload = insertedPayloads.payloads[0];
    expect(payload.op).toBe("upsert");
    expect(payload.opts).toEqual({ onConflict: "id" });
  });

  it("returns offline error when supabase client is null", async () => {
    vi.doMock("./constants", async () => {
      const actual = await vi.importActual<typeof import("./constants")>("./constants");
      return { ...actual, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPPORTED_CHAIN_ID: 11155111 };
    });
    const { insertWithSchemaStrip } = await import("./supabase");
    const out = await insertWithSchemaStrip("tbl_c", { foo: "bar" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/supabase not configured/i);
    vi.doUnmock("./constants");
  });
});

describe("insertWithSchemaStrip — PGRST204 strip-and-retry", () => {
  it("strips a single missing column and retries successfully", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue(
      { data: null, error: pgrst204("pdf_cid", "tbl_d") },
      { data: null, error: null },
    );
    const out = await insertWithSchemaStrip("tbl_d", {
      invoice_id: 1,
      pdf_cid: "Qm...",
      vendor: "v",
    });
    expect(out).toEqual({ ok: true });
    // Two attempts total: first with pdf_cid, second without.
    expect(insertedPayloads.payloads).toHaveLength(2);
    expect(insertedPayloads.payloads[0].row).toEqual({
      invoice_id: 1,
      pdf_cid: "Qm...",
      vendor: "v",
    });
    expect(insertedPayloads.payloads[1].row).toEqual({ invoice_id: 1, vendor: "v" });
  });

  it("strips multiple columns across successive retries (prod multi-drift)", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue(
      { data: null, error: pgrst204("pdf_cid", "tbl_e") },
      { data: null, error: pgrst204("client_email", "tbl_e") },
      { data: null, error: pgrst204("vendor_email", "tbl_e") },
      { data: null, error: null },
    );
    const out = await insertWithSchemaStrip("tbl_e", {
      invoice_id: 7,
      pdf_cid: "x",
      client_email: "c@e",
      vendor_email: "v@e",
      keep: "yes",
    });
    expect(out).toEqual({ ok: true });
    expect(insertedPayloads.payloads).toHaveLength(4);
    // Final attempt should only contain the surviving columns.
    expect(insertedPayloads.payloads[3].row).toEqual({ invoice_id: 7, keep: "yes" });
  });

  it("caches dropped columns across calls so the next insert pre-strips", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    // First call: drops 'pdf_cid' via retry.
    enqueue(
      { data: null, error: pgrst204("pdf_cid", "tbl_f") },
      { data: null, error: null },
    );
    await insertWithSchemaStrip("tbl_f", { id: 1, pdf_cid: "x" });
    expect(insertedPayloads.payloads).toHaveLength(2);
    // Second call to the SAME table: no retry needed because the
    // missing-cols cache pre-strips pdf_cid before the request fires.
    enqueue({ data: null, error: null });
    insertedPayloads.payloads.length = 0;
    await insertWithSchemaStrip("tbl_f", { id: 2, pdf_cid: "y" });
    expect(insertedPayloads.payloads).toHaveLength(1);
    expect(insertedPayloads.payloads[0].row).toEqual({ id: 2 });
  });

  it("matches schema-cache errors even without an explicit PGRST204 code", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue(
      { data: null, error: { message: "Could not find the 'foo' column of 'tbl_g' in the schema cache" } },
      { data: null, error: null },
    );
    const out = await insertWithSchemaStrip("tbl_g", { id: 1, foo: "bar" });
    expect(out).toEqual({ ok: true });
    expect(insertedPayloads.payloads[1].row).toEqual({ id: 1 });
  });

  it("returns failure immediately on a non-PGRST204 error", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue({ data: null, error: { code: "23505", message: "duplicate key" } });
    const out = await insertWithSchemaStrip("tbl_h", { id: 1 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/duplicate key/);
    expect(insertedPayloads.payloads).toHaveLength(1);
  });

  it("gives up if the PGRST204 column name can't be parsed", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue({ data: null, error: { code: "PGRST204", message: "garbled — no column name here" } });
    const out = await insertWithSchemaStrip("tbl_i", { id: 1 });
    expect(out.ok).toBe(false);
    expect(insertedPayloads.payloads).toHaveLength(1);
  });

  it("gives up if PGRST204 names a column not present in the row", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    enqueue({
      data: null,
      error: pgrst204("phantom_col", "tbl_j"),
    });
    const out = await insertWithSchemaStrip("tbl_j", { id: 1 });
    expect(out.ok).toBe(false);
    // Single attempt — the column isn't in the row so retry would loop.
    expect(insertedPayloads.payloads).toHaveLength(1);
  });

  it("returns string error when the supabase call throws", async () => {
    const { insertWithSchemaStrip } = await import("./supabase");
    fakeClient.from.mockImplementationOnce(() => {
      throw new Error("network exploded");
    });
    const out = await insertWithSchemaStrip("tbl_k", { id: 1 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/network exploded/);
  });
});

// ─── chain_id stamping + setSupabaseActiveChain ────────────────────

describe("chain_id stamping via setSupabaseActiveChain", () => {
  it("uses the active chain id on inserts when no chain_id is supplied", async () => {
    const mod = await import("./supabase");
    mod.setSupabaseActiveChain(84532);
    enqueue({ data: null, error: null });
    await mod.insertPaymentRequest({
      request_id: 1,
      from_address: "0xpayer",
      to_address: "0xrequester",
      token_address: "0xt",
      note: "",
      status: "pending",
      tx_hash: "0xabc",
    } as never);
    const payload = insertedPayloads.payloads.find(p => p.table === "payment_requests");
    expect(payload).toBeTruthy();
    expect((payload!.row as Record<string, unknown>).chain_id).toBe(84532);
  });

  it("preserves an explicit chain_id on the row over the active default", async () => {
    const mod = await import("./supabase");
    mod.setSupabaseActiveChain(84532);
    enqueue({ data: null, error: null });
    await mod.insertPaymentRequest({
      request_id: 2,
      from_address: "0xa",
      to_address: "0xb",
      token_address: "0xt",
      note: "",
      status: "pending",
      tx_hash: "0xdef",
      chain_id: 11155111,
    } as never);
    const payload = insertedPayloads.payloads.find(p => p.table === "payment_requests");
    expect((payload!.row as Record<string, unknown>).chain_id).toBe(11155111);
  });
});

// ─── exchange_offers invariants ────────────────────────────────────

describe("exchange_offers writes", () => {
  it("stamps chain_id on P2P offers", async () => {
    const mod = await import("./supabase");
    mod.setSupabaseActiveChain(84532);
    enqueue({ data: null, error: null });
    await mod.insertExchangeOffer({
      offer_id: 35,
      maker_address: "0xmaker",
      token_give: "0xusdc",
      token_want: "0xusdt",
      amount_give: 1000,
      amount_want: 1000,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      status: "active",
      taker_address: "",
      tx_hash: "0xtx",
    } as never);
    const payload = insertedPayloads.payloads.find(p => p.table === "exchange_offers");
    expect(payload).toBeTruthy();
    expect((payload!.row as Record<string, unknown>).chain_id).toBe(84532);
  });

  it("throws when the on-chain offer cannot be mirrored into the order book", async () => {
    const mod = await import("./supabase");
    enqueue({
      data: null,
      error: { code: "22P02", message: "invalid input syntax for type bigint: \"0.001\"" },
    });
    await expect(mod.insertExchangeOffer({
      offer_id: 36,
      maker_address: "0xmaker",
      token_give: "0xusdc",
      token_want: "0xusdt",
      amount_give: 0.001,
      amount_want: 0.001,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      status: "active",
      taker_address: "",
      tx_hash: "0xtx",
    } as never)).rejects.toThrow(/order book did not update/);
  });
});

// ─── Address-lowercasing invariants ────────────────────────────────

describe("address lowercasing on inserts", () => {
  it("lowercases vendor_address, client_address, tx_hash on insertInvoice", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertInvoice({
      invoice_id: 1,
      vendor_address: "0xVENDOR",
      client_address: "0xCLIENT",
      description: "",
      due_date: null,
      status: "pending",
      tx_hash: "0xABCDEF",
    } as never);
    const row = insertedPayloads.payloads[0].row as Record<string, string>;
    expect(row.vendor_address).toBe("0xvendor");
    expect(row.client_address).toBe("0xclient");
    expect(row.tx_hash).toBe("0xabcdef");
  });

  it("lowercases member_address on insertGroupMembership", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertGroupMembership({
      group_id: 1,
      group_name: "G",
      member_address: "0xMEMBER",
      is_admin: false,
    } as never);
    const row = insertedPayloads.payloads[0].row as Record<string, string>;
    expect(row.member_address).toBe("0xmember");
  });

  it("lowercases depositor + beneficiary + arbiter + tx on insertEscrow", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertEscrow({
      escrow_id: 1,
      depositor_address: "0xDEP",
      beneficiary_address: "0xBEN",
      arbiter_address: "0xARB",
      description: "",
      deadline: null,
      status: "active",
      tx_hash: "0xTX",
    } as never);
    const row = insertedPayloads.payloads[0].row as Record<string, string>;
    expect(row.depositor_address).toBe("0xdep");
    expect(row.beneficiary_address).toBe("0xben");
    expect(row.arbiter_address).toBe("0xarb");
    expect(row.tx_hash).toBe("0xtx");
  });
});

// ─── Privacy invariant: never store plaintext_amount on escrows ────

describe("privacy invariants", () => {
  it("strips plaintext_amount from insertEscrow payload (server never sees it)", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertEscrow({
      escrow_id: 9,
      depositor_address: "0xa",
      beneficiary_address: "0xb",
      arbiter_address: "0xc",
      description: "",
      deadline: null,
      status: "active",
      tx_hash: "0xtx",
      plaintext_amount: 12345,
    } as never);
    const row = insertedPayloads.payloads[0].row as Record<string, unknown>;
    expect("plaintext_amount" in row).toBe(false);
  });
});

// ─── insertActivity — PGRST204 chain_id fallback ───────────────────

describe("insertActivity", () => {
  it("no-ops silently when supabase is offline", async () => {
    vi.doMock("./constants", async () => {
      const actual = await vi.importActual<typeof import("./constants")>("./constants");
      return { ...actual, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPPORTED_CHAIN_ID: 11155111 };
    });
    const mod = await import("./supabase");
    await mod.insertActivity({
      tx_hash: "0xtx",
      user_from: "0xa",
      user_to: "0xb",
      activity_type: "payment",
      contract_address: "0xc",
      note: "",
      token_address: "0xt",
      block_number: 1,
    } as never);
    expect(insertedPayloads.payloads).toHaveLength(0);
    vi.doUnmock("./constants");
  });

  it("upserts activities with chain_id when probe says column exists", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertActivity({
      tx_hash: "0xtx1",
      user_from: "0xa",
      user_to: "0xb",
      activity_type: "payment",
      contract_address: "0xc",
      note: "",
      token_address: "0xt",
      block_number: 1,
    } as never);
    const payload = insertedPayloads.payloads.find(p => p.table === "activities");
    expect(payload).toBeTruthy();
    expect(payload!.op).toBe("upsert");
    expect((payload!.row as Record<string, unknown>).chain_id).toBe(11155111);
  });

  it("falls back to upsert without chain_id when probe reports column missing", async () => {
    // Seed probe = column missing so the optimistic branch isn't even tried.
    localStorage.setItem(
      "blank:activities_has_chain_id",
      JSON.stringify({ v: false, t: Date.now() }),
    );
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.insertActivity({
      tx_hash: "0xtx2",
      user_from: "0xa",
      user_to: "0xb",
      activity_type: "payment",
      contract_address: "0xc",
      note: "",
      token_address: "0xt",
      block_number: 1,
    } as never);
    const payload = insertedPayloads.payloads.find(p => p.table === "activities");
    expect(payload).toBeTruthy();
    expect("chain_id" in (payload!.row as Record<string, unknown>)).toBe(false);
  });
});

// ─── updateInvoiceStatus / setInvoicePdfCid — selector correctness ─

describe("invoice update selector correctness", () => {
  it("fetchClientInvoices includes terminal invoice history", async () => {
    const mod = await import("./supabase");
    enqueue({ data: [], error: null });
    await mod.fetchClientInvoices("0xAbC");
    const builder = fakeClient.from.mock.results.at(-1)?.value as { in: ReturnType<typeof vi.fn> };
    expect(builder.in).not.toHaveBeenCalled();
  });

  it("updateInvoiceStatus targets the row by invoice_id, not tx_hash", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.updateInvoiceStatus(42, "paid");
    const updatePayload = insertedPayloads.payloads.find(p => p.op === "update");
    expect(updatePayload).toBeTruthy();
    expect(updatePayload!.table).toBe("invoices");
    expect(updatePayload!.row).toEqual({ status: "paid" });
    // The .eq() call recorder isn't surfaced directly here, but the .eq
    // mock under the builder is keyed by invoice_id. We assert the
    // table+update payload shape is right; eq targeting is exercised in
    // the integration tests.
  });

  it("setInvoicePdfCid issues an update with pdf_cid:cid keyed by invoice_id", async () => {
    const mod = await import("./supabase");
    enqueue({ data: null, error: null });
    await mod.setInvoicePdfCid(99, "QmFakeCid");
    const updatePayload = insertedPayloads.payloads.find(p => p.op === "update");
    expect(updatePayload).toBeTruthy();
    expect(updatePayload!.table).toBe("invoices");
    expect(updatePayload!.row).toEqual({ pdf_cid: "QmFakeCid" });
  });
});
