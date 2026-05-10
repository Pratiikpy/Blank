import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set env BEFORE importing the SUT — module reads env at load time.
beforeEach(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ __mock: "supabase-admin-client" })),
}));

describe("getSupabaseAdmin", () => {
  it("returns the same instance on repeated calls (singleton)", async () => {
    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    const a = getSupabaseAdmin();
    const b = getSupabaseAdmin();
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("calls createClient exactly once across N invocations", async () => {
    const supabase = await import("@supabase/supabase-js");
    const createClientMock = supabase.createClient as unknown as ReturnType<typeof vi.fn>;
    createClientMock.mockClear();

    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    getSupabaseAdmin();
    getSupabaseAdmin();
    getSupabaseAdmin();
    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it("passes persistSession=false (server-side, no cookies)", async () => {
    const supabase = await import("@supabase/supabase-js");
    const createClientMock = supabase.createClient as unknown as ReturnType<typeof vi.fn>;
    createClientMock.mockClear();

    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    getSupabaseAdmin();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://test.supabase.co",
      "service-role-test-key",
      { auth: { persistSession: false } },
    );
  });

  it("returns null when SUPABASE_URL is unset (graceful degradation)", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    vi.resetModules();
    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    expect(getSupabaseAdmin()).toBeNull();
  });

  it("returns null when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.resetModules();
    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    expect(getSupabaseAdmin()).toBeNull();
  });

  it("falls back to VITE_SUPABASE_URL when SUPABASE_URL is unset", async () => {
    delete process.env.SUPABASE_URL;
    process.env.VITE_SUPABASE_URL = "https://vite-fallback.supabase.co";
    vi.resetModules();
    const supabase = await import("@supabase/supabase-js");
    const createClientMock = supabase.createClient as unknown as ReturnType<typeof vi.fn>;
    createClientMock.mockClear();

    const { getSupabaseAdmin } = await import("./supabase-admin.js");
    const out = getSupabaseAdmin();
    expect(out).not.toBeNull();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://vite-fallback.supabase.co",
      "service-role-test-key",
      { auth: { persistSession: false } },
    );

    delete process.env.VITE_SUPABASE_URL;
  });
});
