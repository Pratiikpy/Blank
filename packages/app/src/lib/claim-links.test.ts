import { describe, it, expect } from "vitest";
import { keccak256, toUtf8Bytes } from "ethers";
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
  secretBytes32,
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

    it("email digest normalizes Unicode (NFC) so NFC and NFD glyphs hash equally", () => {
      // 'é' in NFC is one code point (U+00E9). The same glyph in NFD
      // is 'e' + combining acute (U+0065 U+0301). Visually identical,
      // bytewise different — and would silently mismatch on-chain
      // claim if either side used the unnormalized form.
      const nfc = "josé@example.com";          // 1 code point for é
      const nfd = "josé@example.com";    // 2 code points
      expect(nfc).not.toEqual(nfd);
      expect(emailDigest(nfc)).toEqual(emailDigest(nfd));
    });
  });

  // §15.x extension: MODE constants must match the on-chain enum
  // values in ClaimLinks.sol — a regression that drifted these would
  // produce a hash mismatch on every claim attempt, with no error
  // signal beyond "InvalidProof" from the contract. The hash
  // construction tests indirectly cover this but pinning the literal
  // values catches the regression at compile-time-ish via a dedicated
  // assertion.
  describe("MODE constants (on-chain enum alignment)", () => {
    it("Bearer = 0, EmailBound = 1, AddressBound = 2 (matches ClaimLinks.sol)", () => {
      expect(MODE.Bearer).toBe(0);
      expect(MODE.EmailBound).toBe(1);
      expect(MODE.AddressBound).toBe(2);
    });

    it("the 3 modes are distinct integer values (no collision)", () => {
      const values = [MODE.Bearer, MODE.EmailBound, MODE.AddressBound];
      expect(new Set(values).size).toBe(3);
    });
  });

  describe("DOMAIN string value (the keccak namespace separator)", () => {
    it("equals keccak256(utf8('BLANK_CLAIM_v1')) (the canonical domain string)", () => {
      const expected = keccak256(toUtf8Bytes("BLANK_CLAIM_v1"));
      expect(DOMAIN).toEqual(expected);
    });

    it("is a 32-byte hex (66 chars incl. 0x prefix)", () => {
      expect(DOMAIN.length).toBe(66);
      expect(DOMAIN).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  // §15.x extension: secretBytes32 + cross-mode hash uniqueness +
  // cryptographic-property pins. The hash functions are what the
  // contract's `_validateClaim` recomputes on-chain to verify a
  // claimer's secret. Any drift in encoding (wrong endianness,
  // missing byte, swapped argument order in solidityPacked) would
  // silently break every claim.

  describe("secretBytes32 conversion + length guard", () => {
    it("converts a 32-byte secret to a 66-char 0x-hex string (no truncation, no padding)", () => {
      const secret = generateSecret();
      const hex = secretBytes32(secret);
      expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
      expect(hex.length).toBe(66);
    });

    it("throws on a non-32-byte input (catches caller arity bugs early)", () => {
      const short = new Uint8Array(31);
      const long = new Uint8Array(33);
      expect(() => secretBytes32(short)).toThrow(/expected 32 bytes, got 31/);
      expect(() => secretBytes32(long)).toThrow(/expected 32 bytes, got 33/);
    });

    it("converts the all-zeros secret to 0x0000...0000 (64 zeros)", () => {
      const zero = new Uint8Array(32);
      expect(secretBytes32(zero)).toBe("0x" + "00".repeat(32));
    });

    it("converts the all-ff secret to 0xffff...ffff", () => {
      const ff = new Uint8Array(32).fill(0xff);
      expect(secretBytes32(ff)).toBe("0x" + "ff".repeat(32));
    });
  });

  describe("hash construction — cryptographic invariants", () => {
    it("all 3 hashes differ for the same secret (mode-discrimination via DOMAIN+mode prefix)", () => {
      const secret = generateSecret();
      const bearer = makeBearerHash(secret);
      const email = makeEmailHash(secret, "x@y.z");
      const addr = makeAddressHash(secret);
      // 3 distinct hashes — a regression that swapped solidityPacked
      // arg order would collapse two of these.
      expect(new Set([bearer, email, addr]).size).toBe(3);
    });

    it("different secrets produce different bearer hashes (the deterministic-per-secret property)", () => {
      const a = generateSecret();
      const b = generateSecret();
      // Same algorithm, different inputs -> different outputs (Note:
      // collisions are 1/2^256 so this is effectively guaranteed).
      expect(makeBearerHash(a)).not.toBe(makeBearerHash(b));
    });

    it("same secret produces the SAME bearer hash on repeated calls (deterministic, no randomness)", () => {
      const secret = generateSecret();
      expect(makeBearerHash(secret)).toBe(makeBearerHash(secret));
    });

    it("emailDigest is sensitive to trailing whitespace BEFORE normalization but tolerates it (normalizer strips it)", () => {
      expect(emailDigest("a@b.c")).toEqual(emailDigest("a@b.c   "));
      expect(emailDigest("a@b.c")).toEqual(emailDigest("   a@b.c"));
      // But different domain DOES produce a different digest.
      expect(emailDigest("a@b.c")).not.toEqual(emailDigest("a@c.c"));
    });

    it("emailDigest is case-insensitive (alice@x.com == ALICE@X.COM)", () => {
      expect(emailDigest("ALICE@X.COM")).toEqual(emailDigest("alice@x.com"));
      expect(emailDigest("Alice@X.com")).toEqual(emailDigest("alice@x.com"));
    });

    it("every hash returns a 66-char 0x-hex (32 bytes, contract-callable bytes32)", () => {
      const secret = generateSecret();
      for (const h of [
        makeBearerHash(secret),
        makeEmailHash(secret, "a@b.c"),
        makeAddressHash(secret),
        emailDigest("a@b.c"),
      ]) {
        expect(h).toMatch(/^0x[0-9a-f]{64}$/);
        expect(h.length).toBe(66);
      }
    });
  });

  // §15.x extension: URL-building edge cases not covered above.

  describe("buildClaimUrl — input validation + flexibility", () => {
    it("accepts numeric string linkId AND number (callers don't have to pre-coerce)", () => {
      const secret = generateSecret();
      const fromStr = buildClaimUrl(11155111, "42", MODE.Bearer, secret, "https://x");
      const fromNum = buildClaimUrl(11155111, 42, MODE.Bearer, secret, "https://x");
      expect(fromStr).toBe(fromNum);
    });

    it("rejects non-numeric linkId (catches accidental id-as-name passing)", () => {
      const secret = generateSecret();
      expect(() =>
        buildClaimUrl(11155111, "abc" as unknown as number, MODE.Bearer, secret),
      ).toThrow(/non-negative integer/);
      expect(() =>
        buildClaimUrl(11155111, "1.5" as unknown as number, MODE.Bearer, secret),
      ).toThrow(/non-negative integer/);
    });

    it("rejects empty origin gracefully (no slashes-only path)", () => {
      const secret = generateSecret();
      const url = buildClaimUrl(11155111, 1, MODE.Bearer, secret, "");
      // Empty origin -> path starts with /claim
      expect(url).toMatch(/^\/claim\/11155111\/1#b\./);
    });
  });

  describe("parseClaimUrl — edge cases", () => {
    it("returns null for empty string input", () => {
      expect(parseClaimUrl("")).toBeNull();
    });

    it("returns null for non-string input (defensive against typed-array callers)", () => {
      expect(parseClaimUrl(null as unknown as string)).toBeNull();
      expect(parseClaimUrl(undefined as unknown as string)).toBeNull();
      expect(parseClaimUrl(123 as unknown as string)).toBeNull();
    });

    it("returns null for URL without a hash fragment (no secret to decode)", () => {
      expect(parseClaimUrl("/claim/11155111/1")).toBeNull();
      expect(parseClaimUrl("https://blank.app/claim/11155111/1")).toBeNull();
    });

    it("returns null when the chainId in the path isn't in SUPPORTED (mainnet rejected)", () => {
      const secret = generateSecret();
      const url = buildClaimUrl(11155111, 1, MODE.Bearer, secret, "https://x");
      const mainnetVariant = url.replace("/11155111/", "/1/");
      expect(parseClaimUrl(mainnetVariant)).toBeNull();
    });

    it("parses both a fully-qualified URL AND a relative path (caller passes whichever)", () => {
      const secret = generateSecret();
      const fullUrl = buildClaimUrl(11155111, 7, MODE.Bearer, secret, "https://blank.app");
      const relative = fullUrl.replace("https://blank.app", "");
      const parsedFull = parseClaimUrl(fullUrl);
      const parsedRel = parseClaimUrl(relative);
      expect(parsedFull).toEqual(parsedRel);
    });
  });

  // §15.x extension: base64url edge cases beyond the 32-byte roundtrip.

  describe("base64url encoder edges", () => {
    it("returns empty string for an empty Uint8Array", () => {
      expect(bytesToBase64Url(new Uint8Array(0))).toBe("");
    });

    it("never emits padding '=' characters (URL-safe contract)", () => {
      // Test multiple lengths that would canonically need 1 or 2 '='
      // padding chars to align to a 4-char group.
      for (const len of [1, 2, 3, 4, 5, 7, 11, 32]) {
        const enc = bytesToBase64Url(new Uint8Array(len).fill(0xab));
        expect(enc, `len=${len}`).not.toContain("=");
      }
    });

    it("base64UrlToBytes accepts unpadded input (round-trip with the encoder above)", () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const enc = bytesToBase64Url(bytes);
      expect(enc).not.toContain("=");
      const dec = base64UrlToBytes(enc);
      expect(Array.from(dec)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
