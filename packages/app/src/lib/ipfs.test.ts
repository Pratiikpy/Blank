import { describe, it, expect } from "vitest";
import { ipfsUrl, ipfsFallbackUrl, pinFile, pinJson } from "./ipfs";

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
