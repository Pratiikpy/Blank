// Magic claim links — secret generation, hash construction, URL helpers.
//
// URL format:  /claim/<chainId>/<linkId>#<modeChar>.<secretBase64url>
//   modeChar: "b" = Bearer, "e" = EmailBound, "a" = AddressBound
//
// The secret lives in the URL fragment ("#"), never in the query string,
// so it does not get sent to our CDN, our backend, or referer headers.
//
// v2 (current): the secret derives a one-time claim key. createLink stores
// only the key's address; the claimer proves possession by signing
// claimDigest(linkId, claimer), so the secret never reaches calldata.
//   Bearer, AddressBound: priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(mode), secret))
//   EmailBound:           priv = keccak256(abi.encodePacked("BLANK_CLAIM_KEY_v2", uint8(1), secret, emailHash))
//   claimKey = address(priv). The secret is regenerated if priv is 0 or >= n.
//   signature = EIP-191 personal_sign over the raw 32-byte claimDigest.
//
// v1 (legacy, pre-upgrade links) stored a secret hash:
//   DOMAIN = keccak256("BLANK_CLAIM_v1")
//   AddressBound: keccak256(DOMAIN, 0x02, secret)  (still claimable by the bound address)
//   Bearer / EmailBound legacy links are refund-only.

import { keccak256, toUtf8Bytes, hexlify, solidityPacked } from "ethers";
import {
  encodeAbiParameters,
  encodePacked,
  keccak256 as viemKeccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, ARB_SEPOLIA_ID } from "./constants";

const SUPPORTED: ReadonlySet<number> = new Set([ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, ARB_SEPOLIA_ID]);

export const DOMAIN = keccak256(toUtf8Bytes("BLANK_CLAIM_v1"));

export const MODE = {
  Bearer: 0,
  EmailBound: 1,
  AddressBound: 2,
} as const;

export type LinkMode = typeof MODE[keyof typeof MODE];

const MODE_CHAR: Record<LinkMode, string> = {
  [MODE.Bearer]: "b",
  [MODE.EmailBound]: "e",
  [MODE.AddressBound]: "a",
};

const CHAR_TO_MODE: Record<string, LinkMode> = {
  b: MODE.Bearer,
  e: MODE.EmailBound,
  a: MODE.AddressBound,
};

// ─── Secret generation ───────────────────────────────────────────────

/** 32-byte cryptographically random secret. */
export function generateSecret(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

/** base64url with no padding — URL-safe and compact. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Convert a 32-byte secret to a 0x-prefixed bytes32 string for contract calls. */
export function secretBytes32(secret: Uint8Array): `0x${string}` {
  if (secret.length !== 32) {
    throw new Error(`secretBytes32: expected 32 bytes, got ${secret.length}`);
  }
  return hexlify(secret) as `0x${string}`;
}

// ─── Hash construction (must match ClaimLinks.sol) ───────────────────

export function makeBearerHash(secret: Uint8Array): `0x${string}` {
  const packed = solidityPacked(
    ["bytes32", "uint8", "bytes32"],
    [DOMAIN, MODE.Bearer, secretBytes32(secret)],
  );
  return keccak256(packed) as `0x${string}`;
}

/** keccak256(NFC(lowercase(email))). Computed entirely client-side.
 *  NFC normalization closes a corner case where the sender enters
 *  `JOSÉ@example.com` (precomposed, e.g. macOS pasteboard) and the
 *  recipient pastes the same glyph from a Linux input source that
 *  produced NFD bytes. Same visible string, different keccak256 →
 *  the contract's hash-compare rejects the legitimate claim.
 *  Most real emails are ASCII so this is the rare-but-real edge.
 */
export function emailDigest(email: string): `0x${string}` {
  return keccak256(toUtf8Bytes(email.trim().toLowerCase().normalize("NFC"))) as `0x${string}`;
}

export function makeEmailHash(secret: Uint8Array, email: string): `0x${string}` {
  const packed = solidityPacked(
    ["bytes32", "uint8", "bytes32", "bytes32"],
    [DOMAIN, MODE.EmailBound, secretBytes32(secret), emailDigest(email)],
  );
  return keccak256(packed) as `0x${string}`;
}

export function makeAddressHash(secret: Uint8Array): `0x${string}` {
  const packed = solidityPacked(
    ["bytes32", "uint8", "bytes32"],
    [DOMAIN, MODE.AddressBound, secretBytes32(secret)],
  );
  return keccak256(packed) as `0x${string}`;
}

// ─── v2 claim keys (must match ClaimLinks.sol) ───────────────────────

export const CLAIM_KEY_DOMAIN = "BLANK_CLAIM_KEY_v2";
export const CLAIM_TYPEHASH = viemKeccak256(encodePacked(["string"], ["BLANK_CLAIM_v2"]));
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Claim-key private key for a secret, or null if it falls outside the
 *  valid secp256k1 range (caller regenerates the secret). EmailBound mixes
 *  the email digest in, so the key is useless without the email. */
export function deriveClaimKeyPriv(mode: LinkMode, secret: Uint8Array, email?: string): Hex | null {
  const secretHex = secretBytes32(secret);
  let priv: Hex;
  if (mode === MODE.EmailBound) {
    if (!email) throw new Error("Email is required for EmailBound links");
    priv = viemKeccak256(
      encodePacked(
        ["string", "uint8", "bytes32", "bytes32"],
        [CLAIM_KEY_DOMAIN, MODE.EmailBound, secretHex, emailDigest(email)],
      ),
    );
  } else {
    priv = viemKeccak256(encodePacked(["string", "uint8", "bytes32"], [CLAIM_KEY_DOMAIN, mode, secretHex]));
  }
  const n = BigInt(priv);
  if (n === 0n || n >= SECP256K1_N) return null;
  return priv;
}

/** Address of the claim key a secret derives (what createLink registers). */
export function claimKeyAddress(priv: Hex): Address {
  return privateKeyToAccount(priv).address;
}

/** Fresh secret plus its claim key. Retries until the key is valid. */
export function generateClaimKey(
  mode: LinkMode,
  email?: string,
): { secret: Uint8Array; priv: Hex; claimKey: Address } {
  for (let attempt = 0; attempt < 16; attempt++) {
    const secret = generateSecret();
    const priv = deriveClaimKeyPriv(mode, secret, email);
    if (priv) return { secret, priv, claimKey: claimKeyAddress(priv) };
  }
  throw new Error("Could not derive a claim key. Try again.");
}

/** Local mirror of ClaimLinks.claimDigest. The hook reads the on-chain view
 *  instead; this exists for tests and scripts. */
export function computeClaimDigest(
  linkId: bigint,
  claimer: Address,
  chainId: number,
  claimLinks: Address,
): Hex {
  return viemKeccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
      [CLAIM_TYPEHASH, linkId, claimer, BigInt(chainId), claimLinks],
    ),
  );
}

/** EIP-191 signature over the raw 32-byte digest, by the claim key. */
export function signClaimDigest(priv: Hex, digest: Hex): Promise<Hex> {
  return privateKeyToAccount(priv).signMessage({ message: { raw: digest } });
}

// ─── URL construction + parsing ──────────────────────────────────────

export interface ClaimLinkParts {
  chainId: number;
  linkId: number;
  mode: LinkMode;
  secret: Uint8Array;
}

export function buildClaimUrl(
  chainId: number,
  linkId: number | string,
  mode: LinkMode,
  secret: Uint8Array,
  origin: string = typeof window !== "undefined" ? window.location.origin : "",
): string {
  const id = String(linkId);
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`buildClaimUrl: linkId must be a non-negative integer, got ${id}`);
  }
  if (!SUPPORTED.has(chainId)) {
    throw new Error(`buildClaimUrl: unsupported chain ${chainId}`);
  }
  const fragment = `${MODE_CHAR[mode]}.${bytesToBase64Url(secret)}`;
  return `${origin}/claim/${chainId}/${id}#${fragment}`;
}

export function parseClaimUrl(input: string): ClaimLinkParts | null {
  if (typeof input !== "string" || input.length === 0) return null;
  let pathname: string;
  let hash: string;
  try {
    const u = new URL(input);
    pathname = u.pathname;
    hash = u.hash.startsWith("#") ? u.hash.slice(1) : u.hash;
  } catch {
    const hashIdx = input.indexOf("#");
    if (hashIdx === -1) return null;
    const path = input.slice(0, hashIdx);
    pathname = path.startsWith("/") ? path : `/${path}`;
    hash = input.slice(hashIdx + 1);
  }
  const m = pathname.match(/^\/claim\/(\d+)\/(\d+)\/?$/);
  if (!m) return null;
  const chainId = Number(m[1]);
  const linkId = Number(m[2]);
  if (!SUPPORTED.has(chainId)) return null;
  if (!Number.isSafeInteger(linkId) || linkId < 0) return null;

  const dot = hash.indexOf(".");
  if (dot < 1) return null;
  const modeChar = hash.slice(0, dot);
  const secretB64 = hash.slice(dot + 1);
  const mode = CHAR_TO_MODE[modeChar];
  if (mode === undefined) return null;
  let secret: Uint8Array;
  try {
    secret = base64UrlToBytes(secretB64);
  } catch {
    return null;
  }
  if (secret.length !== 32) return null;
  return { chainId, linkId, mode, secret };
}
