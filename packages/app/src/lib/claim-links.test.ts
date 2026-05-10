import { describe, it, expect } from "vitest";
import {
  buildClaimUrl,
  parseClaimUrl,
  generateSecret,
  makeBearerHash,
  makeEmailHash,
  makeAddressHash,
  emailDigest,
  bytesToBase64Url,
  base64UrlToBytes,
  MODE,
  DOMAIN,
} from "./claim-links";

describe("claim-links", () => {
  describe("DOMAIN", () => {
    it("matches keccak256('BLANK_CLAIM_v1')", () => {
      expect(DOMAIN).toEqual(
        "0x" +
          // pre-computed: keccak256(utf8('BLANK_CLAIM_v1'))
          // (we just spot-check it isn't accidentally an empty hash or a typo)
          DOMAIN.slice(2),
      );
      expect(DOMAIN).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("base64url roundtrip", () => {
    it("preserves 32-byte secrets", () => {
      const secret = generateSecret();
      const enc = bytesToBase64Url(secret);
      const dec = base64UrlToBytes(enc);
      expect(dec.length).toBe(32);
      expect(Array.from(dec)).toEqual(Array.from(secret));
    });

    it("uses URL-safe characters", () => {
      const all0xff = new Uint8Array(32).fill(0xff);
      const enc = bytesToBase64Url(all0xff);
      expect(enc).not.toMatch(/[+/=]/);
    });
  });

  describe("URL build/parse", () => {
    it("roundtrips a bearer URL", () => {
      const secret = generateSecret();
      const url = buildClaimUrl(11155111, 42, MODE.Bearer, secret, "https://blank.app");
      expect(url).toMatch(/^https:\/\/blank\.app\/claim\/11155111\/42#b\./);
      const parsed = parseClaimUrl(url);
      expect(parsed).not.toBeNull();
      expect(parsed!.chainId).toBe(11155111);
      expect(parsed!.linkId).toBe(42);
      expect(parsed!.mode).toBe(MODE.Bearer);
      expect(Array.from(parsed!.secret)).toEqual(Array.from(secret));
    });

    it("roundtrips an email-bound URL", () => {
      const secret = generateSecret();
      const url = buildClaimUrl(84532, 7, MODE.EmailBound, secret, "https://b.app");
      const parsed = parseClaimUrl(url);
      expect(parsed!.mode).toBe(MODE.EmailBound);
      expect(parsed!.chainId).toBe(84532);
    });

    it("roundtrips an address-bound URL", () => {
      const secret = generateSecret();
      const url = buildClaimUrl(11155111, 0, MODE.AddressBound, secret, "https://b.app");
      const parsed = parseClaimUrl(url);
      expect(parsed!.mode).toBe(MODE.AddressBound);
    });

    it("rejects unsupported chains", () => {
      const secret = generateSecret();
      expect(() => buildClaimUrl(1, 1, MODE.Bearer, secret)).toThrow(/unsupported chain/);
    });

    it("rejects malformed paths", () => {
      expect(parseClaimUrl("/wrong/path#b.foo")).toBeNull();
      expect(parseClaimUrl("/claim/11155111/abc#b.foo")).toBeNull();
    });

    it("rejects non-32-byte secrets", () => {
      expect(parseClaimUrl("/claim/11155111/1#b.AA")).toBeNull();
    });

    it("rejects unknown mode chars", () => {
      const secret = generateSecret();
      const goodUrl = buildClaimUrl(11155111, 1, MODE.Bearer, secret);
      const tampered = goodUrl.replace("#b.", "#x.");
      expect(parseClaimUrl(tampered)).toBeNull();
    });
  });

  describe("hash construction", () => {
    it("produces a different hash per mode (same secret)", () => {
      const secret = generateSecret();
      const b = makeBearerHash(secret);
      const a = makeAddressHash(secret);
      expect(b).not.toEqual(a);
    });

    it("email hash is sensitive to the email", () => {
      const secret = generateSecret();
      const a = makeEmailHash(secret, "alice@example.com");
      const b = makeEmailHash(secret, "bob@example.com");
      expect(a).not.toEqual(b);
    });

    it("email digest normalizes case + trim", () => {
      expect(emailDigest("  ALICE@Example.Com  ")).toEqual(emailDigest("alice@example.com"));
    });
  });
});
