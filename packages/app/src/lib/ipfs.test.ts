import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ipfsUrl,
  ipfsFallbackUrl,
  pinFile,
  pinJson,
  fetchFromIpfs,
} from "./ipfs";

// §15.x lib test for the IPFS gateway helpers + JWT-required guard.
// The async pin* functions hit Pinata; we don't test the network
// path here, but we do pin the synchronous fail-fast guard that
// throws when no JWT is configured anywhere (env or arg).

const SAMPLE_CID = "bafybeibwzifw52ttrkqlikfzext5akxu7lz4xiv3a2c2k3rl5wjxtnwndi";

describe("ipfsUrl", () => {
  it("builds a Pinata gateway URL by default", () => {
    expect(ipfsUrl(SAMPLE_CID)).toBe(
      `https://gateway.pinata.cloud/ipfs/${SAMPLE_CID}`,
    );
  });

  it("respects a custom gateway override", () => {
    expect(ipfsUrl(SAMPLE_CID, "https://example.org/ipfs")).toBe(
      `https://example.org/ipfs/${SAMPLE_CID}`,
    );
  });

  it("returns a parseable URL", () => {
    expect(() => new URL(ipfsUrl(SAMPLE_CID))).not.toThrow();
  });
});

describe("ipfsFallbackUrl", () => {
  it("uses the public ipfs.io gateway", () => {
    expect(ipfsFallbackUrl(SAMPLE_CID)).toBe(
      `https://ipfs.io/ipfs/${SAMPLE_CID}`,
    );
  });

  it("returns a parseable URL", () => {
    expect(() => new URL(ipfsFallbackUrl(SAMPLE_CID))).not.toThrow();
  });
});

describe("pinFile / pinJson JWT guard", () => {
  // The test env doesn't set VITE_PINATA_JWT and we don't pass one,
  // so requireJwt throws synchronously before fetch fires. This pins
  // the fail-fast contract: callers without a JWT get a clear error
  // instead of an opaque 401 from Pinata.
  it("pinFile rejects when no JWT is configured", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    await expect(pinFile(blob)).rejects.toThrow(/Pinata JWT missing/);
  });

  it("pinJson rejects when no JWT is configured", async () => {
    await expect(pinJson({ a: 1 })).rejects.toThrow(/Pinata JWT missing/);
  });
});

// §15.x extension: pinFile + pinJson HTTP path coverage + fetchFromIpfs
// fallback semantics. The async path was previously gated only on the
// JWT guard; the request body shape, the Authorization header, the
// error path on non-2xx, and the response-mapping to PinResult had no
// coverage. A regression in any of these would either ship corrupted
// pin payloads OR silently swallow Pinata errors without surfacing.

const SAMPLE_PINATA_RESPONSE = {
  IpfsHash: "bafybeisamplecidhere1234567890abcdef",
  PinSize: 12345,
  Timestamp: "2026-05-14T10:30:00.000Z",
};

const JWT = "test-jwt-token";

function mkResponse(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinFile (Pinata REST happy + error paths)", () => {
  it("posts to /pinning/pinFileToIPFS with Bearer auth + multipart form", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["hello"], { type: "text/plain" });
    await pinFile(blob, { jwt: JWT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: FormData },
    ];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(init).toBeDefined();
    const initObj = init;
    expect(initObj.method).toBe("POST");
    expect(initObj.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(initObj.body).toBeInstanceOf(FormData);
  });

  it("attaches the file under the 'file' field with the optional name", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["bytes"], { type: "application/pdf" });
    await pinFile(blob, { jwt: JWT, name: "invoice-42.pdf" });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: FormData }];
    const file = init.body.get("file");
    expect(file).toBeInstanceOf(File);
    // FormData "file" field name comes from the third arg to append; for
    // a Blob+name combo it's the user-supplied name.
    expect((file as File).name).toBe("invoice-42.pdf");
    // pinataMetadata is sent when name is provided.
    const metaRaw = init.body.get("pinataMetadata");
    expect(typeof metaRaw).toBe("string");
    const parsed = JSON.parse(metaRaw as string);
    expect(parsed.name).toBe("invoice-42.pdf");
  });

  it("uses the default 'upload' filename when no name is provided + omits pinataMetadata", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["raw"], { type: "application/octet-stream" });
    await pinFile(blob, { jwt: JWT });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: FormData }];
    const file = init.body.get("file");
    expect((file as File).name).toBe("upload");
    // No name -> no pinataMetadata field.
    expect(init.body.get("pinataMetadata")).toBeNull();
  });

  it("returns the canonical PinResult shape (cid + size + pinnedAt)", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["x"], { type: "text/plain" });
    const out = await pinFile(blob, { jwt: JWT });
    expect(out).toEqual({
      cid: SAMPLE_PINATA_RESPONSE.IpfsHash,
      size: SAMPLE_PINATA_RESPONSE.PinSize,
      pinnedAt: SAMPLE_PINATA_RESPONSE.Timestamp,
    });
  });

  it("throws with status + body text on non-2xx response (catches Pinata 401 / 5xx loud)", async () => {
    const fetchMock = vi.fn(async () =>
      mkResponse({ ok: false, status: 401, text: "Invalid API key" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["x"], { type: "text/plain" });
    await expect(pinFile(blob, { jwt: JWT })).rejects.toThrow(
      /Pinata pinFile failed \(401\): Invalid API key/,
    );
  });

  it("survives a body.text() throw on the error path (still reports the status)", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        status: 503,
        text: () => Promise.reject(new Error("body read failed")),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["x"], { type: "text/plain" });
    await expect(pinFile(blob, { jwt: JWT })).rejects.toThrow(/503/);
  });
});

describe("pinJson (Pinata REST happy + error paths)", () => {
  it("posts JSON body with pinataContent wrapper + content-type header", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    await pinJson({ payerEmail: "alice@example.com", amount: 100 }, { jwt: JWT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    const initObj = init;
    expect(initObj.method).toBe("POST");
    expect(initObj.headers["Content-Type"]).toBe("application/json");
    expect(initObj.headers.Authorization).toBe(`Bearer ${JWT}`);
    const parsed = JSON.parse(initObj.body);
    expect(parsed.pinataContent).toEqual({ payerEmail: "alice@example.com", amount: 100 });
  });

  it("includes pinataMetadata.name when options.name is provided", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    await pinJson({ x: 1 }, { jwt: JWT, name: "invoice-meta" });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.pinataMetadata).toEqual({ name: "invoice-meta" });
  });

  it("omits pinataMetadata when no name is provided (don't ship empty metadata field)", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    await pinJson({ x: 1 }, { jwt: JWT });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.pinataMetadata).toBeUndefined();
  });

  it("returns the canonical PinResult shape", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ json: SAMPLE_PINATA_RESPONSE }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await pinJson({ x: 1 }, { jwt: JWT });
    expect(out).toEqual({
      cid: SAMPLE_PINATA_RESPONSE.IpfsHash,
      size: SAMPLE_PINATA_RESPONSE.PinSize,
      pinnedAt: SAMPLE_PINATA_RESPONSE.Timestamp,
    });
  });

  it("throws with status + body text on non-2xx response", async () => {
    const fetchMock = vi.fn(async () =>
      mkResponse({ ok: false, status: 500, text: "internal server error" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(pinJson({ x: 1 }, { jwt: JWT })).rejects.toThrow(
      /Pinata pinJson failed \(500\): internal server error/,
    );
  });
});

describe("fetchFromIpfs (gateway with fallback)", () => {
  it("returns the primary gateway response when it succeeds", async () => {
    const primary = mkResponse({ ok: true, status: 200 });
    const fetchMock = vi.fn(async () => primary);
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFromIpfs("bafybeitest");
    expect(out).toBe(primary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [primaryUrl] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(primaryUrl).toBe("https://gateway.pinata.cloud/ipfs/bafybeitest");
  });

  it("falls back to ipfs.io when primary returns non-2xx (e.g. unpinned)", async () => {
    const primary = mkResponse({ ok: false, status: 404 });
    const fallback = mkResponse({ ok: true, status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(fallback);
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFromIpfs("bafybeitest");
    expect(out).toBe(fallback);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = fetchMock.mock.calls[1]! as unknown as [string];
    expect(fallbackUrl).toBe("https://ipfs.io/ipfs/bafybeitest");
  });

  it("falls back to ipfs.io when primary fetch throws (Pinata gateway DOWN scenario)", async () => {
    const fallback = mkResponse({ ok: true, status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockResolvedValueOnce(fallback);
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFromIpfs("bafybeitest");
    expect(out).toBe(fallback);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the fallback response even when it ALSO fails (caller handles the failed response)", async () => {
    // The function intentionally does NOT throw on cascading failure;
    // the caller inspects the returned Response.ok to decide. This
    // shape is documented and any regression that started throwing
    // would break callers that expect to inspect the failed response.
    const primary = mkResponse({ ok: false, status: 404 });
    const failedFallback = mkResponse({ ok: false, status: 503 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(failedFallback);
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFromIpfs("bafybeitest");
    expect(out).toBe(failedFallback);
    expect(out.ok).toBe(false);
  });
});
